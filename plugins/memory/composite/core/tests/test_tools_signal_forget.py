"""Tool routing tests — ported from AIOS (M0-B1)."""

import json

import pytest

from store import ExperienceStore
from plugins.memory.composite.core import CompositeMemoryProvider, TOOL_SIGNAL, TOOL_FORGET
from plugins.memory.composite.core.tests.mocks import MockBrain, MockVault


def _lesson(lesson="A lesson worth signalling.", **over):
    base = {
        "lesson": lesson,
        "task_type": "implementation-pattern",
        "tags": ["x"],
        "provenance": "fork:test",
        "source": "auto",
    }
    base.update(over)
    return base


@pytest.fixture
def comp_store():
    s = ExperienceStore(":memory:")
    comp = CompositeMemoryProvider(s, brain=MockBrain(), vault=MockVault())
    yield comp, s
    s.close()


def test_signal_tool_routes_to_store_with_derivation(comp_store):
    comp, store = comp_store
    ref = store.append(_lesson())

    out = comp.handle_tool_call(
        TOOL_SIGNAL, {"ref": ref, "valence": 1.0, "derivation": "task_completed"}
    )
    payload = json.loads(out)

    assert "result" in payload
    assert payload["result"]["ok"] is True
    assert payload["result"]["derivation"] == "task_completed"
    assert store.get(ref)["wins"] == 1
    assert store.success_rate(ref) == 1.0
    assert payload["ack"]["brain"] == "degraded"


def test_signal_tool_missing_derivation_is_clean_tool_error(comp_store):
    comp, store = comp_store
    ref = store.append(_lesson())

    out = comp.handle_tool_call(TOOL_SIGNAL, {"ref": ref, "valence": 1.0})
    payload = json.loads(out)

    assert "error" in payload
    assert payload["error"] == "ConstantValenceError"
    assert "derivation" in payload["message"]
    assert store.get(ref)["wins"] == 0
    assert store.aggregate()["valence_count"] == 0


def test_signal_tool_invalid_derivation_rejected(comp_store):
    comp, store = comp_store
    ref = store.append(_lesson())

    out = comp.handle_tool_call(
        TOOL_SIGNAL, {"ref": ref, "valence": 1.0, "derivation": "made_up"}
    )
    payload = json.loads(out)
    assert payload["error"] == "ConstantValenceError"
    assert store.aggregate()["valence_count"] == 0


def test_signal_tool_constant_bool_valence_rejected(comp_store):
    comp, store = comp_store
    ref = store.append(_lesson())

    out = comp.handle_tool_call(
        TOOL_SIGNAL, {"ref": ref, "valence": True, "derivation": "task_completed"}
    )
    payload = json.loads(out)
    assert "error" in payload
    assert payload["error"] == "ValueError"
    assert store.aggregate()["valence_count"] == 0


def test_signal_tool_unknown_ref_is_clean_rejection_not_crash(comp_store):
    comp, store = comp_store

    out = comp.handle_tool_call(
        TOOL_SIGNAL,
        {"ref": "does-not-exist", "valence": 1.0, "derivation": "task_completed"},
    )
    payload = json.loads(out)

    assert payload["error"] == "UnknownRef"
    assert payload["ref"] == "does-not-exist"
    assert payload["ack"]["store"] == "rejected"
    assert payload["ack"]["brain"] == "skipped"
    assert "recall" in payload["message"].lower()
    assert store.aggregate()["valence_count"] == 0


def test_forget_tool_tombstones_and_excludes_from_recall(comp_store):
    comp, store = comp_store
    ref = store.append(_lesson("Forgettable lesson about widgets."))

    out = comp.handle_tool_call(TOOL_FORGET, {"ref": ref})
    payload = json.loads(out)
    assert payload["result"]["tombstoned"] is True

    records, receipt = store.recall("widgets", call_site="post-forget")
    assert records == []
    assert receipt["kind"] == "miss"


def test_unknown_tool_returns_error(comp_store):
    comp, _ = comp_store
    out = comp.handle_tool_call("nope", {})
    assert json.loads(out)["error"] == "UnknownTool"
