"""Real-data finalization for the prefetch inversion (Sev-4) — M0-B1."""

import json

from plugins.memory.composite.core.tests.fake_store import FakeStore
from plugins.memory.composite.core import CompositeMemoryProvider
from plugins.memory.composite.core.tests.mocks import MockBrain, MockVault

CORPUS = [
    ("Always read a file before editing it to avoid clobbering unseen changes.", "implementation-pattern"),
    ("When a sqlite connection is thread-bound, serialize access behind a lock or own a dedicated thread.", "error-recovery"),
    ("FTS5 MATCH with OR of quoted terms avoids syntax errors from punctuation in the query.", "implementation-pattern"),
    ("Verify chassis contracts against the running code, not a stale file that merely exists.", "test-methodology"),
    ("Prefetch must be fast; do slow recall in queue_prefetch and serve cached results.", "architecture"),
]


def _seed(store):
    return [
        store.append({
            "lesson": text,
            "task_type": kind,
            "tags": text.lower().split()[:4],
            "provenance": "fork:background_review",
            "source": "auto",
        })
        for text, kind in CORPUS
    ]


def test_realdata_multi_turn_inversion_and_circulation():
    store = FakeStore(":memory:")
    refs = _seed(store)
    brain = MockBrain(prefetch_items=[{"content": "brain note: serialize sqlite writes", "score": 0.7}])
    vault = MockVault(items=[{"content": "vault note: WAL mode and locking", "score": 0.6}])
    comp = CompositeMemoryProvider(store, brain=brain, vault=vault)
    comp.initialize("real-sess")

    ctx1 = comp.prefetch("sqlite connection thread lock")
    assert "thread-bound" in ctx1.lower()
    assert brain.prefetch_calls == 0
    assert "brain note" not in ctx1 and "vault note" not in ctx1
    comp.queue_prefetch("sqlite connection thread lock")
    assert brain.prefetch_calls == 1 and vault.recall_calls == 1

    ctx2 = comp.prefetch("sqlite connection thread lock")
    assert "thread-bound" in ctx2.lower()
    assert "brain note" in ctx2 and "vault note" in ctx2
    assert brain.prefetch_calls == 1

    assert store.circulation() >= 1

    comp.sync_turn(
        "how do I make the store thread-safe?",
        "Open with check_same_thread=False and guard every method with an RLock.",
    )
    assert brain.reward_calls == []

    out = json.loads(comp.handle_tool_call(
        "experience_signal", {"ref": refs[1], "valence": 1.0, "derivation": "test_result"}
    ))
    assert out["ack"]["store"] == "ok"
    assert store.success_rate(refs[1]) == 1.0
    comp.handle_tool_call(
        "experience_signal", {"ref": refs[0], "valence": -1.0, "derivation": "user_correction"}
    )
    agg = store.aggregate()
    assert agg["valence_count"] == 2 and agg["valence_variance"] > 0
    store.close()
