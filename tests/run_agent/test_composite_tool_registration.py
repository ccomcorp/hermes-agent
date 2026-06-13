"""M1 Task 2 BLOCKER #6 — composite tool names must survive registration.

The chassis silently drops a memory-provider tool whose name collides with
``_HERMES_CORE_TOOLS`` (memory_manager.py:311-319 / get_all_tool_schemas). If
``experience_signal``/``experience_forget`` ever collided, the model would never see
them and outcome-driven valence would be dead — invisibly. This pins that they register
and route through a REAL MemoryManager.
"""

from __future__ import annotations

import pytest

from agent.memory_manager import MemoryManager
from toolsets import _HERMES_CORE_TOOLS

try:
    from plugins.memory.composite.provider import ExperienceStore, HermesCompositeProvider

    _HAVE_AIOS = True
except Exception:  # pragma: no cover - sibling AIOS repo absent
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(not _HAVE_AIOS, reason="AIOS composite/store not importable")

_COMPOSITE_TOOLS = {"experience_signal", "experience_forget"}


def _composite():
    return HermesCompositeProvider(
        ExperienceStore(db_path=":memory:"), brain=None, vault=None, owns_brain=False
    )


def test_composite_tool_names_do_not_collide_with_core():
    assert _COMPOSITE_TOOLS.isdisjoint(set(_HERMES_CORE_TOOLS))


def test_manager_registers_and_routes_composite_tools():
    comp = _composite()
    # Sanity: the composite advertises exactly the two tools.
    advertised = {s["name"] for s in comp.get_tool_schemas()}
    assert _COMPOSITE_TOOLS <= advertised

    manager = MemoryManager()
    manager.add_provider(comp)

    # Neither was dropped — both route, and both appear in the model-facing schema set.
    assert manager.has_tool("experience_signal")
    assert manager.has_tool("experience_forget")
    schema_names = {s["name"] for s in manager.get_all_tool_schemas()}
    assert _COMPOSITE_TOOLS <= schema_names
