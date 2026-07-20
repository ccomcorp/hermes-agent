"""Kanban workers auto-block oversized cards after repeated compactions."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from agent.conversation_compression import compress_context


def _agent_with_compression_count(count: int):
    compressor = Mock()
    compressor.compress.return_value = [
        {"role": "user", "content": "[CONTEXT COMPACTION] summary"},
        {"role": "user", "content": "tail question"},
    ]
    compressor.compression_count = count
    compressor.last_prompt_tokens = 0
    compressor.last_completion_tokens = 0
    compressor._last_summary_error = None
    compressor._last_compress_aborted = False
    compressor._last_compression_made_progress = True

    agent = SimpleNamespace(
        api_mode="chat_completions",
        _compression_feasibility_checked=True,
        session_id="session-1",
        model="test/model",
        log_prefix="",
        context_compressor=compressor,
        _memory_manager=None,
        _todo_store=SimpleNamespace(format_for_injection=lambda: ""),
        _session_db=None,
        _cached_system_prompt=None,
        _last_flushed_db_idx=0,
        _last_compaction_in_place=False,
        compression_in_place=False,
        platform="cli",
        tools=None,
        _emit_status=Mock(),
        _emit_warning=Mock(),
        _invalidate_system_prompt=Mock(),
        _build_system_prompt=Mock(return_value="rebuilt system prompt"),
    )
    return agent


def _compress(agent):
    return compress_context(
        agent,
        [{"role": "user", "content": "before"}, {"role": "assistant", "content": "after"}],
        "system prompt",
        approx_tokens=10_000,
    )


def test_worker_at_limit_blocks_once_and_latches(monkeypatch):
    calls = []

    def fake_block(**kwargs):
        calls.append(kwargs)
        return True

    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_big")
    monkeypatch.setattr(
        "hermes_cli.config.load_config_readonly",
        lambda: {"kanban": {"compaction_block_limit": 3}},
    )
    monkeypatch.setattr(
        "tools.kanban_tools.block_current_worker_for_decomposition",
        fake_block,
        raising=False,
    )

    agent = _agent_with_compression_count(3)
    _compress(agent)
    agent.context_compressor.compression_count = 4
    _compress(agent)

    assert calls == [{"task_id": "t_big", "compression_count": 3, "limit": 3}]
    assert agent._compaction_autoblock_fired is True


def test_non_worker_never_blocks(monkeypatch):
    block = Mock()
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    monkeypatch.setattr(
        "tools.kanban_tools.block_current_worker_for_decomposition",
        block,
        raising=False,
    )

    _compress(_agent_with_compression_count(9))

    block.assert_not_called()


@pytest.mark.parametrize("config", [
    {"kanban": {"compaction_block_limit": 0}},
    {"kanban": {}},
])
def test_limit_zero_disables_and_missing_limit_defaults_to_three(monkeypatch, config):
    calls = []
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_big")
    monkeypatch.setattr("hermes_cli.config.load_config_readonly", lambda: config)
    monkeypatch.setattr(
        "tools.kanban_tools.block_current_worker_for_decomposition",
        lambda **kwargs: calls.append(kwargs) or True,
        raising=False,
    )

    _compress(_agent_with_compression_count(2))
    assert calls == []

    _compress(_agent_with_compression_count(3))
    expected = [] if config["kanban"].get("compaction_block_limit") == 0 else [
        {"task_id": "t_big", "compression_count": 3, "limit": 3}
    ]
    assert calls == expected


def test_helper_failure_is_swallowed(monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_big")
    monkeypatch.setattr(
        "hermes_cli.config.load_config_readonly",
        lambda: {"kanban": {"compaction_block_limit": 3}},
    )

    def boom(**_kwargs):
        raise RuntimeError("db locked")

    monkeypatch.setattr(
        "tools.kanban_tools.block_current_worker_for_decomposition",
        boom,
        raising=False,
    )

    compressed, prompt = _compress(_agent_with_compression_count(3))

    assert compressed
    assert prompt == "rebuilt system prompt"


def test_block_helper_reason_contract(monkeypatch):
    from tools import kanban_tools
    from tools.kanban_tools import (
        _AUTOBLOCK_REASON_TAG,
        block_current_worker_for_decomposition,
    )

    captured = {}

    class FakeConn:
        def close(self):
            captured["closed"] = True

    class FakeKb:
        def block_task(self, conn, task_id, *, reason=None, kind=None):
            captured.update(
                {"conn": conn, "task_id": task_id, "reason": reason, "kind": kind}
            )
            return True

    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_big")
    monkeypatch.setattr(kanban_tools, "_connect", lambda: (FakeKb(), FakeConn()))

    assert block_current_worker_for_decomposition("t_big", 5, 3) is True

    assert captured["task_id"] == "t_big"
    assert captured["kind"] == "needs_input"
    assert captured["closed"] is True
    assert _AUTOBLOCK_REASON_TAG in captured["reason"]
    assert "ORCHESTRATOR ACTION" in captured["reason"]
    assert "inspect any staged edits" in captured["reason"]
    assert "split this card into smaller sibling cards" in captured["reason"]
