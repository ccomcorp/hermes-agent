"""M0-3d — subagent lifecycle-context wiring.

Focused construction-path tests proving that ``_build_child_agent`` wires
every delegated child AIAgent with:

  - ``agent_context="subagent"`` — the lifecycle context that gates
    ordinary-memory writes via the non-primary fence (M0-3b).
  - ``skip_memory=True`` — subagents never load memories into their system
    prompt (prompt-cache isolation + no cross-session leakage).

Plus a regression assertion that the child toolset still excludes the
``memory`` tool (``DELEGATE_BLOCKED_TOOLS`` enforcement), so the fence and
the toolset strip are two independent layers of the same defense.

The construction path is exercised by patching ``run_agent.AIAgent`` with a
capture stub *before* ``_build_child_agent`` imports it, so we observe the
exact kwargs the real construction path passes — not a mock of it.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from tools.delegate_tool import (
    DELEGATE_BLOCKED_TOOLS,
    _build_child_agent,
    _strip_blocked_tools,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _minimal_parent(**overrides):
    """A parent-agent stand-in carrying only the attributes _build_child_agent reads."""
    defaults = dict(
        enabled_toolsets=["terminal", "file", "web"],
        disabled_toolsets=None,
        model="test-model",
        provider="openrouter",
        base_url="https://openrouter.ai/api/v1",
        api_key="sk-test-1234567890",
        api_mode="chat_completions",
        acp_command=None,
        acp_args=[],
        reasoning_config=None,
        prefill_messages=None,
        _fallback_chain=None,
        providers_allowed=None,
        providers_ignored=None,
        providers_order=None,
        provider_sort=None,
        provider_require_parameters=False,
        provider_data_collection="",
        openrouter_min_coding_score=None,
        request_overrides={},
        session_id="parent-session-123",
        _session_db=None,
        _delegate_depth=0,
        _subagent_id=None,
        _current_turn_id="",
        _print_fn=None,
        _safe_print=None,
        max_tokens=None,
        _credential_pool=None,
        _active_children=[],
        _active_children_lock=None,
        _subdirectory_hints=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class _AgentCapture:
    """Stub for AIAgent that records the construction kwargs."""

    def __init__(self, **kwargs):
        # Record every kwarg the real construction path passes.
        self._captured_kwargs = dict(kwargs)
        # Provide the attributes _build_child_agent reads off the child
        # AFTER construction (lines 1415+).
        self.session_id = "child-session-456"
        self._session_init_model_config = {}

    def __getattr__(self, name):
        # Return None for any attribute _build_child_agent sets post-construction
        # that we don't care about (child._print_fn, child._delegate_depth, etc.)
        # so setattr calls on the stub don't crash.
        return None


# ---------------------------------------------------------------------------
# Construction-path tests
# ---------------------------------------------------------------------------

def _build_and_capture(parent, *, toolsets=None, **build_kwargs):
    """Run _build_child_agent with AIAgent patched to capture construction kwargs.

    Returns (child_stub, captured_kwargs_dict).
    """
    captured: dict = {}

    def _capture(**kwargs):
        captured.update(kwargs)
        return _AgentCapture(**kwargs)

    with patch("run_agent.AIAgent") as mock_cls:
        mock_cls.side_effect = _capture
        child = _build_child_agent(
            task_index=0,
            goal="test goal",
            context=None,
            toolsets=toolsets,
            model=None,
            max_iterations=50,
            task_count=1,
            parent_agent=parent,
            **build_kwargs,
        )

    return child, captured


def test_child_agent_context_is_subagent():
    """The AIAgent constructor must receive agent_context='subagent'."""
    parent = _minimal_parent()
    _child, captured = _build_and_capture(parent)

    assert "agent_context" in captured, "agent_context kwarg must be passed to AIAgent"
    assert captured["agent_context"] == "subagent", (
        f"agent_context must be 'subagent', got {captured['agent_context']!r}"
    )


def test_child_skip_memory_is_true():
    """The AIAgent constructor must receive skip_memory=True."""
    parent = _minimal_parent()
    _child, captured = _build_and_capture(parent)

    assert captured.get("skip_memory") is True, (
        f"skip_memory must be True for delegated children, got {captured.get('skip_memory')!r}"
    )


def test_child_platform_is_subagent():
    """The platform must be 'subagent' — lifecycle routing depends on it."""
    parent = _minimal_parent()
    _child, captured = _build_and_capture(parent)

    assert captured.get("platform") == "subagent"


def test_child_skip_context_files_is_true():
    """skip_context_files=True — subagents must not load project AGENTS.md etc."""
    parent = _minimal_parent()
    _child, captured = _build_and_capture(parent)

    assert captured.get("skip_context_files") is True


# ---------------------------------------------------------------------------
# Regression: child toolset excludes memory
# ---------------------------------------------------------------------------

class TestChildToolsetExcludesMemory:
    """The memory tool must never appear in a delegated child's toolset.

    This is the toolset-level layer of defense; the agent_context fence
    (M0-3b) is the execution-time layer. Both must hold independently.
    """

    def test_strip_blocked_removes_memory_toolset(self):
        """_strip_blocked_tools must remove the 'memory' toolset."""
        result = _strip_blocked_tools(["terminal", "file", "memory", "web"])
        assert "memory" not in result
        assert "terminal" in result
        assert "file" in result

    def test_memory_in_delegate_blocked_tools(self):
        """The 'memory' tool name must be in DELEGATE_BLOCKED_TOOLS."""
        assert "memory" in DELEGATE_BLOCKED_TOOLS

    def test_default_toolsets_after_strip_exclude_memory(self):
        """The DEFAULT_TOOLSETS after stripping must not contain memory."""
        from tools.delegate_tool import DEFAULT_TOOLSETS

        stripped = _strip_blocked_tools(DEFAULT_TOOLSETS)
        assert "memory" not in stripped

    def test_child_construction_does_not_add_memory_toolset(self):
        """End-to-end: _build_child_agent must not produce a child whose
        enabled_toolsets include 'memory'."""
        parent = _minimal_parent()
        child, _captured = _build_and_capture(parent)

        # The captured enabled_toolsets must not contain memory.
        toolsets = child._captured_kwargs.get("enabled_toolsets") or []
        assert "memory" not in toolsets, (
            f"memory toolset leaked into child enabled_toolsets: {toolsets}"
        )

    def test_explicit_memory_toolset_request_is_stripped(self):
        """Even if the caller explicitly requests 'memory' in toolsets,
        _strip_blocked_tools must remove it before the child sees it."""
        parent = _minimal_parent(enabled_toolsets=["terminal", "file", "memory"])
        child, _captured = _build_and_capture(
            parent, toolsets=["terminal", "memory"]
        )

        toolsets = child._captured_kwargs.get("enabled_toolsets") or []
        assert "memory" not in toolsets
