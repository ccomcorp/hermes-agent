"""AC-PX5 #3: present-but-unproductive runtime backstop (loop_self_check).

A write-only store (lessons stored, circulation 0) must trip a logger.ERROR + flip the
loop-health status to ``write-only-alarm`` after K consecutive session-end checks. A
circulating store stays quiet. A fresh/empty store (below the floor / 0 lessons) never trips.
"""

from __future__ import annotations

import logging

import pytest

from plugins.memory.composite.provider import ExperienceStore, HermesCompositeProvider


def _provider(store):
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize("loop-self-check")
    return comp


def _seed_write_only(store, n=3):
    """Append n fork-authored lessons that are NEVER recalled -> circulation 0, total>0."""
    for i in range(n):
        store.append(
            {
                "lesson": f"write-only lesson {i} about subsystem alpha-{i}",
                "task_type": "workflow",
                "tags": ["fork", "background_review"],
                "provenance": f"fork:test:{i}",
                "source": "reviewed",
                "migrated": False,
            }
        )


def test_write_only_store_trips_error_after_k(caplog):
    """K=2 default: 2 consecutive write-only session-ends -> ERROR + alarm flip."""
    store = ExperienceStore(db_path=":memory:")
    comp = _provider(store)
    _seed_write_only(store, n=3)

    # First check: write-only detected, streak=1, no alarm yet (K=2).
    r1 = comp.loop_self_check()
    assert r1["checked"] is True
    assert r1["write_only"] is True
    assert r1["streak"] == 1
    assert r1["alarm"] is False
    assert comp.loop_health()["status"] == "write-only"

    # Second check via the real on_session_end hook -> reaches K -> ERROR + alarm.
    with caplog.at_level(logging.ERROR):
        comp.on_session_end([])
    assert comp._writeonly_streak >= 2
    health = comp.loop_health()
    assert health["status"] == "write-only-alarm"
    assert health["write_only_alarm"] is True
    assert any("LOOP WRITE-ONLY" in rec.message for rec in caplog.records)


def test_circulating_store_stays_quiet(caplog):
    """A store with a fork lesson recalled + consumed -> circulation>0 -> no alarm, no ERROR."""
    store = ExperienceStore(db_path=":memory:")
    comp = _provider(store)
    # Author a fork lesson, then recall + confirm-consume it (circulation>0).
    store.append(
        {
            "lesson": "circulating lesson about the gizmo calibration ritual",
            "task_type": "workflow",
            "tags": ["fork"],
            "provenance": "fork:test:circ",
            "source": "reviewed",
            "migrated": False,
        }
    )
    ctx = comp.prefetch("gizmo calibration ritual")
    assert ctx
    comp.confirm_prefetch_consumed()

    with caplog.at_level(logging.ERROR):
        r = comp.loop_self_check()
        comp.on_session_end([])
    assert r["checked"] is True
    assert r["write_only"] is False
    assert comp.loop_health()["status"] == "ok"
    assert not any("LOOP WRITE-ONLY" in rec.message for rec in caplog.records)


def test_fresh_store_is_quiet(caplog):
    """An empty store (0 lessons) -> WRITE_ONLY_MEMORY inactive -> never trips."""
    store = ExperienceStore(db_path=":memory:")
    comp = _provider(store)
    with caplog.at_level(logging.ERROR):
        for _ in range(5):
            comp.loop_self_check()
    assert comp.loop_health()["status"] == "ok"
    assert comp._writeonly_streak == 0
    assert not any("LOOP WRITE-ONLY" in rec.message for rec in caplog.records)


def test_floor_suppresses_small_corpus(monkeypatch):
    """With a floor above the corpus size, a write-only store does NOT trip."""
    store = ExperienceStore(db_path=":memory:")
    comp = _provider(store)
    comp._loop_writeonly_floor = 10  # corpus of 3 is below the floor
    _seed_write_only(store, n=3)
    r = comp.loop_self_check()
    assert r["checked"] is True
    assert r["write_only"] is False  # below floor -> not a pathology
    assert comp.loop_health()["status"] == "ok"


def test_streak_resets_when_loop_recovers():
    """A write-only streak resets to 0 + clears the alarm once circulation returns."""
    store = ExperienceStore(db_path=":memory:")
    comp = _provider(store)
    comp._loop_writeonly_k = 1  # trip on first write-only check
    _seed_write_only(store, n=2)
    comp.loop_self_check()
    assert comp.loop_health()["status"] == "write-only-alarm"

    # Now recall + consume one lesson so circulation>0; next check clears the alarm.
    ctx = comp.prefetch("subsystem alpha-0")
    assert ctx
    comp.confirm_prefetch_consumed()
    r = comp.loop_self_check()
    assert r["write_only"] is False
    assert comp.loop_health()["status"] == "ok"
    assert comp._writeonly_streak == 0
