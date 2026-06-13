"""M1 Task 2 D3a (AC1 via the built session-start prefetch — no hook) + D2/R1 (DISTINCT
dedup + tombstone semantics, validating the harness oracle filter matches circulation()).
"""

from __future__ import annotations

import json

import pytest

try:
    from plugins.memory.composite.provider import ExperienceStore, HermesCompositeProvider

    _HAVE_AIOS = True
except Exception:  # pragma: no cover - sibling AIOS repo absent
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(not _HAVE_AIOS, reason="AIOS composite/store not importable")


def _comp():
    store = ExperienceStore(db_path=":memory:")
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize("s", agent_context="primary")
    return store, comp


def test_ac1_moves_via_session_start_prefetch_without_any_hook():
    """D3a: AC1 > 0 requires NO pre-delegation hook — the already-built session-start
    `prefetch` recalls a fork lesson into a consumed hit and marks it consumed itself."""
    store, comp = _comp()
    comp.record_fork_lesson(
        "Always clear the zorblat lock before retrying the deploy.",
        provenance="fork:background_review:s",
        task_type="workflow",
    )
    assert store.circulation() == 0
    ctx = comp.prefetch("zorblat lock retry")  # the REAL session-start call site
    assert ctx  # non-empty -> hit; prefetch marked the receipt consumed
    assert store.circulation() == 1  # numerator moved through prefetch alone


def _oracle(store):
    """Re-derive circulation the way the harness oracle does (R1: migrated=0, NO tombstoned
    clause — must match store.circulation())."""
    conn = store._conn
    refs: set[str] = set()
    for (refs_json,) in conn.execute(
        "SELECT lesson_refs FROM receipts WHERE consumed = 1 AND kind = 'hit'"
    ).fetchall():
        refs.update(json.loads(refs_json))
    fork = {r for (r,) in conn.execute("SELECT id FROM lessons WHERE migrated = 0").fetchall()}
    return len(refs & fork)


def test_distinct_dedup_and_tombstone_after_consumption():
    """D2/R1: overlapping vocabulary -> one prefetch hits BOTH fork lessons (DISTINCT count
    = 2); re-query does not double-count; tombstoning a lesson AFTER it was consumed leaves
    circulation unchanged (the receipt is historical; circulation() has no tombstoned clause),
    and the oracle (also no tombstoned clause) agrees."""
    store, comp = _comp()
    a = comp.record_fork_lesson(
        "The plover index must be rebuilt nightly.",
        provenance="fork:background_review:s", task_type="workflow",
    )
    comp.record_fork_lesson(
        "Plover cache invalidation needs an explicit flush.",
        provenance="fork:background_review:s", task_type="implementation-pattern",
    )
    # One prefetch on the shared token hits both -> consumed -> 2 distinct.
    assert comp.prefetch("plover")
    assert store.circulation() == 2
    assert _oracle(store) == 2

    # Re-query: same refs, no double-count (DISTINCT set over consumed hit receipts).
    assert comp.prefetch("plover")
    assert store.circulation() == 2

    # Tombstone one AFTER it was consumed: still counted (historical receipt; no tombstoned
    # filter in circulation()). The oracle MUST agree — this is exactly the R1 divergence
    # that an `AND tombstoned = 0` oracle would have gotten wrong.
    store.forget(a)
    assert store.circulation() == 2
    assert _oracle(store) == 2
