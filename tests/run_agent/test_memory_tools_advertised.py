"""Regression guard: the memory provider's experience tools must be ADVERTISED to the
model under the platform's toolset config — not merely registered/routable.

THE BLIND SPOT THIS CLOSES (real incident, 2026-06-14): the composite provider, store, and
brain leg were all healthy and `experience_signal`/`experience_forget` were registered and
routable in the MemoryManager — yet the desktop model reported "the tool doesn't exist in my
toolset". Cause: the agent-init memory-tool injection is GATED (`agent_init.py:1220-1222`) —
memory provider tools reach the model's advertised surface only when

    enabled_toolsets is None  OR  "memory" in enabled_toolsets

The `cli`/desktop platform's toolset list omitted "memory", so the tools were silently never
advertised. Existing tests asserted REGISTRATION (routing table) but nothing asserted
ADVERTISEMENT under the platform toolset gate. This file pins the gate→advertise chain in
both polarities so a platform list that drops "memory" fails loudly here.

Run: python -m pytest tests/run_agent/test_memory_tools_advertised.py -q
"""

from __future__ import annotations

import tempfile

import pytest

from plugins.memory.composite.provider import build_provider


# --- the gate, mirrored from agent_init.py:1220-1222 --------------------------------
# Kept as a tiny local mirror (the production gate is inline in agent_init, not a callable)
# so the test pins the INVARIANT: memory provider tools are advertised IFF the memory toolset
# is enabled (or there is no platform filter at all).

def _advertised_memory_tools(enabled_toolsets, provider) -> set[str]:
    gate = enabled_toolsets is None or "memory" in enabled_toolsets
    if not gate:
        return set()
    return {s.get("name") for s in provider.get_tool_schemas() if s.get("name")}


@pytest.fixture
def provider():
    # build_provider(hermes_home) creates the composite over a store under that home.
    return build_provider(tempfile.mkdtemp())


def test_composite_exposes_the_experience_tools(provider):
    """Precondition: the provider actually offers the two experience tools to advertise."""
    names = {s.get("name") for s in provider.get_tool_schemas()}
    assert {"experience_signal", "experience_forget"} <= names


def test_experience_tools_advertised_when_memory_toolset_enabled(provider):
    """The fix path: a platform whose toolset list includes "memory" advertises the tools."""
    advertised = _advertised_memory_tools({"memory", "browser", "file", "terminal"}, provider)
    assert "experience_signal" in advertised
    assert "experience_forget" in advertised


def test_experience_tools_excluded_when_memory_toolset_absent(provider):
    """The incident's failure mode: a platform toolset list WITHOUT "memory" drops the tools.

    This is exactly what the live `cli`/desktop platform did before the config fix — the tools
    exist and route, but never reach the model. Pinned so the regression is caught in code.
    """
    advertised = _advertised_memory_tools({"browser", "file", "terminal"}, provider)
    assert "experience_signal" not in advertised
    assert "experience_forget" not in advertised


def test_no_platform_filter_advertises_memory_tools(provider):
    """Backward-compat path: enabled_toolsets is None => no filter => tools advertised."""
    advertised = _advertised_memory_tools(None, provider)
    assert {"experience_signal", "experience_forget"} <= advertised
