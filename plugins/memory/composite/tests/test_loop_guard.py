"""AC-PX5 #1/#2 fail-loud guards: seam fingerprint (static) + boot wiring assertion.

Covers the two earlier-stage tripwires from spec-loop-plugin-extraction §8:
  * #1 static fingerprint: all sentinels present -> ok; a removed/renamed one -> reported missing.
  * #2 boot assertion: a correctly-wired manager + live seams -> NO raise (the SAFETY GATE — a
    false positive would block the live desktop boot); a missing fan-out method or a missing
    sentinel -> LoopWiringError with a clear message.

The live-config-boots-clean proof (constructs the provider as build_provider does, under
HERMES_HOME, and asserts initialize() does not raise) lives in test_loop_boot_live.py.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from plugins.memory.composite.loop_guard import (
    CHASSIS_SEAM_FINGERPRINT,
    SEAM_SITES,
    LoopWiringError,
    assert_loop_wired,
    verify_seam_fingerprint,
)

_REPO_ROOT = Path(__file__).resolve().parents[4]  # .../hermes-agent


# ----- AC-PX5 #1: seam fingerprint (static) -----


def test_fingerprint_present_on_live_chassis():
    """All four sentinels resolve against the real checkout -> ok, nothing missing."""
    ok, missing = verify_seam_fingerprint()
    assert ok is True, f"live chassis missing loop seams: {missing}"
    assert missing == []
    assert CHASSIS_SEAM_FINGERPRINT == set(SEAM_SITES.keys())


def _copy_chassis_seam_files(dst: Path) -> None:
    """Copy the seam files (preserving repo-relative layout) into a temp root."""
    for rel in set(SEAM_SITES.values()):
        src = _REPO_ROOT / rel
        out = dst / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, out)


def test_fingerprint_reports_removed_sentinel(tmp_path):
    """Strip ONE sentinel in a temp copy -> that id is reported missing, ok is False."""
    _copy_chassis_seam_files(tmp_path)
    target_rel = SEAM_SITES["delegation-recall"]
    target = tmp_path / target_rel
    text = target.read_text(encoding="utf-8")
    # Remove only the delegation-recall sentinel (rename it so the substring no longer matches).
    text = text.replace("# AIOS-LOOP-SEAM:delegation-recall", "# (sentinel removed by refactor)")
    target.write_text(text, encoding="utf-8")

    ok, missing = verify_seam_fingerprint(repo_root=tmp_path)
    assert ok is False
    assert "delegation-recall" in missing
    # The other three (incl. delegation-confirm in the same file) still resolve.
    assert "delegation-confirm" not in missing
    assert "background-review-write" not in missing
    assert "injection-confirm" not in missing


def test_fingerprint_missing_file_counts_as_missing(tmp_path):
    """An absent seam file -> its sentinel id(s) are reported missing (not a crash)."""
    # Empty temp root: no files copied at all.
    ok, missing = verify_seam_fingerprint(repo_root=tmp_path)
    assert ok is False
    assert set(missing) == set(CHASSIS_SEAM_FINGERPRINT)


# ----- AC-PX5 #2: boot wiring assertion -----


class _GoodManager:
    """A manager exposing all three fan-out dispatch methods (the wired chassis)."""

    def on_background_review(self, *a, **k):  # pragma: no cover - presence only
        return 0

    def recall_for_delegation(self, *a, **k):  # pragma: no cover - presence only
        return ("", None)

    def confirm_consumed(self, *a, **k):  # pragma: no cover - presence only
        return None


def test_boot_assertion_passes_when_wired():
    """A complete manager + live seams -> NO raise (the safety gate)."""
    assert_loop_wired(_GoodManager())  # must not raise


def test_boot_assertion_raises_on_missing_fanout_method():
    """A manager missing a fan-out method -> LoopWiringError naming the method."""

    class _Half:
        def on_background_review(self, *a, **k):
            return 0

        # recall_for_delegation + confirm_consumed deliberately absent.

    with pytest.raises(LoopWiringError) as exc:
        assert_loop_wired(_Half())
    msg = str(exc.value)
    assert "recall_for_delegation" in msg
    assert "confirm_consumed" in msg


def test_boot_assertion_raises_on_missing_sentinel(tmp_path):
    """A wired manager but a moved seam sentinel -> LoopWiringError naming the seam."""
    _copy_chassis_seam_files(tmp_path)
    target = tmp_path / SEAM_SITES["background-review-write"]
    text = target.read_text(encoding="utf-8")
    text = text.replace(
        "# AIOS-LOOP-SEAM:background-review-write", "# (relocated by god-file refactor)"
    )
    target.write_text(text, encoding="utf-8")

    with pytest.raises(LoopWiringError) as exc:
        assert_loop_wired(_GoodManager(), repo_root=tmp_path)
    assert "background-review-write" in str(exc.value)
