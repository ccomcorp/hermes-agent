"""Test on_memory_write non-primary guard — AC-PX5 #1.

The composite provider's ``on_memory_write`` must skip store + brain mirroring
for every production non-primary agent context (cron, subagent, flush). Only the
foreground user session's memory writes should be mirrored.
"""

from __future__ import annotations

import pytest

try:
    from plugins.memory.composite.provider import ExperienceStore, HermesCompositeProvider
    _HAVE_AIOS = True
except Exception:
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(not _HAVE_AIOS, reason="AIOS composite/store not importable")


def _make_comp(agent_context="primary"):
    store = ExperienceStore(db_path=":memory:")
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize("s", agent_context=agent_context)
    return store, comp


def test_on_memory_write_primary_mirrors_normally():
    """Primary context: on_memory_write should proceed without error."""
    store, comp = _make_comp("primary")
    before = len(list(store.iter_lessons()))
    comp.on_memory_write("add", "memory", "User prefers dark mode", {"source": "tool"})
    after = len(list(store.iter_lessons()))
    assert after > before, f"Expected a new lesson, got {after} (was {before})"


def test_on_memory_write_non_primary_is_skipped():
    """Non-primary contexts must return immediately without writing anything."""
    for ctx in ("cron", "subagent", "flush"):
        store, comp = _make_comp(ctx)
        before = len(list(store.iter_lessons()))
        comp.on_memory_write("add", "memory", f"Write from {ctx}", {"source": "tool"})
        after = len(list(store.iter_lessons()))
        assert after == before, (
            f"'{ctx}' context should not mirror memory writes, "
            f"but store grew from {before} to {after}"
        )


def test_on_memory_write_remove_non_primary_is_skipped():
    """Remove action in non-primary context is also skipped."""
    store, comp = _make_comp("cron")
    before = len(list(store.iter_lessons()))
    comp.on_memory_write("remove", "memory", "", {"source": "tool", "old_text": "stale"})
    after = len(list(store.iter_lessons()))
    assert after == before
