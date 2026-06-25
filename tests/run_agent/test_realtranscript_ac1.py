"""M1 G4b — the REAL-TRANSCRIPT AC1 measurement harness, as a CI gate.

Mirrors ``test_synthetic_week_ac1.py`` but pins the bar against the GENUINE
fork-authored corpus the live composite-brain-leg wrote (read READ-ONLY from the
live experience.db under HERMES_HOME), not hand-authored seeds. Closes SPEC Q3
(corpus) + the "synthetic not real transcripts" gap (``docs/plans/M1-CLOSEOUT-AUDIT.md``
G4b).

If the live DB has no real fork-authored lessons (fresh checkout / CI without the
runtime), the harness returns ``None`` and these tests SKIP — a real-transcript gate
must not pass on a synthetic fallback. The end-to-end-injection limit is unchanged
and remains G4a's concern (see the harness docstring).
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
    import realtranscript_ac1 as harness  # noqa: E402

    _HAVE_AIOS = True
except Exception:  # pragma: no cover - environment-dependent (sibling AIOS repo absent)
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(
    not _HAVE_AIOS, reason="AIOS experience-store/composite/health packages not importable"
)


def _run_or_skip():
    result = harness.run_real_transcript()
    if result is None:
        pytest.skip(
            "no real fork-authored corpus (live experience.db absent or 0 migrated=0 "
            "source='reviewed' lessons); real-transcript gate will not run on a synthetic fallback"
        )
    return result


def test_realtranscript_ac1_holds():
    """The end-to-end bar on the REAL corpus: zero AC1 violations from the replay."""
    result = _run_or_skip()
    failures = harness.check_ac1(result)
    assert failures == [], "AC1 violations (real corpus): " + "; ".join(failures)


def test_real_fork_lessons_circulate():
    """Circulation > 0 from distinct fork-authored (migrated=0) consumed reads of REAL
    lesson content — the central G4b claim (real transcripts, not seeds, circulate)."""
    result = _run_or_skip()
    report = result["report"]
    assert result["real_count"] >= 1                 # real corpus was actually present
    assert result["fork_written"] == result["real_count"]
    assert result["fork_hits"] >= 1                  # real content recalled via real queries
    assert report["circulation"] >= 1                # AC1 numerator moved off zero
    assert report["circulation"] == result["fork_hits"]


def test_circulation_excludes_migrated_seed():
    """Negative control: the migrated seed is consumed but never counted, even with a
    real corpus present alongside it."""
    result = _run_or_skip()
    report = result["report"]
    assert result["seed_consumed"] is True           # the seed really was recalled+consumed
    assert report["migrated_lessons"] >= 1
    # circulation counts ONLY the distinct fork-authored consumed lessons.
    assert report["circulation"] == result["fork_hits"]


def test_oracle_agrees_with_health_report():
    """An independent SQL re-derivation of circulation must match the health report — so
    producer and grader don't share one code path."""
    result = _run_or_skip()
    assert result["oracle_circulation"] == result["report"]["circulation"]


def test_recall_miss_is_not_silent():
    """A no-match work turn must leave a kind='miss' receipt, not vanish."""
    result = _run_or_skip()
    assert result["miss_empty"] is True              # prefetch returned no context
    assert result["report"]["recall_misses"] >= 1    # but the miss was recorded


def test_no_write_only_memory_flag():
    """The predecessor pathology (lessons written, never read) must be OFF on real data."""
    result = _run_or_skip()
    write_only = next(
        f for f in result["report"]["flags"] if f["name"] == "WRITE_ONLY_MEMORY"
    )
    assert write_only["active"] is False
