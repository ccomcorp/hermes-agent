"""Safe commit workflow.

Commits changes only after gates pass, review passes, and safety checks clear.
Excludes logs, caches, build artifacts, and secrets from commits.
"""

from __future__ import annotations

import logging
import re
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Patterns for files/paths that must never be committed
_BLOCKED_PATTERNS = [
    r"\.env($|\.)",              # .env, .env.local, .env.production
    r"\.log($|\.\d)",            # log files
    r"\.pem$",                   # Private keys
    r"\.key$",                   # Key files
    r"credentials\.",            # Credential files
    r"secret",                   # Secret files
    r"__pycache__",
    r"\.pyc$",
    r"node_modules",
    r"\.cache",
    r"\.DS_Store",
    r"thumbs\.db",
]


def _get_staged_files(project_root: Path) -> Tuple[bool, List[str], str]:
    """Get the list of staged files (new/modified/renamed only).

    Returns (ok, file_list, error_reason).
    Uses ``git diff --cached --name-only --diff-filter=ACMR`` so only
    files that are actually staged for commit are inspected — not the
    entire dirty working tree.
    """
    try:
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False, [], "git not available or timed out"

    if result.returncode != 0:
        return False, [], f"git diff failed: {result.stderr.strip()[:200]}"

    files = [f.strip() for f in result.stdout.splitlines() if f.strip()]
    return True, files, ""


def is_safe_to_commit(project_root: Path) -> Tuple[bool, str]:
    """Check whether staged files are safe to commit.

    Returns (ok, reason).  ok is True when no dangerous files are staged
    *and* there is at least one staged file.
    """
    ok, staged, err = _get_staged_files(project_root)
    if not ok:
        return False, err

    dangerous: List[str] = []
    for filepath in staged:
        for pattern in _BLOCKED_PATTERNS:
            if re.search(pattern, filepath, re.IGNORECASE):
                dangerous.append(filepath)
                break

    if dangerous:
        return False, (
            f"Dangerous files staged for commit: {', '.join(dangerous[:5])}. "
            "Remove them from staging before committing."
        )

    if not staged:
        return False, "No staged changes to commit."

    return True, ""


def _is_blocked_path(filepath: str) -> bool:
    """Return True when a path must never be staged by the harness."""
    return any(
        re.search(pattern, filepath, re.IGNORECASE)
        for pattern in _BLOCKED_PATTERNS
    )


def stage_files_safely(project_root: Path, files: List[str]) -> Tuple[bool, str]:
    """Stage a caller-provided file list after applying safety filters."""
    unique_files = [f for f in dict.fromkeys(files) if f]
    if not unique_files:
        return False, "No changed files were provided for staging."

    blocked = [f for f in unique_files if _is_blocked_path(f)]
    if blocked:
        return False, f"Refusing to stage blocked files: {', '.join(blocked[:5])}."

    try:
        result = subprocess.run(
            ["git", "add", "--", *unique_files],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return False, "git add timed out"
    except Exception as exc:
        return False, str(exc)

    if result.returncode != 0:
        return False, result.stderr.strip()[:500] or "git add failed"

    return True, ""


def get_changed_files(project_root: Path) -> List[str]:
    """Get list of files changed in the working tree (staged + unstaged)."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=10,
        )
        if result.returncode == 0:
            return [f.strip() for f in result.stdout.splitlines() if f.strip()]
    except Exception:
        pass
    return []


def get_diff(project_root: Path) -> str:
    """Get the full diff of staged + unstaged changes."""
    try:
        result = subprocess.run(
            ["git", "diff", "HEAD"],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout
    except Exception:
        pass
    return ""


def commit(
    project_root: Path,
    message: str,
    author: str = "",
) -> Tuple[bool, str]:
    """Commit staged changes safely.

    Returns (success, message_or_error).
    """
    # Safety check
    safe, reason = is_safe_to_commit(project_root)
    if not safe:
        return False, reason

    # Ensure there are staged changes
    try:
        result = subprocess.run(
            ["git", "diff", "--cached", "--quiet"],
            capture_output=True,
            cwd=str(project_root),
            timeout=10,
        )
        if result.returncode == 0:
            return False, "No staged changes to commit."
    except Exception:
        return False, "git not available"

    # Commit
    try:
        cmd = ["git", "commit", "-m", message]
        if author:
            cmd.extend(["--author", author])

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=30,
        )

        if result.returncode == 0:
            # Get commit hash
            hash_result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                cwd=str(project_root),
                timeout=5,
            )
            commit_hash = hash_result.stdout.strip()[:12]
            return True, commit_hash
        else:
            return False, result.stderr.strip()[:500]

    except subprocess.TimeoutExpired:
        return False, "Commit timed out"
    except Exception as exc:
        return False, str(exc)


def get_commit_hash(project_root: Path) -> Optional[str]:
    """Get the current HEAD commit hash."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()[:12]
    except Exception:
        pass
    return None
