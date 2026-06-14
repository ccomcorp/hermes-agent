"""M1 Task 2 BLOCKER #5 — sync_turn must not pollute the corpus.

The dev-instance composite stops appending raw conversational turns (the write side of
the predecessor's "write-only memory" death) and skips non-primary agent contexts.
Deliberately-authored lessons (fork review) and delegation observations still land.
"""

from __future__ import annotations

import pytest

try:
    from plugins.memory.composite.provider import ExperienceStore, HermesCompositeProvider

    _HAVE_AIOS = True
except Exception:  # pragma: no cover - sibling AIOS repo absent
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(not _HAVE_AIOS, reason="AIOS composite/store not importable")


def _comp(agent_context="primary"):
    store = ExperienceStore(db_path=":memory:")
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize("s", agent_context=agent_context)
    return store, comp


def test_sync_turn_primary_does_not_append_to_store():
    store, comp = _comp("primary")
    before = len(list(store.iter_lessons()))
    ack = comp.sync_turn("a real user question", "a substantive assistant answer")
    after = len(list(store.iter_lessons()))
    assert after == before  # no raw-turn lesson written
    assert ack["store"] == "skipped"


def test_sync_turn_non_primary_is_skipped_entirely():
    store, comp = _comp("cron")
    ack = comp.sync_turn("cron tick", "cron output that must not enter the user corpus")
    assert ack == {"store": "skipped", "brain": "skipped", "vault": "skipped"}
    assert len(list(store.iter_lessons())) == 0


def test_on_delegation_observation_still_appends():
    # The chosen policy keeps delegation observations — guard that the base path survives.
    store, comp = _comp("primary")
    ack = comp.on_delegation("do the thing", "did the thing", child_session_id="child-1")
    assert ack["store"] == "ok"
    rows = list(store.iter_lessons())
    assert len(rows) == 1
    assert "delegation" in rows[0]["tags"]
    assert rows[0]["migrated"] is False  # observe-only, but still not a seed


def test_fork_authored_still_lands_under_the_gate():
    # The gate must not suppress the deliberate fork-author path (#2).
    store, comp = _comp("primary")
    ref = comp.record_fork_lesson(
        "Deliberate lesson", provenance="fork:background_review:s", task_type="workflow"
    )
    rec = store.get(ref)
    assert rec is not None and rec["source"] == "reviewed" and rec["migrated"] is False
