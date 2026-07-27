"""Tests for composite.signal_outcome (auto strengthen-learning path)."""

from __future__ import annotations

import json
import threading

from plugins.memory.composite.experience_store import ExperienceStore
from backends import BRAIN_OK
from plugins.memory.composite.provider import HermesCompositeProvider
from agent.memory_manager import MemoryManager


class SeqBrain:
    def __init__(self):
        self.observe_calls = []
        self.reward_calls = []
        self._n = 0
        self._lock = threading.Lock()
        self._last_reward_dW = 0.5
        self._brain_dW_total = 0.0

    def brain_dW_total(self):
        return self._brain_dW_total

    def prefetch(self, query):
        return []

    def observe(self, record):
        with self._lock:
            self._n += 1
            n = self._n
        obs_id = f"obs-{record.get('type')}-{n}"
        self.observe_calls.append({"record": record, "obs_id": obs_id})
        return obs_id

    def reward(self, ref="", *, valence, derivation, observation_id=None, session_id=""):
        self.reward_calls.append({
            "ref": ref, "valence": valence, "derivation": derivation,
            "observation_id": observation_id, "session_id": session_id,
        })
        return BRAIN_OK

    def close(self):
        pass


def _provider(stage=2):
    brain = SeqBrain()
    store = ExperienceStore(db_path=":memory:")
    p = HermesCompositeProvider(store=store, brain=brain, owns_brain=False, brain_stage=stage)
    p.initialize("S1")
    return p, brain


def test_signal_outcome_uses_stashed_lesson_ref():
    p, brain = _provider(stage=2)
    ref = p.record_fork_lesson("gate-related lesson body", provenance="fork:t")
    block, _ = p.recall_for("pre-delegation", "gate-related")
    p._flush_observes()
    assert ref in p._lesson_observation

    out = p.signal_outcome(valence=1.0, derivation="test_result", note="gates ok")
    assert out["ok"] is True
    assert out["signaled"] >= 1
    assert len(brain.reward_calls) == 1
    assert brain.reward_calls[0]["valence"] == 1.0
    assert brain.reward_calls[0]["derivation"] == "test_result"
    # store wins bumped
    rec = p._store.get(ref)
    assert rec["wins"] >= 1


def test_signal_outcome_creates_auto_lesson_when_stash_empty():
    p, brain = _provider(stage=2)
    out = p.signal_outcome(
        valence=-1.0,
        derivation="test_result",
        note="gates failed=1 names=unit",
    )
    assert out["ok"] is True
    assert out["signaled"] >= 1
    assert out.get("created_ref")
    rec = p._store.get(out["created_ref"])
    assert rec is not None
    assert rec["losses"] >= 1
    assert len(brain.reward_calls) == 1
    assert brain.reward_calls[0]["valence"] == -1.0


def test_signal_outcome_neutral_skips():
    p, brain = _provider(stage=2)
    out = p.signal_outcome(valence=0.0, derivation="test_result", note="noop")
    assert out["signaled"] == 0
    assert brain.reward_calls == []


def test_signal_outcome_no_note_no_stash_skips():
    p, brain = _provider(stage=2)
    out = p.signal_outcome(valence=1.0, derivation="task_completed", note="")
    assert out["signaled"] == 0
    assert out.get("skipped") == "no_lesson_context"
    assert brain.reward_calls == []


def test_manager_signal_outcome_fans_out():
    p, brain = _provider(stage=2)
    mgr = MemoryManager()
    mgr.add_provider(p)
    out = mgr.signal_outcome(
        valence=0.8,
        derivation="task_completed",
        note="feedback exit=0 cmd=pytest -q",
    )
    assert out["ok"] is True
    assert out["signaled"] >= 1
    assert brain.reward_calls


def test_engineering_loop_emit_no_agent_is_safe():
    from plugins.engineering_loop.tools import _emit_outcome_signal

    out = _emit_outcome_signal(valence=1.0, derivation="test_result", note="x")
    assert out is not None
    assert out.get("ok") is True
    # no active agent → skip, not crash
    assert out.get("skipped") in ("no_memory_manager", "disabled") or out.get("signaled") == 0
