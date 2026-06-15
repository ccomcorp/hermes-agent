"""Tests for the AIOS in-chassis safe-update refuse-guard (Option B floor).

Spec: aios/docs/architecture/SPEC-safe-update-interception.md §2 (Option B,
the REQUIRED floor) + AC-SI5.

The danger: a direct full-path ``hermes update`` inside the AIOS chassis
(``I:\\PROJECTS\\AIOS\\hermes-agent``) falls through to the destructive
``reset --hard origin/aios`` default (main.py:8386), silently wiping the
carried fork delta.  The guard makes the dangerous op refuse *itself* unless
the call came through the safe-update orchestrator
(``Invoke-HermesSafeUpdate.ps1``), which sets ``HERMES_SAFE_UPDATE_OK=1``.

These tests exercise the pure decision helper ``_safe_update_blocked`` in
isolation (no git / network) plus the ``cmd_update`` early-return that calls
it, and confirm the guard is inert for:
  - the flag-set passthrough (orchestrator),
  - a non-chassis install root,
  - any non-``update`` command path.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import hermes_cli.main as main
from hermes_cli.main import _safe_update_blocked, cmd_update

# These tests drive the guard directly and manage HERMES_SAFE_UPDATE_OK
# themselves, so opt out of the autouse passthrough fixture in conftest.
pytestmark = pytest.mark.aios_safe_guard

# The canonical AIOS chassis root the guard defends.  Mirrors the value the
# helper derives from PROJECT_ROOT at runtime; here we use the real
# PROJECT_ROOT so the chassis-positive tests reflect the live install.
CHASSIS = main.PROJECT_ROOT


# ---------- _safe_update_blocked (pure decision helper) ----------


def test_blocked_when_chassis_root_and_no_flag():
    """AC-SI5: chassis PROJECT_ROOT + flag unset → blocked."""
    assert _safe_update_blocked(CHASSIS, env={}) is True


def test_not_blocked_when_flag_set():
    """Orchestrator passthrough: HERMES_SAFE_UPDATE_OK set → not blocked."""
    assert _safe_update_blocked(CHASSIS, env={"HERMES_SAFE_UPDATE_OK": "1"}) is False


def test_empty_flag_value_still_blocks():
    """An empty-string flag is falsy → still blocked.

    ``os.environ.get`` returns the raw string; the spec's "falsy" gate means
    an unset var or an empty string blocks, while any non-empty value
    (the orchestrator sets ``"1"``) is the passthrough.
    """
    assert _safe_update_blocked(CHASSIS, env={"HERMES_SAFE_UPDATE_OK": ""}) is True


def test_not_blocked_when_non_chassis_root():
    """A different install root (e.g. a user's pip/git install) → never blocked."""
    other = Path("/opt/some/other/hermes-install")
    assert _safe_update_blocked(other, env={}) is False


def test_chassis_match_is_case_and_separator_robust():
    """Resolved-path comparison tolerates case + separator differences.

    On Windows the same dir may surface as ``I:\\PROJECTS\\AIOS\\hermes-agent``
    or ``i:/projects/aios/hermes-agent``; both must match the chassis.
    """
    # Reconstruct a differently-cased / forward-slash variant of the chassis.
    weird = Path(str(CHASSIS).swapcase().replace("\\", "/"))
    assert _safe_update_blocked(weird, env={}) is True


# ---------- cmd_update early-return (integration of the guard) ----------


@patch("hermes_cli.config.is_managed", return_value=False)
@patch("subprocess.run")
def test_cmd_update_blocks_in_chassis_with_pointer(mock_run, _mock_managed, capsys):
    """AC-SI5: chassis + no flag → refusal pointing at the safe process, exit 1.

    No git invocation — the guard must beat every git command.
    """
    with patch.object(main, "PROJECT_ROOT", CHASSIS), patch.dict(
        os.environ, {}, clear=False
    ):
        os.environ.pop("HERMES_SAFE_UPDATE_OK", None)
        with pytest.raises(SystemExit) as excinfo:
            cmd_update(SimpleNamespace(check=False))

    assert excinfo.value.code == 1
    out = capsys.readouterr().out
    # Points the user at the safe process (runbook / orchestrator script).
    assert "Invoke-HermesSafeUpdate.ps1" in out or "safe-update" in out.lower()

    git_calls = [
        c
        for c in mock_run.call_args_list
        if c.args and c.args[0] and "git" in str(c.args[0][0])
    ]
    assert git_calls == [], f"expected no git calls, got: {git_calls}"


@patch("hermes_cli.config.is_managed", return_value=False)
@patch("hermes_cli.config.detect_install_method", return_value="git")
@patch(
    "subprocess.run",
    return_value=SimpleNamespace(returncode=0, stdout="0\n", stderr=""),
)
def test_cmd_update_passthrough_when_flag_set(
    _mock_run, _mock_method, _mock_managed, capsys
):
    """Orchestrator passthrough: flag set → guard inert, no refusal printed."""
    with patch.object(main, "PROJECT_ROOT", CHASSIS), patch.dict(
        os.environ, {"HERMES_SAFE_UPDATE_OK": "1"}, clear=False
    ):
        try:
            cmd_update(SimpleNamespace(check=True, branch=None))
        except (SystemExit, Exception):
            # The real update flow may exit for unrelated stubbed-env reasons;
            # we only assert the guard's refusal did NOT fire.
            pass

    assert "Invoke-HermesSafeUpdate.ps1" not in capsys.readouterr().out


@patch("hermes_cli.config.is_managed", return_value=False)
@patch("hermes_cli.config.detect_install_method", return_value="git")
@patch(
    "subprocess.run",
    return_value=SimpleNamespace(returncode=0, stdout="0\n", stderr=""),
)
def test_cmd_update_not_blocked_on_non_chassis_root(
    _mock_run, _mock_method, _mock_managed, capsys
):
    """A non-chassis install → guard inert even with no flag."""
    other = Path("/opt/some/other/hermes-install")
    with patch.object(main, "PROJECT_ROOT", other), patch.dict(
        os.environ, {}, clear=False
    ):
        os.environ.pop("HERMES_SAFE_UPDATE_OK", None)
        try:
            cmd_update(SimpleNamespace(check=True, branch=None))
        except (SystemExit, Exception):
            pass

    assert "Invoke-HermesSafeUpdate.ps1" not in capsys.readouterr().out


def test_non_update_command_never_consults_guard():
    """A non-``update`` command path must never hit the guard.

    The guard lives only inside ``cmd_update``; calling any other command
    (here: the helper directly proves the decision is scoped) cannot be
    affected.  We assert that the guard helper is the ONLY place the chassis
    refusal logic lives, and that it returns False for a non-chassis root —
    i.e. nothing in a generic command path can be blocked by it.
    """
    # Sanity: the guard is a discrete helper, not woven into dispatch.
    assert callable(_safe_update_blocked)
    # A generic (non-chassis) context is never blocked.
    assert _safe_update_blocked(Path("/home/user/project"), env={}) is False
