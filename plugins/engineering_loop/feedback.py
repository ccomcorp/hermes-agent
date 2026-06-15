"""Failure classification, feedback parsing, and stuck detection.

Parses command output (pytest, npm, tsc, build tools), classifies failures,
fingerprints them for dedup, and detects when the agent is stuck in a loop.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import List, Optional

from .schemas import FailureClass, FailureRecord, FeedbackRecord

logger = logging.getLogger(__name__)

# ── Failure patterns ───────────────────────────────────────────────────────

# (regex, FailureClass) — ordered.  First match wins.
_FAILURE_PATTERNS = [
    # pytest / unittest failures
    (r"FAILED\s+((?:tests?[/\\][^\s]+)::[^\s]+)", FailureClass.UNIT_TEST),
    (r"ERRORS\s+((?:tests?[/\\][^\s]+)::[^\s]+)", FailureClass.UNIT_TEST),
    (
        r"(?:assert|AssertionError|assertEqual|assertTrue|assertFalse|assertRaises)",
        FailureClass.UNIT_TEST,
    ),
    (r"E\s+((?:tests?[/\\][^\s]+)::[^\s]+)", FailureClass.UNIT_TEST),
    (r"FAILED.*integration", FailureClass.INTEGRATION_TEST),
    (r"FAILED.*e2e", FailureClass.E2E_TEST),
    # Lint / format
    (r"(?:ruff|flake8|pylint|eslint|prettier)\s+(?:failed|error|check)", FailureClass.LINT),
    (r"would reformat", FailureClass.LINT),  # black / ruff format
    # Typecheck
    (r"(?:mypy|tsc|pyright|pytype).*error", FailureClass.TYPECHECK),
    (r"TypeError.*not assignable", FailureClass.TYPECHECK),
    # Build / compile
    (r"error\s+MSB\d{4}", FailureClass.COMPILE_SYNTAX),          # MSBuild
    (r"(?:SyntaxError|IndentationError|NameError)", FailureClass.COMPILE_SYNTAX),
    (r"(?:cargo|go build|npm run build).*failed", FailureClass.COMPILE_SYNTAX),
    (r"(?:npm ERR!|yarn error|pnpm ERR!)", FailureClass.DEPENDENCY),
    (r"(?:poetry|pip|uv).*error.*install", FailureClass.DEPENDENCY),
    # Permission
    (r"(?:Permission denied|EACCES|Access is denied)", FailureClass.PERMISSION),
    # Network / transient
    (
        r"(?:connection refused|Connection reset|timed out|Temporary failure)",
        FailureClass.TRANSIENT,
    ),
    (r"(?:rate limit|429|too many requests)", FailureClass.TRANSIENT),
    # Missing info
    (r"(?:No such file|FileNotFoundError|cannot find)", FailureClass.MISSING_INFORMATION),
    (r"(?:ModuleNotFoundError|ImportError)", FailureClass.DEPENDENCY),
    (r"(?:command not found|is not recognized)", FailureClass.SETUP_ENVIRONMENT),
]


def classify_failure(
    stdout: str, stderr: str, exit_code: int
) -> FailureClass:
    """Classify a failure from command output and exit code.

    Returns FailureClass.UNKNOWN if no pattern matches.
    """
    if exit_code == 0:
        return FailureClass.UNKNOWN  # Not a failure

    combined = f"{stdout}\n{stderr}"
    for pattern, fc in _FAILURE_PATTERNS:
        if re.search(pattern, combined, re.IGNORECASE | re.MULTILINE):
            return fc
    return FailureClass.UNKNOWN


def extract_failed_test(stdout: str) -> Optional[str]:
    """Extract the name of a failing test from pytest output."""
    m = re.search(
        r"FAILED\s+((?:tests?[/\\][^\s]+)::([^\s]+))",
        stdout,
    )
    if m:
        return m.group(1)
    # Also try unittest-style
    m = re.search(r"FAIL:\s+(\S+)", stdout)
    if m:
        return m.group(1)
    return None


def fingerprint_failure(
    failure_class: FailureClass,
    command: str,
    message: str,
) -> str:
    """Create a stable fingerprint for deduplicating failures.

    Normalizes paths, timestamps, and variable data so the same logical
    failure produces the same fingerprint.
    """
    # Normalize paths: strip Windows/Unix paths
    normalized = re.sub(r"[A-Z]:[/\\][^\s]*", "<path>", message)
    normalized = re.sub(r"(?:/[\w.-]+)+/[\w.-]+", "<path>", normalized)
    # Normalize timestamps
    normalized = re.sub(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}", "<ts>", normalized)
    # Normalize line numbers
    normalized = re.sub(r":\d+:", ":<line>:", normalized)
    # Normalize hex codes
    normalized = re.sub(r"0x[0-9a-fA-F]+", "<hex>", normalized)

    key = f"{failure_class.value}|{command[:100]}|{normalized[:300]}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def parse_command_feedback(
    command: str,
    cwd: str,
    exit_code: int,
    stdout: str,
    stderr: str,
    start_time: float,
    end_time: float,
    timeout: bool = False,
    log_path: str = "",
) -> FeedbackRecord:
    """Parse raw command output into a structured FeedbackRecord."""
    failure_class = None
    root_cause = ""
    if exit_code != 0 or timeout:
        fc = classify_failure(stdout, stderr, exit_code)
        failure_class = fc.value
        root_cause = _extract_root_cause(stdout, stderr, fc)

    # Extract a relevant excerpt
    combined = stdout + "\n" + stderr
    if len(combined) > 2000:
        excerpt = combined[-2000:]
    else:
        excerpt = combined

    return FeedbackRecord(
        action_type="command",
        command=command,
        cwd=cwd,
        start_time=start_time,
        end_time=end_time,
        exit_code=exit_code,
        timeout=timeout,
        stdout_excerpt=excerpt[:1000],
        stderr_excerpt=stderr[:1000] if stderr.strip() else "",
        full_log_path=log_path,
        failure_class=failure_class,
        root_cause=root_cause,
    )


def _extract_root_cause(
    stdout: str, stderr: str, fc: FailureClass
) -> str:
    """Extract a human-readable root cause from output."""
    combined = f"{stdout}\n{stderr}"

    if fc == FailureClass.UNIT_TEST:
        # Find the assertion line
        for line in reversed(combined.splitlines()):
            if "AssertionError" in line or "assert" in line:
                return line.strip()[:200]
        return "Test assertion failed"

    if fc == FailureClass.LINT:
        for line in combined.splitlines():
            if "error" in line.lower() or "would reformat" in line.lower():
                return line.strip()[:200]
        return "Lint check failed"

    if fc == FailureClass.TYPECHECK:
        for line in combined.splitlines():
            if "error" in line.lower():
                return line.strip()[:200]
        return "Type check failed"

    if fc == FailureClass.DEPENDENCY:
        for line in combined.splitlines():
            if "ERR!" in line or "error" in line.lower():
                return line.strip()[:200]
        return "Dependency installation failed"

    if fc == FailureClass.PERMISSION:
        return "Permission denied"

    if fc == FailureClass.TRANSIENT:
        return "Transient error (network, rate limit, timeout)"

    # Generic: return last error-looking line
    for line in reversed(combined.splitlines()):
        if "error" in line.lower() or "fail" in line.lower():
            return line.strip()[:200]
    return f"Exit code {fc.value}" if hasattr(fc, "value") else str(fc)


# ── Stuck Detection ───────────────────────────────────────────────────────


def is_stuck(failures: List[FailureRecord], threshold: int = 3) -> bool:
    """Detect if the agent is stuck in a failure loop.

    Returns True when the same failure fingerprint has occurred >= threshold
    times with no intervening success.
    """
    if len(failures) < threshold:
        return False

    # Check the last N failures for identical fingerprints
    recent = failures[-threshold:]
    fingerprints = [f.fingerprint for f in recent]
    return len(set(fingerprints)) == 1


def detect_stuck_signal(
    failures: List[FailureRecord],
    changed_files: List[str],
) -> Optional[str]:
    """Return a stuck signal string if thrashing is detected, or None.

    Checks multiple stuck signals:
    - Same failure repeated 3+ times
    - Files cycling (same files edited over and over)
    - No new evidence being generated
    """
    if is_stuck(failures, threshold=3):
        fp = failures[-1].fingerprint
        msg = failures[-1].message[:100]
        return (
            f"STUCK: Same failure repeated {len([f for f in failures if f.fingerprint == fp])} "
            f"times. Last: {msg}. Try a different strategy."
        )

    # Check for edit cycling: same file edited many times without success
    if changed_files and len(changed_files) >= 3:
        # If all edits are to the same 1-2 files, might be cycling
        from collections import Counter
        recent = changed_files[-10:] if len(changed_files) > 10 else changed_files
        counts = Counter(recent)
        most_common_count = counts.most_common(1)[0][1] if counts else 0
        if most_common_count >= 5 and len(failures) >= 5:
            return (
                f"STUCK: File {counts.most_common(1)[0][0]} edited "
                f"{most_common_count} times with 5+ failures. "
                "Inspect more context before editing again."
            )

    return None
