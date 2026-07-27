"""prefetch routing: store read leg fires AND a circulation receipt is emitted+consumed (M0-B1).

Ported from AIOS composite-provider/tests/test_prefetch.py.
"""

import pytest

from plugins.memory.composite.core.tests.fake_store import FakeStore
from plugins.memory.composite.core import CompositeMemoryProvider, SESSION_START_CALL_SITE
from plugins.memory.composite.core.tests.mocks import MockBrain, MockVault


def _lesson(lesson, **over):
    base = {
        "lesson": lesson,
        "task_type": "knowledge-gate",
        "tags": ["recall", "test"],
        "provenance": "fork:background_review",
        "source": "auto",
    }
    base.update(over)
    return base


@pytest.fixture
def store():
    s = FakeStore(":memory:")
    yield s
    s.close()


def test_prefetch_recalls_store_and_emits_consumed_receipt(store):
    ref = store.append(_lesson("Always read the file before editing it."))

    comp = CompositeMemoryProvider(store, brain=MockBrain(), vault=MockVault())
    comp.initialize("sess-1")

    ctx = comp.prefetch("read file before editing")

    assert "read the file before editing" in ctx.lower()

    aggregate = store.aggregate()
    assert aggregate["recall_hits"] == 1
    assert aggregate["recall_misses"] == 0
    assert aggregate["consumed_hits"] == 1
    assert store.circulation() == 1
    assert ref


def test_prefetch_miss_writes_miss_receipt_never_silent(store):
    store.append(_lesson("Unrelated lesson about networking."))
    comp = CompositeMemoryProvider(store, brain=MockBrain(), vault=MockVault())
    comp.initialize("sess-2")

    ctx = comp.prefetch("zzz nonexistent topic qqq")

    assert ctx == ""
    aggregate = store.aggregate()
    assert aggregate["recall_misses"] == 1
    assert aggregate["consumed_hits"] == 0
    assert store.circulation() == 0


def test_prefetch_is_fast__brain_vault_moved_to_queue_prefetch(store):
    """The Sev-4 inversion: prefetch() must NOT call the brain/vault inline."""
    store.append(_lesson("Lesson about caching strategies."))
    brain = MockBrain(prefetch_items=[{"content": "brain-cached note about caching", "score": 0.9}])
    vault = MockVault(items=[{"content": "vault note about caching", "score": 0.5}])
    comp = CompositeMemoryProvider(store, brain=brain, vault=vault)
    comp.initialize("sess-warm")

    ctx1 = comp.prefetch("caching")
    assert brain.prefetch_calls == 0, "prefetch must not call the brain inline (hot path)"
    assert vault.recall_calls == 0, "prefetch must not call the vault inline"
    assert "brain-cached note" not in ctx1 and "vault note" not in ctx1
    assert "caching strategies" in ctx1.lower()

    comp.queue_prefetch("caching")
    assert brain.prefetch_calls == 1
    assert vault.recall_calls == 1

    ctx2 = comp.prefetch("caching")
    assert "brain-cached note" in ctx2
    assert "vault note" in ctx2
    assert brain.prefetch_calls == 1


def test_prefetch_caps_merged_output_at_recall_limit(store):
    store.append(_lesson("Store lesson about caching, authoritative, score 1.0."))
    brain_items = [
        {"content": f"brain note number {i} about caching", "score": 0.5}
        for i in range(20)
    ]
    brain = MockBrain(prefetch_items=brain_items)
    vault = MockVault(items=[{"content": "vault note about caching", "score": 0.7}])
    comp = CompositeMemoryProvider(store, brain=brain, vault=vault, recall_limit=5)
    comp.initialize("sess-cap")

    comp.prefetch("caching")
    comp.queue_prefetch("caching")
    ctx = comp.prefetch("caching")

    body = [ln for ln in ctx.splitlines() if ln.startswith("  (")]
    assert len(body) <= 5, f"merged output exceeded recall_limit: {len(body)} lines"

    assert body[0].startswith("  (S)")
    assert body[1].startswith("  (V)")


def test_prefetch_store_wins_same_text_dedup(store):
    same = "Always read the file before editing it."
    store.append(_lesson(same))
    vault = MockVault(items=[{"content": same, "score": 0.9}])
    comp = CompositeMemoryProvider(store, brain=MockBrain(), vault=vault, recall_limit=5)
    comp.initialize("sess-dedup")

    comp.prefetch("read file before editing")
    comp.queue_prefetch("read file before editing")
    ctx = comp.prefetch("read file before editing")

    body = [ln for ln in ctx.splitlines() if ln.startswith("  (")]
    matching = [ln for ln in body if same.lower() in ln.lower()]
    assert len(matching) == 1, "same text must dedup to a single entry"
    assert matching[0].startswith("  (S)"), "store wins the same-text dedup, not vault"


def test_prefetch_uses_session_start_call_site(store):
    store.append(_lesson("Lesson about deadlocks and locks."))
    comp = CompositeMemoryProvider(store, brain=MockBrain(), vault=MockVault())
    comp.initialize("sess-3")

    comp.prefetch("deadlocks locks")

    row = store._conn.execute(
        "SELECT call_site, kind FROM receipts ORDER BY ts DESC LIMIT 1"
    ).fetchone()
    assert row[0] == SESSION_START_CALL_SITE
    assert row[1] == "hit"
    assert store.valence_window() == []
