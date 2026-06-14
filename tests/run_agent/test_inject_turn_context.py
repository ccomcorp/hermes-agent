"""AC-R3 / AC-R1 — the REAL conversation_loop inject->confirm seam (consumed-at-injection).

These drive the actual chassis helper `agent.conversation_loop.inject_turn_context` through a
live `MemoryManager` + `HermesCompositeProvider` + store. They do NOT call
`confirm_prefetch_consumed`/`mark_consumed` directly — consumption happens only via the real
manager->provider path the chassis uses, exactly as a turn would. This is the rung-2
integration test the round-2 elicitation found missing.
"""

from __future__ import annotations

import pytest

from agent.conversation_loop import inject_turn_context
from agent.memory_manager import MemoryManager

try:
    from plugins.memory.composite.provider import ExperienceStore, HermesCompositeProvider

    _HAVE_AIOS = True
except Exception:  # pragma: no cover - sibling AIOS repo absent
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(not _HAVE_AIOS, reason="AIOS composite/store not importable")


class _Agent:
    def __init__(self, manager, session_id):
        self._memory_manager = manager
        self.session_id = session_id


def _setup(session_id):
    store = ExperienceStore(db_path=":memory:")
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize(session_id, agent_context="primary")
    mgr = MemoryManager()
    mgr.add_provider(comp)
    comp.record_fork_lesson(
        "Clear the zorblat lock before retrying the deploy.",
        provenance="fork:background_review:s", task_type="workflow",
    )
    return store, comp, mgr


def test_injected_block_confirms_and_circulates():
    store, comp, mgr = _setup("sess-1")
    agent = _Agent(mgr, "sess-1")
    # Real prefetch through the manager WITH session_id (AC-R1: same key the confirm uses).
    ext = mgr.prefetch_all("zorblat lock retry", session_id="sess-1")
    assert ext  # recall hit
    assert store.circulation() == 0  # stashed, not consumed until injected

    api_msg = {"role": "user", "content": "do the deploy"}
    injected = inject_turn_context(api_msg, ext, "", agent)
    assert injected is True
    assert "do the deploy" in api_msg["content"] and "EXPERIENCE" in api_msg["content"]
    # Consumed via the REAL manager->provider confirm path (no direct confirm call here).
    assert store.circulation() == 1


def test_dropped_injection_does_not_confirm():
    """Assemble-but-drop: non-str content -> block never injected -> never consumed (the
    gameable-count case D4-A exists to prevent)."""
    store, comp, mgr = _setup("sess-2")
    agent = _Agent(mgr, "sess-2")
    ext = mgr.prefetch_all("zorblat lock retry", session_id="sess-2")
    assert ext

    api_msg = {"role": "user", "content": [{"type": "text", "text": "do the deploy"}]}
    injected = inject_turn_context(api_msg, ext, "", agent)
    assert injected is False
    assert isinstance(api_msg["content"], list)  # untouched
    assert store.circulation() == 0  # block never reached the prompt -> not consumed


def test_session_key_match_is_what_makes_it_circulate():
    """AC-R1 regression: prefetch stash key and confirm key must be the SAME session id.
    turn_context now passes the real session_id; inject_turn_context confirms with
    agent.session_id. A mismatch would leave circulation at 0."""
    store, comp, mgr = _setup("real-id")
    agent = _Agent(mgr, "real-id")
    ext = mgr.prefetch_all("zorblat lock retry", session_id="real-id")
    inject_turn_context({"role": "user", "content": "go"}, ext, "", agent)
    assert store.circulation() == 1


def test_no_memory_manager_is_clean_noop():
    # An agent without a memory manager must not error in the inject seam.
    agent = _Agent(None, "x")
    api_msg = {"role": "user", "content": "hi"}
    assert inject_turn_context(api_msg, "", "", agent) is False
    assert api_msg["content"] == "hi"
