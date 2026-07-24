"""M0-3b — centralized non-primary ordinary-memory fence.

Behavior tests proving that the built-in ``memory`` tool is rejected at
execution time when ``agent._agent_context`` is anything other than
``"primary"`` (cron, subagent, flush), for BOTH the sequential and
concurrent tool-call paths.

The fence fires BEFORE MemoryStore changes and before MemoryManager /
provider notification, so:

  - MEMORY.md and USER.md remain byte-unchanged on disk.
  - ``MemoryManager.notify_memory_tool_write`` is never called.
  - Primary context still writes normally.

The tests exercise the real ``execute_tool_calls_sequential`` /
``execute_tool_calls_concurrent`` module functions from
``agent.tool_executor`` against a real temp ``HERMES_HOME`` with a real
``MemoryStore``, not a mock.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_tool_call(name="memory", arguments="{}", call_id=None):
    return SimpleNamespace(
        id=call_id or f"call_{uuid.uuid4().hex[:8]}",
        type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def _make_agent(tmp_path, monkeypatch, agent_context="primary"):
    """Build a minimal AIAgent with a real MemoryStore pointed at temp HERMES_HOME."""
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir(parents=True, exist_ok=True)
    memories_dir = hermes_home / "memories"
    memories_dir.mkdir(parents=True, exist_ok=True)

    # Patch get_memory_dir for the ENTIRE test so MemoryStore.save_to_disk
    # and _reload_target resolve to our temp dir.
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
        from run_agent import AIAgent
        from tools.memory_tool import MemoryStore

        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            agent_context=agent_context,
        )
        agent.client = MagicMock()
        agent._cached_system_prompt = "You are helpful."
        agent._use_prompt_caching = False
        agent.tool_delay = 0
        agent.compression_enabled = False
        agent.save_trajectories = False

        # Attach a real MemoryStore pointed at the temp memories dir.
        store = MemoryStore(memory_char_limit=500, user_char_limit=300)
        store.load_from_disk()
        agent._memory_store = store

        # Attach a mock MemoryManager so we can assert notify_memory_tool_write
        # is never called for non-primary contexts.
        agent._memory_manager = MagicMock()
        agent._memory_manager.has_tool = lambda _name: False
        agent._memory_manager.notify_memory_tool_write = MagicMock(return_value=None)

        return agent, hermes_home
    finally:
        for p in patches:
            p.stop()


def _seed_memory_files(hermes_home):
    """Write initial content to MEMORY.md and USER.md, return their bytes."""
    mem_path = hermes_home / "memories" / "MEMORY.md"
    user_path = hermes_home / "memories" / "USER.md"
    mem_path.write_text("initial memory entry", encoding="utf-8")
    user_path.write_text("initial user entry", encoding="utf-8")
    return mem_path.read_bytes(), user_path.read_bytes()


def _memory_add_call(target="memory", content="should not persist"):
    """Build a mock tool_call for memory(action=add)."""
    args = json.dumps({"action": "add", "target": target, "content": content})
    return _mock_tool_call("memory", args, "call-fence")


# ---------------------------------------------------------------------------
# Sequential path — MEMORY.md / USER.md byte-unchanged for non-primary
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("ctx", ["cron", "subagent", "flush"])
def test_sequential_memory_md_unchanged_for_non_primary(tmp_path, monkeypatch, ctx):
    agent, hermes_home = _make_agent(tmp_path, monkeypatch, agent_context=ctx)
    mem_before, user_before = _seed_memory_files(hermes_home)

    tc = _memory_add_call("memory", "cron fact")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages = []

    from agent.tool_executor import execute_tool_calls_sequential
    execute_tool_calls_sequential(agent, msg, messages, "task-fence")

    mem_after = (hermes_home / "memories" / "MEMORY.md").read_bytes()
    assert mem_after == mem_before, "MEMORY.md must be byte-unchanged in non-primary context"
    # The tool result must be a blocked error.
    assert len(messages) == 1
    result = json.loads(messages[0]["content"])
    assert "error" in result
    assert "disabled" in result["error"]
    assert ctx in result["error"]


@pytest.mark.parametrize("ctx", ["cron", "subagent", "flush"])
def test_sequential_user_md_unchanged_for_non_primary(tmp_path, monkeypatch, ctx):
    agent, hermes_home = _make_agent(tmp_path, monkeypatch, agent_context=ctx)
    mem_before, user_before = _seed_memory_files(hermes_home)

    tc = _memory_add_call("user", "cron user fact")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages = []

    from agent.tool_executor import execute_tool_calls_sequential
    execute_tool_calls_sequential(agent, msg, messages, "task-fence")

    user_after = (hermes_home / "memories" / "USER.md").read_bytes()
    assert user_after == user_before, "USER.md must be byte-unchanged in non-primary context"


def test_sequential_primary_still_writes(tmp_path, monkeypatch):
    """Primary context must still write to MEMORY.md normally."""
    agent, hermes_home = _make_agent(tmp_path, monkeypatch, agent_context="primary")
    _seed_memory_files(hermes_home)

    tc = _memory_add_call("memory", "primary fact")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages = []

    from agent.tool_executor import execute_tool_calls_sequential
    execute_tool_calls_sequential(agent, msg, messages, "task-fence")

    mem_text = (hermes_home / "memories" / "MEMORY.md").read_text(encoding="utf-8")
    assert "primary fact" in mem_text
    assert "initial memory entry" in mem_text  # original content preserved
    assert len(messages) == 1
    result = json.loads(messages[0]["content"])
    assert result["success"] is True


def test_sequential_provider_not_notified_for_non_primary(tmp_path, monkeypatch):
    """notify_memory_tool_write must NOT be called for non-primary contexts."""
    agent, hermes_home = _make_agent(tmp_path, monkeypatch, agent_context="subagent")
    _seed_memory_files(hermes_home)

    tc = _memory_add_call("memory", "subagent fact")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages = []

    from agent.tool_executor import execute_tool_calls_sequential
    execute_tool_calls_sequential(agent, msg, messages, "task-fence")

    agent._memory_manager.notify_memory_tool_write.assert_not_called()


def test_sequential_primary_notifies_provider(tmp_path, monkeypatch):
    """Primary context must still notify the provider on a successful write."""
    agent, hermes_home = _make_agent(tmp_path, monkeypatch, agent_context="primary")
    _seed_memory_files(hermes_home)

    tc = _memory_add_call("memory", "primary fact")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages = []

    from agent.tool_executor import execute_tool_calls_sequential
    execute_tool_calls_sequential(agent, msg, messages, "task-fence")

    agent._memory_manager.notify_memory_tool_write.assert_called_once()


# ---------------------------------------------------------------------------
# Concurrent path — same guarantees
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("ctx", ["cron", "subagent", "flush"])
def test_concurrent_memory_md_unchanged_for_non_primary(tmp_path, monkeypatch, ctx):
    agent, hermes_home = _make_agent(tmp_path, monkeypatch, agent_context=ctx)
    mem_before, user_before = _seed_memory_files(hermes_home)

    tc = _memory_add_call("memory", "concurrent cron fact")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages = []

    from agent.tool_executor import execute_tool_calls_concurrent
    execute_tool_calls_concurrent(agent, msg, messages, "task-fence")

    mem_after = (hermes_home / "memories" / "MEMORY.md").read_bytes()
    assert mem_after == mem_before, "MEMORY.md must be byte-unchanged in non-primary context"
    assert len(messages) == 1
    result = json.loads(messages[0]["content"])
    assert "error" in result
    assert "disabled" in result["error"]


@pytest.mark.parametrize("ctx", ["cron", "subagent", "flush"])
def test_concurrent_provider_not_notified_for_non_primary(tmp_path, monkeypatch, ctx):
    agent, hermes_home = _make_agent(tmp_path, monkeypatch, agent_context=ctx)
    _seed_memory_files(hermes_home)

    tc = _memory_add_call("memory", "concurrent fact")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages = []

    from agent.tool_executor import execute_tool_calls_concurrent
    execute_tool_calls_concurrent(agent, msg, messages, "task-fence")

    agent._memory_manager.notify_memory_tool_write.assert_not_called()


def test_concurrent_primary_still_writes(tmp_path, monkeypatch):
    """Primary context must still write via the concurrent path."""
    agent, hermes_home = _make_agent(tmp_path, monkeypatch, agent_context="primary")
    _seed_memory_files(hermes_home)

    tc = _memory_add_call("memory", "primary concurrent fact")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages = []

    from agent.tool_executor import execute_tool_calls_concurrent
    execute_tool_calls_concurrent(agent, msg, messages, "task-fence")

    mem_text = (hermes_home / "memories" / "MEMORY.md").read_text(encoding="utf-8")
    assert "primary concurrent fact" in mem_text


# ---------------------------------------------------------------------------
# Batch (operations) path — also fenced
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("ctx", ["cron", "subagent", "flush"])
def test_batch_memory_unchanged_for_non_primary(tmp_path, monkeypatch, ctx):
    """The operations=batch shape must also be fenced."""
    agent, hermes_home = _make_agent(tmp_path, monkeypatch, agent_context=ctx)
    mem_before, _ = _seed_memory_files(hermes_home)

    args = json.dumps({
        "target": "memory",
        "operations": [
            {"action": "add", "content": "batch fact 1"},
            {"action": "add", "content": "batch fact 2"},
        ],
    })
    tc = _mock_tool_call("memory", args, "call-batch-fence")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages = []

    from agent.tool_executor import execute_tool_calls_sequential
    execute_tool_calls_sequential(agent, msg, messages, "task-fence")

    mem_after = (hermes_home / "memories" / "MEMORY.md").read_bytes()
    assert mem_after == mem_before
    result = json.loads(messages[0]["content"])
    assert "error" in result
    assert "disabled" in result["error"]


# ---------------------------------------------------------------------------
# Default (no _agent_context attribute) — backwards-compatible primary
# ---------------------------------------------------------------------------

def test_missing_agent_context_defaults_to_primary_and_writes(tmp_path, monkeypatch):
    """An agent without _agent_context (backwards-compat) must write normally."""
    agent, hermes_home = _make_agent(tmp_path, monkeypatch, agent_context="primary")
    # Simulate an old caller that never set _agent_context by deleting it.
    del agent._agent_context
    _seed_memory_files(hermes_home)

    tc = _memory_add_call("memory", "default context fact")
    msg = SimpleNamespace(content="", tool_calls=[tc])
    messages = []

    from agent.tool_executor import execute_tool_calls_sequential
    execute_tool_calls_sequential(agent, msg, messages, "task-fence")

    mem_text = (hermes_home / "memories" / "MEMORY.md").read_text(encoding="utf-8")
    assert "default context fact" in mem_text
