"""M1 Task 2 BLOCKER #4 — the AC1 measurement harness, as a CI gate.

Imports the synthetic-week replay (single-sourced in ``scripts/synthetic_week_ac1.py``)
and pins the acceptance bar: fork-authored (migrated=False) lessons must circulate into
consumed recalls, migrated reads must NOT count, and misses must be recorded (never silent).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPTS = str(_REPO_ROOT / "scripts")
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

try:
    import synthetic_week_ac1 as harness  # noqa: E402

    _HAVE_AIOS = True
except Exception:  # pragma: no cover - environment-dependent (sibling AIOS repo absent)
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(
    not _HAVE_AIOS, reason="AIOS experience-store/composite/health packages not importable"
)


def test_synthetic_week_ac1_holds():
    """The end-to-end bar: zero AC1 violations from the replayed week."""
    result = harness.run_synthetic_week()
    failures = harness.check_ac1(result)
    assert failures == [], "AC1 violations: " + "; ".join(failures)


def test_circulation_excludes_migrated_seed():
    """Negative control in isolation: the migrated seed is consumed but never counted."""
    result = harness.run_synthetic_week()
    report = result["report"]
    assert result["seed_consumed"] is True          # the seed really was recalled+consumed
    assert report["migrated_lessons"] >= 1
    # circulation equals ONLY the distinct fork-authored consumed lessons.
    assert report["circulation"] == result["expected_circulation"]


def test_recall_miss_is_not_silent():
    """A no-match work turn must leave a kind='miss' receipt, not vanish."""
    result = harness.run_synthetic_week()
    assert result["miss_empty"] is True              # prefetch returned no context
    assert result["report"]["recall_misses"] >= 1    # but the miss was recorded


def test_no_write_only_memory_flag():
    """The predecessor pathology (lessons written, never read) must be OFF."""
    report = harness.run_synthetic_week()["report"]
    write_only = next(f for f in report["flags"] if f["name"] == "WRITE_ONLY_MEMORY")
    assert write_only["active"] is False
