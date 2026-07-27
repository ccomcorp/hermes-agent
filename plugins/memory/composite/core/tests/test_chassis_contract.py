"""§11 contract test: the vendor-native composite against the REAL Hermes-Agent chassis ABC.

Ported from AIOS composite-provider/tests/test_chassis_contract.py (M0-B1).
The vendor copy always imports from the real chassis ABC (no _base_shim),
so this test is always RUN (never skipped).
"""

import inspect

import pytest

from agent.memory_provider import MemoryProvider as RealABC
from plugins.memory.composite.core.tests.fake_store import FakeStore
from plugins.memory.composite.core import CompositeMemoryProvider, TOOL_SIGNAL
from plugins.memory.composite.core.tests.mocks import MockBrain, MockVault


def test_real_abc_is_synchronous():
    """Pins the contract that the whole sync rework depends on."""
    for name in ("prefetch", "queue_prefetch", "sync_turn", "handle_tool_call",
                 "initialize", "shutdown", "on_session_switch", "on_delegation"):
        method = getattr(RealABC, name)
        assert not inspect.iscoroutinefunction(method), f"chassis ABC.{name} is async — the composite is sync!"


def test_composite_subclasses_and_satisfies_the_real_abc():
    assert issubclass(CompositeMemoryProvider, RealABC), \
        "CompositeMemoryProvider is not bound to the real chassis ABC"
    store = FakeStore(":memory:")
    comp = CompositeMemoryProvider(store, brain=MockBrain(), vault=MockVault())
    assert isinstance(comp, RealABC)
    assert RealABC.__abstractmethods__ <= set(dir(comp))
    store.close()


def test_lifecycle_round_trip_against_the_real_abc():
    store = FakeStore(":memory:")
    ref = store.append({
        "lesson": "Contract-test lesson about chassis binding.",
        "task_type": "test-methodology", "tags": ["contract"],
        "provenance": "fork:test", "source": "auto",
    })
    brain = MockBrain()
    comp = CompositeMemoryProvider(store, brain=brain, vault=MockVault())
    comp.initialize("contract-sess")

    ctx = comp.prefetch("chassis binding")
    assert isinstance(ctx, str) and "chassis binding" in ctx.lower()
    assert store.circulation() == 1

    ack = comp.sync_turn("u", "a")
    assert isinstance(ack, dict) and brain.reward_calls == []

    import json
    out = json.loads(comp.handle_tool_call(TOOL_SIGNAL, {"ref": ref, "valence": 1.0, "derivation": "test_result"}))
    assert out["ack"]["store"] == "ok"
    store.close()
