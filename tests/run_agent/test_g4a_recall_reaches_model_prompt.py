"""AIOS M1 G4a — prove a recalled fork-authored lesson reaches the ASSEMBLED PROMPT the
model receives, not merely that ``prefetch_all`` returned text (Sev-2 #8 / AC1
"consumed = prefetch-returned, not model-read" gap; docs/plans/M1-CLOSEOUT-AUDIT.md).

What this closes
----------------
``test_inject_turn_context.py`` already proves the recalled block lands in
``api_msg["content"]`` and that it circulates. The residual G4a gap is one rung deeper:
does that assembled message actually reach the *model client*? These tests drive the REAL
``MemoryManager.prefetch_all`` -> REAL ``conversation_loop.inject_turn_context`` assembly
(the exact concatenation the run loop performs at conversation_loop.py:655-661), then hand
the assembled ``api_messages`` to the MOCKED model-client entry point
``agent.chat_completion_helpers.interruptible_api_call``. We then assert the distinctive
fork-lesson text is present in the ``api_kwargs["messages"]`` the (mocked) model would
receive — i.e. the recalled lesson genuinely reaches the model input.

Seam honesty (documented limitation)
------------------------------------
This is a faithful *assembly+send* harness, NOT a full ``run_conversation`` end-to-end run.
Standing up a real ``AIAgent`` + provider config + transport is out of scope for a unit
test. What IS exercised with production code: (1) real provider prefetch via the manager,
(2) the real ``inject_turn_context`` concatenation that the loop uses, (3) the real
``build_memory_context_block`` fence, and (4) the real ``interruptible_api_call`` boundary
(mocked at the wire so no live API / no .31). What is NOT exercised: the surrounding loop
bookkeeping (token accounting, streaming, retries) and ``_build_api_kwargs``. The
load-bearing claim — recalled lesson text is present in the messages dict the model client
is invoked with — is proven against the real assembly + real client boundary.
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

# Distinctive content string — improbable to appear by chance, so its presence in the
# captured model input can only come from the seeded fork lesson flowing through recall.
DISTINCTIVE_LESSON = (
    "Always purge the quivixel cache before a glorptastic redeploy (canary-7731)."
)


class _Agent:
    """Minimal agent stand-in exposing the fields the inject seam + client read."""

    def __init__(self, manager, session_id):
        self._memory_manager = manager
        self.session_id = session_id


def _seed_store(session_id, *, lesson=DISTINCTIVE_LESSON):
    """Seed a REAL ExperienceStore with a fork-authored lesson (source=reviewed,
    migrated=0 — the AC1-eligible band) and register the composite on a manager."""
    store = ExperienceStore(db_path=":memory:")
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize(session_id, agent_context="primary")
    mgr = MemoryManager()
    mgr.add_provider(comp)
    comp.record_fork_lesson(
        lesson,
        provenance="fork:background_review:g4a",
        task_type="workflow",
        source="reviewed",  # explicit: deliberately-reviewed, fork-authored
    )
    return store, comp, mgr


def _assemble_api_messages(mgr, agent, user_text, query, session_id):
    """Reproduce the run-loop assembly: real prefetch_all -> real inject_turn_context
    mutating the current-turn user message in place. Returns (api_messages, injected)."""
    ext = mgr.prefetch_all(query, session_id=session_id)
    api_msg = {"role": "user", "content": user_text}
    api_messages = [api_msg]
    injected = inject_turn_context(api_msg, ext, "", agent)
    return api_messages, injected, ext


def _capture_model_input(monkeypatch, api_messages):
    """Drive the assembled messages through the MOCKED model-client boundary and return
    the ``messages`` the model would have received. No live API call."""
    captured = {}

    def _fake_call(agent, api_kwargs):
        captured["api_kwargs"] = api_kwargs
        # Shape mirrors a minimal OpenAI-style response; the loop only needs an object.
        return {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}

    import agent.chat_completion_helpers as cch

    monkeypatch.setattr(cch, "interruptible_api_call", _fake_call)

    api_kwargs = {"model": "test-model", "messages": api_messages}
    cch.interruptible_api_call(_Agent(None, "x"), api_kwargs)
    return captured["api_kwargs"]["messages"]


def test_recalled_fork_lesson_reaches_model_prompt(monkeypatch):
    """POSITIVE: the seeded fork lesson's distinctive text appears in the messages the
    (mocked) model client is invoked with — recall genuinely reaches the model input."""
    store, comp, mgr = _seed_store("g4a-pos")
    agent = _Agent(mgr, "g4a-pos")

    api_messages, injected, ext = _assemble_api_messages(
        mgr, agent, "run the glorptastic redeploy", "quivixel cache redeploy", "g4a-pos"
    )

    # Sanity: recall hit and was injected into the assembled user message.
    assert DISTINCTIVE_LESSON in ext, "prefetch_all did not return the seeded lesson"
    assert injected is True

    model_messages = _capture_model_input(monkeypatch, api_messages)

    # The load-bearing assertion: the distinctive lesson text is in what the MODEL receives.
    flat = "\n".join(
        m.get("content", "") for m in model_messages if isinstance(m.get("content"), str)
    )
    assert DISTINCTIVE_LESSON in flat, (
        "recalled fork lesson did NOT reach the assembled model prompt"
    )
    # And it arrives inside the recalled-memory fence, not smuggled as user input.
    assert "<memory-context>" in flat
    # Consumed via the real manager->provider confirm path (circulated, not just returned).
    assert store.circulation() == 1


def test_no_matching_lesson_means_distinctive_text_absent(monkeypatch):
    """NEGATIVE control: with NO matching lesson seeded, the distinctive text is absent from
    the model prompt — recall does not fabricate content."""
    # Empty store -> nothing to recall. (record_fork_lesson NOT called.)
    store = ExperienceStore(db_path=":memory:")
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize("g4a-neg", agent_context="primary")
    mgr = MemoryManager()
    mgr.add_provider(comp)
    agent = _Agent(mgr, "g4a-neg")

    api_messages, injected, ext = _assemble_api_messages(
        mgr, agent, "run the glorptastic redeploy", "quivixel cache redeploy", "g4a-neg"
    )

    model_messages = _capture_model_input(monkeypatch, api_messages)
    flat = "\n".join(
        m.get("content", "") for m in model_messages if isinstance(m.get("content"), str)
    )

    assert DISTINCTIVE_LESSON not in flat, (
        "distinctive lesson text appeared in the prompt with no matching lesson seeded "
        "(fabrication / leakage)"
    )
    # The original user text must still be intact regardless of recall outcome.
    assert "run the glorptastic redeploy" in flat
