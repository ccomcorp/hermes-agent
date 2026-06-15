"""Gate discovery and execution.

Discovers verification gates from project conventions (pyproject.toml,
package.json, Makefile, justfile, CI configs, etc.) and provides wrappers
for executing them non-interactively with timeout and output capture.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .schemas import GateDefinition, GateResult

logger = logging.getLogger(__name__)

# Recognised project config files and their parsers
_PROJECT_FILES = [
    "pyproject.toml",
    "package.json",
    "Makefile",
    "justfile",
    "tox.ini",
    "pytest.ini",
    "setup.cfg",
    "noxfile.py",
    "Cargo.toml",
    "go.mod",
    "build.gradle",
    "build.gradle.kts",
    "pom.xml",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
]

# CI config files for gate discovery
_CI_DIRS = [
    ".github/workflows",
    ".gitlab-ci.yml",
    ".circleci/config.yml",
    "Jenkinsfile",
]


def discover_gates(project_root: Path) -> List[GateDefinition]:
    """Discover verification gates from project conventions.

    Inspects the project root for known config files and derives a gate
    plan based on what's found.  Returns gates in recommended execution
    order: format → lint → typecheck → unit → integration → build.
    """
    root = project_root.resolve()
    gates: List[GateDefinition] = []

    # Check which files exist
    has_pyproject = (root / "pyproject.toml").exists()
    has_package_json = (root / "package.json").exists()
    has_makefile = (root / "Makefile").exists()
    has_cargo = (root / "Cargo.toml").exists()
    has_gomod = (root / "go.mod").exists()

    if has_pyproject:
        gates.extend(_discover_python_gates(root))
    elif has_package_json:
        gates.extend(_discover_node_gates(root))
    elif has_cargo:
        gates.extend(_discover_rust_gates(root))
    elif has_gomod:
        gates.extend(_discover_go_gates(root))

    if has_makefile:
        gates.extend(_discover_makefile_gates(root))

    # Fallback: generic gates for any project
    if not gates:
        gates.extend(_discover_generic_gates(root))

    return gates


def _discover_python_gates(root: Path) -> List[GateDefinition]:
    """Discover gates for Python projects."""
    gates: List[GateDefinition] = []
    cwd = str(root)

    pyproject = root / "pyproject.toml"
    has_pytest = False
    has_ruff = False
    has_mypy = False

    if pyproject.exists():
        content = pyproject.read_text("utf-8")

        # Detect tools from pyproject.toml
        if "ruff" in content:
            has_ruff = True
        if "mypy" in content or "mypy" in content.lower():
            has_mypy = True
        if "pytest" in content:
            has_pytest = True
        if "[tool.pytest" in content:
            has_pytest = True

    # Also check for config files
    if (root / ".ruff.toml").exists() or (root / "ruff.toml").exists():
        has_ruff = True
    if (root / "mypy.ini").exists() or (root / ".mypy.ini").exists():
        has_mypy = True
    if (root / "pytest.ini").exists() or (root / "conftest.py").exists():
        has_pytest = True

    if (root / "tests").exists() or any(
        f.name.startswith("test_") for f in root.glob("*.py")
    ):
        has_pytest = True

    if has_ruff:
        gates.append(GateDefinition(
            name="format",
            command="ruff format --check .",
            cwd=cwd,
            timeout=120,
            retry_policy="none",
            required=True,
        ))
        gates.append(GateDefinition(
            name="lint",
            command="ruff check .",
            cwd=cwd,
            timeout=120,
            retry_policy="none",
            required=True,
        ))

    if has_mypy:
        gates.append(GateDefinition(
            name="typecheck",
            command="mypy .",
            cwd=cwd,
            timeout=300,
            retry_policy="none",
            required=True,
        ))

    if has_pytest:
        gates.append(GateDefinition(
            name="unit",
            command="python -m pytest tests/ -x --timeout=60 -q",
            cwd=cwd,
            timeout=600,
            retry_policy="none",
            required=True,
            pass_pattern=r"(\d+) passed",
            fail_pattern=r"(\d+) failed|ERRORS",
        ))

    return gates


def _discover_node_gates(root: Path) -> List[GateDefinition]:
    """Discover gates for Node.js/TypeScript projects."""
    gates: List[GateDefinition] = []
    cwd = str(root)
    pkg = root / "package.json"

    if not pkg.exists():
        return gates

    try:
        import json
        data = json.loads(pkg.read_text("utf-8"))
        scripts = data.get("scripts", {})

        # Prefer existing npm scripts
        if "format" in scripts or "lint" in scripts:
            # Format gate
            format_cmd = None
            if "format" in scripts:
                format_cmd = "npm run format -- --check" if "prettier" in str(scripts.get("format", "")) else "npm run format"
            elif "lint" in scripts and "eslint" in str(scripts.get("lint", "")):
                format_cmd = "npm run lint"
            if format_cmd:
                gates.append(GateDefinition(
                    name="format",
                    command=format_cmd,
                    cwd=cwd,
                    timeout=120,
                    required=False,
                ))

        # Typecheck for TypeScript
        if "typecheck" in scripts or "tsc" in str(scripts):
            tsc_cmd = scripts.get("typecheck", scripts.get("build", "npx tsc --noEmit"))
            gates.append(GateDefinition(
                name="typecheck",
                command=f"npm run typecheck" if "typecheck" in scripts else "npx tsc --noEmit",
                cwd=cwd,
                timeout=300,
                required=True,
            ))

        # Test
        if "test" in scripts:
            gates.append(GateDefinition(
                name="unit",
                command="npm test -- --ci --passWithNoTests",
                cwd=cwd,
                timeout=600,
                required=True,
            ))

        # Build
        if "build" in scripts:
            gates.append(GateDefinition(
                name="build",
                command="npm run build",
                cwd=cwd,
                timeout=600,
                required=False,
            ))

    except Exception:
        pass

    return gates


def _discover_rust_gates(root: Path) -> List[GateDefinition]:
    """Discover gates for Rust projects."""
    cwd = str(root)
    return [
        GateDefinition(name="format", command="cargo fmt --check", cwd=cwd, timeout=120, required=True),
        GateDefinition(name="lint", command="cargo clippy -- -D warnings", cwd=cwd, timeout=300, required=True),
        GateDefinition(name="unit", command="cargo test", cwd=cwd, timeout=600, required=True),
        GateDefinition(name="build", command="cargo build", cwd=cwd, timeout=600, required=False),
    ]


def _discover_go_gates(root: Path) -> List[GateDefinition]:
    """Discover gates for Go projects."""
    cwd = str(root)
    return [
        GateDefinition(name="format", command="gofmt -l .", cwd=cwd, timeout=60, required=True),
        GateDefinition(name="lint", command="golangci-lint run", cwd=cwd, timeout=300, required=False),
        GateDefinition(name="unit", command="go test ./...", cwd=cwd, timeout=600, required=True),
        GateDefinition(name="build", command="go build ./...", cwd=cwd, timeout=300, required=False),
    ]


def _discover_makefile_gates(root: Path) -> List[GateDefinition]:
    """Discover gates from Makefile targets."""
    gates: List[GateDefinition] = []
    cwd = str(root)
    makefile = root / "Makefile"

    if not makefile.exists():
        return gates

    content = makefile.read_text("utf-8")
    # Look for common target names
    common_targets = {
        "test": ("make test", "unit", True),
        "lint": ("make lint", "lint", True),
        "format": ("make format", "format", False),
        "typecheck": ("make typecheck", "typecheck", True),
        "build": ("make build", "build", False),
        "check": ("make check", "unit", True),
    }

    for target, (cmd, name, required) in common_targets.items():
        if re.search(rf"^{target}\s*:", content, re.MULTILINE):
            gates.append(GateDefinition(
                name=name,
                command=cmd,
                cwd=cwd,
                timeout=600 if "test" in name else 300,
                required=required,
            ))

    return gates


def _discover_generic_gates(root: Path) -> List[GateDefinition]:
    """Discover gates for projects without recognised tooling."""
    gates: List[GateDefinition] = []
    cwd = str(root)

    # Check for any test directory
    if (root / "tests").exists() or (root / "test").exists():
        # Try to figure out the test runner
        has_pytest = any(root.glob("*test*.py")) or (root / "conftest.py").exists()
        has_jest = (root / "jest.config.js").exists() or (root / "jest.config.ts").exists()

        if has_pytest:
            gates.append(GateDefinition(name="unit", command="python -m pytest tests/ -q", cwd=cwd, timeout=600, required=True))
        elif has_jest:
            gates.append(GateDefinition(name="unit", command="npx jest --ci", cwd=cwd, timeout=600, required=True))

    return gates


# ── Gate execution ─────────────────────────────────────────────────────────

# Metacharacters that are never legitimate in gate commands built from
# project tooling.  Shell injection through `shell=True` is a latent risk
# when commands are derived from repo config files.
_DANGEROUS_SHELL_CHARS = re.compile(
    r"[;&|`$(){}\[\]<>\\\n\r]"
)


def _validate_command(command: str) -> Tuple[bool, str]:
    """Validate a gate command against shell injection.

    Returns (ok, reason).  Rejects commands containing shell metacharacters
    that are not part of a normal build/lint/test invocation.
    """
    if not command or not command.strip():
        return False, "Empty command"

    # Shell metacharacter check
    dangerous = _DANGEROUS_SHELL_CHARS.findall(command)
    if dangerous:
        return False, (
            f"Command contains forbidden shell characters: "
            f"{', '.join(repr(c) for c in set(dangerous))}"
        )

    # Reject commands that try to chain with newlines
    if "\n" in command:
        return False, "Command contains newline"

    return True, ""


def execute_gate(
    gate: GateDefinition,
    log_dir: Path,
    test_only: bool = False,
) -> GateResult:
    """Execute a single gate and return the result.

    Commands run non-interactively with CI=true and explicit timeout.
    Output is captured to log files.
    """
    start = time.time()
    log_path = log_dir / f"{gate.name}.log" if log_dir else None

    # Validate command before execution
    ok, err_reason = _validate_command(gate.command)
    if not ok:
        duration = time.time() - start
        return GateResult(
            gate_name=gate.name,
            command=gate.command,
            exit_code=-1,
            passed=False,
            duration_seconds=duration,
            error=f"Command validation failed: {err_reason}",
            executed_at=start,
        )

    # Build environment with CI=true
    env = os.environ.copy()
    env["CI"] = "true"
    env.update(gate.env)

    try:
        result = subprocess.run(
            gate.command,
            shell=True,
            cwd=gate.cwd,
            capture_output=True,
            text=True,
            timeout=gate.timeout,
            env=env,
        )

        duration = time.time() - start
        passed = result.returncode == 0

        # Check pass/fail patterns if exit code is ambiguous
        if not passed and gate.pass_pattern:
            if re.search(gate.pass_pattern, result.stdout):
                passed = True
        if passed and gate.fail_pattern:
            if re.search(gate.fail_pattern, result.stdout + result.stderr):
                passed = False

        # Save full logs
        if log_path:
            log_path.write_text(
                f"COMMAND: {gate.command}\n"
                f"CWD: {gate.cwd}\n"
                f"EXIT: {result.returncode}\n"
                f"DURATION: {duration:.1f}s\n"
                f"PASSED: {passed}\n\n"
                f"--- STDOUT ---\n{result.stdout}\n\n"
                f"--- STDERR ---\n{result.stderr}\n",
                "utf-8",
            )

        return GateResult(
            gate_name=gate.name,
            command=gate.command,
            exit_code=result.returncode,
            passed=passed,
            duration_seconds=duration,
            stdout_snippet=result.stdout[-1000:] if result.stdout else "",
            stderr_snippet=result.stderr[-1000:] if result.stderr else "",
            log_path=str(log_path) if log_path else "",
            executed_at=start,
        )

    except subprocess.TimeoutExpired:
        duration = time.time() - start
        msg = f"TIMEOUT after {gate.timeout}s"
        if log_path:
            log_path.write_text(f"COMMAND: {gate.command}\n{msg}\n", "utf-8")

        return GateResult(
            gate_name=gate.name,
            command=gate.command,
            exit_code=-1,
            passed=False,
            duration_seconds=duration,
            error=msg,
            log_path=str(log_path) if log_path else "",
            executed_at=start,
        )


def execute_gates(
    gates: List[GateDefinition],
    log_dir: Path,
    stop_on_failure: bool = True,
) -> List[GateResult]:
    """Execute a list of gates in order.  Stops on first required failure if
    stop_on_failure is True."""
    results: List[GateResult] = []
    for gate in gates:
        result = execute_gate(gate, log_dir)
        results.append(result)
        if stop_on_failure and not result.passed and gate.required:
            logger.info(
                "Gate '%s' failed (required). Stopping gate pipeline.",
                gate.name,
            )
            break
    return results
