"""Unit + integration tests for the check-update-need.py drift probe (SPEC-6).

The script lives at a hyphenated path under hermes-home, so it is not
importable as a normal module. We load it by file path with importlib.

Constraints:
- No git / subprocess / network is invoked here. The integration test
  monkeypatches the module's ``run()`` wrapper to feed fixed drift counts.
- No dependency on console encoding of the checkmark/warning glyphs the
  script prints (we only assert on exit codes and JSON payloads).
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

# Path to the target script (hyphenated filename -> load by path).
SCRIPT_PATH = Path(
    r"I:\PROJECTS\AIOS\hermes-home\skills\devops"
    r"\hermes-fork-maintenance\scripts\check-update-need.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "check_update_need", str(SCRIPT_PATH)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def cun():
    """The loaded check-update-need module."""
    assert SCRIPT_PATH.exists(), f"target script missing: {SCRIPT_PATH}"
    return _load_module()


# --------------------------------------------------------------------------
# classify_drift — the pure exit-code contract
# --------------------------------------------------------------------------

def test_classify_drift_fully_current(cun):
    # exit 0 = fully current
    assert cun.classify_drift(0, 0) == 0


def test_classify_drift_behind_origin_only(cun):
    # exit 1 = behind origin only (behind_upstream <= 0)
    assert cun.classify_drift(3, 0) == 1


def test_classify_drift_behind_upstream_only(cun):
    # exit 2 = behind upstream only
    assert cun.classify_drift(0, 5) == 2


def test_classify_drift_behind_both(cun):
    # exit 3 = behind both
    assert cun.classify_drift(2, 4) == 3


def test_classify_drift_negative_is_unknown(cun):
    # exit 5 = setup/unknown (negative == "could not determine")
    assert cun.classify_drift(-1, 0) == 5
    assert cun.classify_drift(0, -1) == 5
    assert cun.classify_drift(-1, -1) == 5


def test_classify_drift_behind_origin_with_unknown_upstream(cun):
    # behind_upstream == -1 (unknown) collapses to "behind origin only"
    # per the exact contract: behind_origin>0 AND behind_upstream<=0 -> 1
    assert cun.classify_drift(4, -1) == 5  # negative upstream is unknown -> 5


# --------------------------------------------------------------------------
# build_notify_payload — shape of the alert JSON
# --------------------------------------------------------------------------

def test_build_notify_payload_keys_and_values(cun):
    payload = cun.build_notify_payload(
        behind_origin=2, behind_upstream=7, detected_at="2026-07-01T00:00:00+00:00"
    )
    assert set(payload.keys()) == {"detected_at", "behind_upstream", "behind_origin"}
    assert payload["behind_origin"] == 2
    assert payload["behind_upstream"] == 7
    assert payload["detected_at"] == "2026-07-01T00:00:00+00:00"


def test_build_notify_payload_is_json_serializable(cun):
    payload = cun.build_notify_payload(0, 0, "2026-07-01T00:00:00+00:00")
    # round-trips cleanly
    assert json.loads(json.dumps(payload)) == payload


# --------------------------------------------------------------------------
# main() integration — monkeypatch run() to feed fixed drift, assert exit code
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "behind_origin,behind_upstream,expected_code",
    [
        (0, 0, 0),
        (3, 0, 1),
        (0, 5, 2),
        (2, 4, 3),
    ],
)
def test_main_exits_with_drift_code(
    cun, monkeypatch, tmp_path, behind_origin, behind_upstream, expected_code
):
    """main() must call sys.exit(classify_drift(...)) after prints."""

    # Fake git wrapper: dispatch on the command to feed fixed counts.
    def fake_run(cmd, timeout=60):
        # cmd is a list like ["git", "rev-list", "--count", "HEAD..origin/aios"]
        joined = " ".join(cmd)
        if "HEAD..origin/aios" in joined:
            return (0, str(behind_origin), "")
        if "origin/aios..upstream/main" in joined:
            return (0, str(behind_upstream), "")
        if "upstream/main..origin/aios" in joined:
            return (0, "0", "")  # ahead_fork
        if "rev-parse --abbrev-ref HEAD" in joined:
            return (0, "aios", "")
        if "diff --name-only" in joined:
            return (0, "", "")  # no changed files
        if "grep -l" in joined:
            return (1, "", "")  # no seam files
        if "fetch" in joined:
            return (0, "", "")
        return (0, "", "")

    monkeypatch.setattr(cun, "run", fake_run)
    # Make the repo + git checks pass without touching the real filesystem.
    monkeypatch.setattr(cun.os.path, "isdir", lambda p: True)
    monkeypatch.setattr(cun.os.path, "exists", lambda p: True)

    with pytest.raises(SystemExit) as excinfo:
        cun.main([])  # no --notify

    assert excinfo.value.code == expected_code


def test_main_notify_writes_payload(cun, monkeypatch, tmp_path):
    """--notify writes upstream-drift.json to the alerts dir (redirected to tmp)."""

    def fake_run(cmd, timeout=60):
        joined = " ".join(cmd)
        if "HEAD..origin/aios" in joined:
            return (0, "0", "")
        if "origin/aios..upstream/main" in joined:
            return (0, "6", "")
        if "upstream/main..origin/aios" in joined:
            return (0, "0", "")
        if "rev-parse --abbrev-ref HEAD" in joined:
            return (0, "aios", "")
        if "diff --name-only" in joined:
            return (0, "loop.py\nseam.py", "")
        if "grep -l" in joined:
            return (0, "seam.py", "")
        if "fetch" in joined:
            return (0, "", "")
        return (0, "", "")

    monkeypatch.setattr(cun, "run", fake_run)
    monkeypatch.setattr(cun.os.path, "isdir", lambda p: True)
    monkeypatch.setattr(cun.os.path, "exists", lambda p: True)

    alert_file = tmp_path / "alerts" / "upstream-drift.json"
    monkeypatch.setattr(cun, "ALERT_FILE", str(alert_file))

    with pytest.raises(SystemExit) as excinfo:
        cun.main(["--notify"])

    # behind_origin==0, behind_upstream==6 -> exit 2
    assert excinfo.value.code == 2
    assert alert_file.exists()
    data = json.loads(alert_file.read_text(encoding="utf-8"))
    assert data["behind_upstream"] == 6
    assert data["behind_origin"] == 0
    assert "detected_at" in data
