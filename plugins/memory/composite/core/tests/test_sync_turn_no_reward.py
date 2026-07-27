"""sync_turn appends a lesson but NEVER rewards/signals — the composite-layer
anti-constant-valence guarantee (C3). Ported from AIOS (M0-B1)."""

import pytest

from plugins.memory.composite.core.tests.fake_store import FakeStore
from plugins.memory.composite.core import CompositeMemoryProvider
from plugins.memory.composite.core.tests.mocks import MockBrain, MockVault


@pytest.fixture
def store():
    s = FakeStore(":memory:")
    yield s
    s.close()


def test_sync_turn_appends_but_never_rewards(store):
    brain = MockBrain(online=True)
    comp = CompositeMemoryProvider(store, brain=brain, vault=MockVault())
    comp.initialize("sess-1")

    before = store.aggregate()["total_lessons"]
    ack = comp.sync_turn("user asked X", "assistant explained Y", session_id="sess-1")
    after = store.aggregate()["total_lessons"]

    assert after == before + 1
    assert len(brain.observe_calls) == 1
    assert brain.reward_calls == [], "sync_turn must not fire any reward/signal"
    assert store.aggregate()["valence_count"] == 0
    assert store.aggregate()["signalled_lessons"] == 0
    assert set(ack.keys()) == {"store", "brain", "vault"}
    assert ack["store"] == "ok"
    assert ack["brain"] == "degraded"


def test_sync_turn_brain_offline_marks_fail_not_ok(store):
    brain = MockBrain(online=False)
    comp = CompositeMemoryProvider(store, brain=brain, vault=MockVault())
    comp.initialize("s")

    ack = comp.sync_turn("u", "a")
    assert brain.reward_calls == []
    assert ack["brain"] == "fail"
    assert ack["store"] == "ok"
