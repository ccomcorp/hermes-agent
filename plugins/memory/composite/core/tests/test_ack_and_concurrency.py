"""Per-backend ack shape + F2 concurrent store access safety (M0-B1)."""

import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from store import ExperienceStore
from plugins.memory.composite.core import CompositeMemoryProvider
from plugins.memory.composite.core.tests.mocks import MockBrain, MockVault


def _lesson(lesson, **over):
    base = {
        "lesson": lesson,
        "task_type": "workflow",
        "tags": ["c"],
        "provenance": "fork:test",
        "source": "auto",
    }
    base.update(over)
    return base


@pytest.fixture
def store():
    s = ExperienceStore(":memory:")
    yield s
    s.close()


def test_ack_shape_brain_degraded(store):
    comp = CompositeMemoryProvider(store, brain=MockBrain(online=True), vault=MockVault())
    comp.initialize("s")
    ack = comp.sync_turn("u", "a")
    assert set(ack.keys()) == {"store", "brain", "vault"}, "ack is never a single boolean"
    assert ack["brain"] == "degraded"
    assert ack["brain"] not in ("ok", True)


def test_ack_shape_on_delegation(store):
    comp = CompositeMemoryProvider(store, brain=MockBrain(), vault=MockVault())
    comp.initialize("s")
    ack = comp.on_delegation("do the thing", "did the thing", child_session_id="kid")
    assert set(ack.keys()) == {"store", "brain", "vault"}
    assert ack["store"] == "ok"
    assert ack["brain"] == "degraded"


def test_concurrent_composite_access_no_corruption():
    store = ExperienceStore(":memory:")
    comp = CompositeMemoryProvider(store, brain=MockBrain(), vault=MockVault())
    comp.initialize("s")
    refs = [store.append(_lesson(f"Concurrency lesson number {i}")) for i in range(5)]

    def do_prefetch(i):
        return comp.prefetch(f"Concurrency lesson number {i % 5}")

    def do_sync(i):
        return comp.sync_turn(f"u{i}", f"assistant turn content {i}")

    def do_signal(i):
        out = comp.handle_tool_call(
            "experience_signal",
            {"ref": refs[i % len(refs)], "valence": 1.0 if i % 2 else -1.0, "derivation": "test_result"},
        )
        return json.loads(out)

    work = []
    for i in range(20):
        work += [(do_prefetch, i), (do_sync, i), (do_signal, i)]

    errors = []
    with ThreadPoolExecutor(max_workers=8) as clients:
        futures = [clients.submit(fn, i) for fn, i in work]
        for fut in futures:
            try:
                fut.result()
            except BaseException as exc:
                errors.append(repr(exc))

    assert not errors, f"concurrent composite access raised: {errors[:3]}"
    agg = store.aggregate()
    assert agg["total_lessons"] == 5 + 20
    assert agg["valence_count"] == 20
    assert agg["valence_variance"] > 0
    store.close()


def test_concurrent_appends_all_persist():
    store = ExperienceStore(":memory:")
    comp = CompositeMemoryProvider(store, brain=None, vault=None)
    comp.initialize("s")
    with ThreadPoolExecutor(max_workers=8) as clients:
        futures = [clients.submit(comp.sync_turn, f"u{i}", f"a{i}") for i in range(50)]
        for fut in futures:
            fut.result()
    assert store.aggregate()["total_lessons"] == 50
    store.close()
