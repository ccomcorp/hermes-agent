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
    assert ctx  # non-empty -> hit
    # D4-A: prefetch stashes the receipt but does NOT consume until the chassis confirms
    # the block was injected. Model that confirm here.
    assert store.circulation() == 0
    comp.confirm_prefetch_consumed()
    assert store.circulation() == 1  # numerator moved once the block was injected


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
    # One prefetch on the shared token hits both -> inject (confirm) -> 2 distinct.
    assert comp.prefetch("plover")
    comp.confirm_prefetch_consumed()
    assert store.circulation() == 2
    assert _oracle(store) == 2

    # Re-query + re-inject: same refs, no double-count (DISTINCT set over consumed hits).
    assert comp.prefetch("plover")
    comp.confirm_prefetch_consumed()
    assert store.circulation() == 2

    # Tombstone one AFTER it was consumed: still counted (historical receipt; no tombstoned
    # filter in circulation()). The oracle MUST agree — this is exactly the R1 divergence
    # that an `AND tombstoned = 0` oracle would have gotten wrong.
    store.forget(a)
    assert store.circulation() == 2
    assert _oracle(store) == 2


# --- D4-A: consumed only at injection (assemble-but-drop must not count) -----------------

def test_prefetch_without_confirm_does_not_consume():
    """A recalled block that prefetch returns but the chassis NEVER injects (the
    assemble-but-drop path) must NOT count toward circulation — that is the gameable-count
    fix (Sev-2 #8)."""
    store, comp = _comp()
    comp.record_fork_lesson(
        "Clear the zorblat lock before retrying the deploy.",
        provenance="fork:background_review:s", task_type="workflow",
    )
    ctx = comp.prefetch("zorblat lock retry")  # stashes the receipt; does NOT consume
    assert ctx
    assert store.circulation() == 0  # not injected -> not consumed -> not counted

    assert comp.confirm_prefetch_consumed() is True  # chassis injected the block
    assert store.circulation() == 1
    # idempotent within a turn: a second confirm finds nothing pending
    assert comp.confirm_prefetch_consumed() is False
    assert store.circulation() == 1


# --- D3b: pre-delegation recall mechanism (provider methods) -----------------------------

def test_recall_for_pre_delegation_then_confirm():
    store, comp = _comp()
    comp.record_fork_lesson(
        "Run the grommet calibration before the swizzle stage.",
        provenance="fork:background_review:s", task_type="implementation-pattern",
    )
    block, receipt_id = comp.recall_for("pre-delegation", "grommet calibration swizzle")
    assert block and "grommet" in block.lower()
    assert store.circulation() == 0  # recall_for does not consume on its own
    assert comp.confirm_consumed(receipt_id) is True  # block placed in child prompt
    assert store.circulation() == 1


def test_recall_for_miss_writes_receipt_and_returns_empty():
    store, comp = _comp()
    block, receipt_id = comp.recall_for("pre-delegation", "nothing matches flibbertigibbet")
    assert block == ""           # nothing to inject
    assert receipt_id            # but a (miss) receipt was still written — never silent
    rec = store.get_receipt(receipt_id)
    assert rec is not None and rec["kind"] == "miss"


# --- D4-A: MemoryManager delegation is capability-guarded -------------------------------

def test_manager_confirm_prefetch_consumed_capability_guard():
    from agent.memory_manager import MemoryManager

    store, comp = _comp()
    comp.record_fork_lesson(
        "Always read a file before editing it.",
        provenance="fork:background_review:s", task_type="workflow",
    )
    mgr = MemoryManager()
    mgr.add_provider(comp)
    comp.prefetch("read file before editing")  # stash via the provider

    # A provider WITHOUT confirm_prefetch_consumed must be a clean no-op (no crash).
    class _Dumb:
        name = "dumb"

        def is_available(self):
            return True

        def get_tool_schemas(self):
            return []

    mgr._providers.append(_Dumb())  # exercise the getattr guard over a mixed provider set

    mgr.confirm_prefetch_consumed(session_id="s")  # delegates; guard skips _Dumb
    assert store.circulation() == 1
