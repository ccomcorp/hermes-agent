"""Shared test fixtures and helpers for engineering loop tests."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add the hermes-agent root to sys.path so we can import plugins
HERMES_AGENT_ROOT = Path(__file__).resolve().parents[3]
if str(HERMES_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(HERMES_AGENT_ROOT))


@pytest.fixture
def temp_project(tmp_path: Path) -> Path:
    """Create a temporary project directory with a .git repo."""
    project = tmp_path / "test-project"
    project.mkdir()
    # Create a minimal project structure
    (project / "src").mkdir()
    (project / "tests").mkdir()
    (project / "pyproject.toml").write_text(
        "[tool.pytest.ini_options]\n"
        'testpaths = ["tests"]\n'
    )
    # Initialize git
    import subprocess
    subprocess.run(["git", "init"], cwd=str(project), capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@test.com"],
        cwd=str(project), capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=str(project), capture_output=True,
    )
    return project


@pytest.fixture
def state_manager(temp_project: Path):
    """Create a StateManager pointing at a temp project."""
    from plugins.engineering_loop.state import StateManager
    return StateManager(temp_project)


@pytest.fixture
def sample_state():
    """Return a minimal EngineeringRunState for testing."""
    from plugins.engineering_loop.schemas import EngineeringRunState
    return EngineeringRunState(
        goal="Write a unit test for the harness",
        loop_type="deterministic",
        acceptance_criteria=["Test passes", "No lint errors"],
    )


@pytest.fixture
def sample_gate_result():
    """Return a passing GateResult."""
    from plugins.engineering_loop.schemas import GateResult
    return GateResult(
        gate_name="unit",
        command="pytest tests/ -q",
        exit_code=0,
        passed=True,
        duration_seconds=2.5,
    )
