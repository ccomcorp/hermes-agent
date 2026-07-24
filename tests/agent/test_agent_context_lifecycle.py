"""M0-3a — lifecycle agent_context foundation.

Validates the backwards-compatible ``agent_context`` lifecycle input on
``AIAgent`` / ``init_agent``: default ``primary``, accepts the four
canonical values (``primary|cron|subagent|flush``), rejects invalid
values deterministically before provider initialization, persists on the
agent as ``_agent_context``, and propagates the exact value to
``MemoryManager.initialize_all`` instead of the hard-coded ``"primary"``.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest


class RecordingMemoryProvider:
    """Memory provider that captures the kwargs passed to ``initialize``."""

    name = "recording"

    def __init__(self):
        self.init_kwargs = None
        self.init_session_id = None

    def is_available(self):
        return True

    def initialize(self, session_id, **kwargs):
        self.init_session_id = session_id
        self.init_kwargs = dict(kwargs)

    def get_tool_schemas(self):
        return []

    def shutdown(self):
        pass


def _make_agent(**overrides):
    """Build an AIAgent with the standard test mocks and given overrides."""
    cfg = overrides.pop("_cfg", {"memory": {"provider": ""}, "agent": {}})
    provider = overrides.pop("_provider", None)

    patches = [
        patch("hermes_cli.config.load_config", return_value=cfg),
        patch("agent.model_metadata.get_model_context_length", return_value=204_800),
        patch("run_agent.get_tool_definitions", return_value=[]),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ]
    if provider is not None:
        patches.append(patch("plugins.memory.load_memory_provider", return_value=provider))

    for p in patches:
        p.start()

    try:
        from run_agent import AIAgent

        defaults = dict(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
        defaults.update(overrides)
        return AIAgent(**defaults)
    finally:
        for p in patches:
            p.stop()


# ---------------------------------------------------------------------------
# Default
# ---------------------------------------------------------------------------

def test_default_agent_context_is_primary():
    agent = _make_agent()
    assert agent._agent_context == "primary"


# ---------------------------------------------------------------------------
# All four canonical values
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("ctx", ["primary", "cron", "subagent", "flush"])
def test_valid_agent_contexts_accepted_and_persisted(ctx):
    agent = _make_agent(agent_context=ctx)
    assert agent._agent_context == ctx


# ---------------------------------------------------------------------------
# Invalid input fails deterministically before provider init
# ---------------------------------------------------------------------------

def test_invalid_agent_context_raises_value_error():
    with pytest.raises(ValueError, match="Invalid agent_context"):
        _make_agent(agent_context="bogus")


def test_empty_string_agent_context_raises_value_error():
    with pytest.raises(ValueError, match="Invalid agent_context"):
        _make_agent(agent_context="")


def test_none_agent_context_raises_value_error():
    # None strips to "" → invalid
    with pytest.raises(ValueError, match="Invalid agent_context"):
        _make_agent(agent_context=None)


# ---------------------------------------------------------------------------
# Propagation to MemoryManager.initialize_all
# ---------------------------------------------------------------------------

def _make_agent_with_recording_provider(agent_context):
    provider = RecordingMemoryProvider()
    cfg = {"memory": {"provider": "recording"}, "agent": {}}
    agent = _make_agent(
        _cfg=cfg,
        _provider=provider,
        skip_memory=False,
        session_id="sess-ctx",
        platform="cli",
        agent_context=agent_context,
    )
    return agent, provider


@pytest.mark.parametrize("ctx", ["primary", "cron", "subagent", "flush"])
def test_agent_context_propagates_to_initialize_all(ctx):
    agent, provider = _make_agent_with_recording_provider(ctx)
    assert provider.init_kwargs is not None, "provider.initialize was not called"
    assert provider.init_kwargs["agent_context"] == ctx


def test_non_primary_context_not_hardcoded_to_primary_in_init_kwargs():
    """Regression: the literal 'primary' must not override the real context."""
    agent, provider = _make_agent_with_recording_provider("cron")
    assert provider.init_kwargs["agent_context"] == "cron"
    assert provider.init_kwargs["agent_context"] != "primary"
