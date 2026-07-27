"""M0-3e — background-review fork lifecycle-context wiring.

These tests prove the background-review fork is constructed with the exact
lifecycle context (``agent_context="flush"``) while retaining
``skip_memory=True``, that the parent MemoryStore reference and the
``record_fork_authored_lessons`` parent-side handoff are preserved, and that
an attempted ordinary direct memory-tool write from the fork is denied by
the central non-primary fence in ``agent.tool_executor`` — NOT by deleting
the reviewed-lesson forwarding path.

The fence under test lives in ``agent/tool_executor.py`` and fires for any
``agent._agent_context != "primary"``. The background-review fork sets
``agent_context="flush"`` (agent/background_review.py) so the fork's ordinary
``memory(action="add")`` calls are rejected before MemoryStore changes and
before MemoryManager/provider notification, while the parent-side
``record_fork_authored_lessons`` handoff still mirrors the fork's authored
writes into the composite experience store.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import run_agent as run_agent_module
from run_agent import AIAgent


# ---------------------------------------------------------------------------
# Bare-agent + immediate-thread harness (mirrors test_background_review.py).
# ---------------------------------------------------------------------------

def _bare_agent() -> AIAgent:
    agent = object.__new__(AIAgent)
    agent.model = "fake-model"
    agent.platform = "telegram"
    agent.provider = "openai"
    agent.base_url = ""
    agent.api_key = ""
    agent.api_mode = ""
    agent.session_id = "test-session"
    agent._parent_session_id = ""
    agent._credential_pool = None
    agent._memory_store = object()
    agent._memory_enabled = True
    agent._user_profile_enabled = False
    agent._cached_system_prompt = "test-cached-system-prompt"
    import datetime as _dt
    agent.session_start = _dt.datetime(2026, 1, 1, 12, 0, 0)
    agent._MEMORY_REVIEW_PROMPT = "review memory"
    agent._SKILL_REVIEW_PROMPT = "review skills"
    agent._COMBINED_REVIEW_PROMPT = "review both"
    agent.background_review_callback = None
    agent.status_callback = None
    agent._safe_print = lambda *_args, **_kwargs: None
    agent.enabled_toolsets = None
    agent.disabled_toolsets = None
    agent.reasoning_config = None
    agent.max_tokens = None
    agent.acp_command = None
    agent.acp_args = []
    agent.request_overrides = {}
    agent.memory_notifications = "on"
    return agent


class ImmediateThread:
    def __init__(self, *, target, daemon=None, name=None):
        self._target = target

    def start(self):
        self._target()


def _fake_review_agent_factory(captured: dict):
    """Build a FakeReviewAgent that records init kwargs + review messages."""

    class FakeReviewAgent:
        def __init__(self, **kwargs):
            captured["init_kwargs"] = kwargs
            self._session_messages = []

        def run_conversation(self, **kwargs):
            # Simulate a fork that attempted an ordinary memory add.
            self._session_messages = [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call-fork-mem",
                            "function": {
                                "name": "memory",
                                "arguments": json.dumps(
                                    {
                                        "action": "add",
                                        "target": "memory",
                                        "content": "fork fact",
                                    }
                                ),
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call-fork-mem",
                    "content": json.dumps(
                        {
                            "success": True,
                            "message": "Entry added.",
                            "target": "memory",
                        }
                    ),
                },
            ]

        def shutdown_memory_provider(self):
            pass

        def close(self):
            pass

    return FakeReviewAgent


# ---------------------------------------------------------------------------
# Test 1: construction uses flush
# ---------------------------------------------------------------------------

def test_background_review_fork_constructed_with_flush_context(monkeypatch):
    """The review fork must pass ``agent_context="flush"`` to AIAgent.

    This is the lifecycle-context wiring: the fork is a non-primary context
    so the central fence in agent/tool_executor.py denies its ordinary
    memory-tool writes. The wiring is a single constructor kwarg — this
    test guards it.
    """
    captured: dict = {}
    FakeReviewAgent = _fake_review_agent_factory(captured)

    monkeypatch.setattr(run_agent_module, "AIAgent", FakeReviewAgent)
    monkeypatch.setattr(run_agent_module.threading, "Thread", ImmediateThread)

    agent = _bare_agent()
    AIAgent._spawn_background_review(
        agent,
        messages_snapshot=[{"role": "user", "content": "hello"}],
        review_memory=True,
    )

    kwargs = captured.get("init_kwargs", {})
    assert kwargs.get("agent_context") == "flush", (
        "Background review fork must be constructed with agent_context='flush' "
        "so the central non-primary memory fence denies its ordinary writes. "
        f"Got agent_context={kwargs.get('agent_context')!r}."
    )


# ---------------------------------------------------------------------------
# Test 2: external provider activation remains skipped
# ---------------------------------------------------------------------------

def test_background_review_fork_retains_skip_memory_true(monkeypatch):
    """``skip_memory=True`` must still be passed alongside ``agent_context="flush"``.

    The flush context gates ordinary memory-tool writes via the central fence,
    but ``skip_memory=True`` is what prevents AIAgent.__init__ from rebuilding
    a _memory_manager wired to external plugins (honcho, mem0, ...). Both must
    be present: the fence denies writes; skip_memory prevents provider
    activation/ingestion (on_turn_start, prefetch_all, sync_all).
    """
    captured: dict = {}
    FakeReviewAgent = _fake_review_agent_factory(captured)

    monkeypatch.setattr(run_agent_module, "AIAgent", FakeReviewAgent)
    monkeypatch.setattr(run_agent_module.threading, "Thread", ImmediateThread)

    agent = _bare_agent()
    AIAgent._spawn_background_review(
        agent,
        messages_snapshot=[{"role": "user", "content": "hello"}],
        review_memory=True,
    )

    kwargs = captured.get("init_kwargs", {})
    assert kwargs.get("skip_memory") is True, (
        "Background review fork must retain skip_memory=True so external "
        "memory providers are not activated. The flush context gates writes; "
        "skip_memory gates provider ingestion."
    )
    # And both must be present simultaneously.
    assert kwargs.get("agent_context") == "flush"


# ---------------------------------------------------------------------------
# Test 3: an attempted direct ordinary write is denied through the shared
# executor (the central fence), NOT by deleting the reviewed-lesson path.
# ---------------------------------------------------------------------------

def _make_flush_agent(tmp_path, monkeypatch):
    """Build a minimal AIAgent with agent_context="flush" and a real MemoryStore."""
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir(parents=True, exist_ok=True)
    memories_dir = hermes_home / "memories"
    memories_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr("tools.memory_tool.get_memory_dir", lambda: memories_dir)

    cfg = {"memory": {"provider": ""}, "agent": {}}
    patches = [
        patch("hermes_cli.config.load_config", return_value=cfg),
        patch("agent.model_metadata.get_model_context_length", return_value=204_800),
        patch("run_agent.get_tool_definitions", return_value=[]),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ]
    for p in patches:
        p.start()

    try:
        from run_agent import AIAgent as _AIAgent
        from tools.memory_tool import MemoryStore

        agent = _AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            agent_context="flush",
        )
        agent.client = MagicMock()
        agent._cached_system_prompt = "You are helpful."
        agent._use_prompt_caching = False
        agent.tool_delay = 0
        agent.compression_enabled = False
        agent.save_trajectories = False

        store = MemoryStore(memory_char_limit=500, user_char_limit=300)
        store.load_from_disk()
        agent._memory_store = store

        agent._memory_manager = MagicMock()
        agent._memory_manager.has_tool = lambda _name: False
        agent._memory_manager.notify_memory_tool_write = MagicMock(return_value=None)

        return agent, hermes_home
    finally:
        for p in patches:
            p.stop()


def _memory_add_call(content="fork ordinary write"):
    args = json.dumps({"action": "add", "target": "memory", "content": content})
    return SimpleNamespace(
        id="call-flush-fence",
        type="function",
        function=SimpleNamespace(name="memory", arguments=args),
    )


def test_flush_context_fork_memory_write_denied_by_central_fence(tmp_path, monkeypatch):
    """An ordinary ``memory(action="add")`` from a flush-context fork must be
    denied by the central non-primary fence in agent/tool_executor.py — before
    MemoryStore changes and before provider notification.

    This proves the denial is through the shared executor (the fence), NOT by
    deleting the reviewed-lesson path: the fork still has a MemoryStore
    reference and the fence is what blocks the write.
    """
    agent, hermes_home = _make_flush_agent(tmp_path, monkeypatch)

    mem_path = hermes_home / "memories" / "MEMORY.md"
    mem_path.write_text("initial memory entry", encoding="utf-8")
    mem_before = mem_path.read_bytes()

    tc = _memory_add_call("fork ordinary write")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages: list = []

    from agent.tool_executor import execute_tool_calls_sequential
    execute_tool_calls_sequential(agent, msg, messages, "task-flush-fence")

    # MEMORY.md must be byte-unchanged — the fence denied the write.
    assert mem_path.read_bytes() == mem_before, (
        "MEMORY.md must be byte-unchanged: the central fence must deny the "
        "fork's ordinary memory write before MemoryStore changes."
    )
    # The tool result must be a blocked error from the fence.
    assert len(messages) == 1
    result = json.loads(messages[0]["content"])
    assert "error" in result
    assert "disabled" in result["error"]
    assert "flush" in result["error"]
    # And provider notification must NOT have fired.
    agent._memory_manager.notify_memory_tool_write.assert_not_called()


# ---------------------------------------------------------------------------
# Test 4: reviewed lesson forwarding remains covered
# ---------------------------------------------------------------------------

def test_record_fork_authored_lessons_still_called(monkeypatch):
    """The parent-side ``record_fork_authored_lessons`` handoff must still fire.

    The fork's ordinary memory writes are denied by the central fence, but the
    reviewed-lesson forwarding path (which mirrors fork-authored writes into
    the composite experience store) must remain intact. This test patches
    ``record_fork_authored_lessons`` and asserts it is called with the parent
    agent, the fork's review messages, and the prior snapshot.
    """
    import agent.background_review as bg_review

    captured: dict = {}
    FakeReviewAgent = _fake_review_agent_factory(captured)

    def _fake_record(agent, review_messages, prior_snapshot):
        captured["record_agent"] = agent
        captured["record_review_messages"] = list(review_messages)
        captured["record_prior_snapshot"] = list(prior_snapshot)
        return 0

    monkeypatch.setattr(run_agent_module, "AIAgent", FakeReviewAgent)
    monkeypatch.setattr(run_agent_module.threading, "Thread", ImmediateThread)
    monkeypatch.setattr(bg_review, "record_fork_authored_lessons", _fake_record)

    agent = _bare_agent()
    snapshot = [{"role": "user", "content": "hi"}]
    AIAgent._spawn_background_review(
        agent,
        messages_snapshot=snapshot,
        review_memory=True,
    )

    assert "record_agent" in captured, (
        "record_fork_authored_lessons must still be called — the reviewed-lesson "
        "forwarding path is preserved, not deleted."
    )
    assert captured["record_agent"] is agent
    # The fork simulated a memory add — the review messages must carry it.
    review_msgs = captured["record_review_messages"]
    assert any(
        isinstance(m, dict) and m.get("role") == "tool"
        and m.get("tool_call_id") == "call-fork-mem"
        for m in review_msgs
    ), "review messages must include the fork's tool result for lesson extraction"
    assert captured["record_prior_snapshot"] == snapshot


def test_record_fork_authored_lessons_path_not_deleted():
    """The ``record_fork_authored_lessons`` function must still exist and be
    importable from agent.background_review — the reviewed-lesson forwarding
    path is preserved, not deleted in favour of the fence.
    """
    from agent.background_review import record_fork_authored_lessons
    assert callable(record_fork_authored_lessons)
    # And it must still be in __all__.
    from agent.background_review import __all__ as bg_all
    assert "record_fork_authored_lessons" in bg_all
