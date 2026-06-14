"""Staging + paired-reward tests for ``HermesCompositeProvider``.

Validates the brain-add-on corrections from the elicitation:
  * stage gates: 1 = observe+recall (NO reward); 2 = + paired reward.
  * reward fires only from ``handle_tool_call(experience_signal)`` (never ``sync_turn``) — C3.
  * the brain ``observation_id`` is captured from ``observe`` and carried into ``reward``.
  * the SIGNED valence reaches the reward (failures punish); valence==0 skips reward.
  * one-shot: the stashed id is popped on reward (no double-credit).
  * the reward runs OFF the turn thread (handle_tool_call returns without awaiting it).

Uses a ``FakeBrain`` spy + an in-memory store — no network.
Run: python -m pytest plugins/memory/composite/tests/test_brain_staging.py -q
"""

from __future__ import annotations

import json
import threading

import pytest

from store import ExperienceStore
from backends import BRAIN_OK
from plugins.memory.composite.provider import HermesCompositeProvider


class FakeBrain:
    def __init__(self, obs_id="obs-uuid-1", reward_status=BRAIN_OK, block_reward=False):
        self.obs_id = obs_id
        self.reward_status = reward_status
        self.observe_calls = []
        self.prefetch_calls = []
        self.reward_calls = []
        self._gate = threading.Event() if block_reward else None

    def prefetch(self, query):
        self.prefetch_calls.append(query)
        return []

    def observe(self, record):
        self.observe_calls.append(record)
        return self.obs_id

    def reward(self, ref="", *, valence, derivation, observation_id=None, session_id=""):
        if self._gate is not None:
            self._gate.wait(5.0)  # simulate a slow brain to prove non-blocking
        self.reward_calls.append({
            "ref": ref, "valence": valence, "derivation": derivation,
            "observation_id": observation_id, "session_id": session_id,
        })
        return self.reward_status

    def close(self):
        pass


def _provider(brain, stage):
    store = ExperienceStore(db_path=":memory:")
    p = HermesCompositeProvider(store=store, brain=brain, owns_brain=False, brain_stage=stage)
    p.initialize("S1")
    return p


def _signal(p, ref, valence, derivation="task_completed", session_id="S1"):
    out = p.handle_tool_call("experience_signal",
                             {"ref": ref, "valence": valence, "derivation": derivation},
                             session_id=session_id)
    return json.loads(out)


# --- stage 1: observe + recall, NO reward -------------------------------------------

def test_stage1_sync_turn_observes_and_stashes_but_no_reward_on_signal():
    brain = FakeBrain()
    p = _provider(brain, stage=1)
    ref = p.record_fork_lesson("lesson body", provenance="t")
    p.sync_turn("u", "a", session_id="S1")
    assert len(brain.observe_calls) == 1               # observed
    res = _signal(p, ref, 0.7)
    p._flush_rewards()
    assert "error" not in res                           # store signal succeeded
    assert brain.reward_calls == []                     # stage 1 => NO brain reward


# --- stage 2: paired reward fires, signed, one-shot ---------------------------------

def test_stage2_signal_fires_paired_signed_reward():
    brain = FakeBrain()
    p = _provider(brain, stage=2)
    ref = p.record_fork_lesson("lesson body", provenance="t")
    p.sync_turn("u", "a", session_id="S1")              # stashes obs-uuid-1
    _signal(p, ref, 0.7)
    p._flush_rewards()
    assert len(brain.reward_calls) == 1
    call = brain.reward_calls[0]
    assert call["observation_id"] == "obs-uuid-1"       # paired with the captured id
    assert call["valence"] == 0.7                        # signed value carried


def test_stage2_negative_valence_is_carried_for_punishment():
    brain = FakeBrain()
    p = _provider(brain, stage=2)
    ref = p.record_fork_lesson("lesson body", provenance="t")
    p.sync_turn("u", "a", session_id="S1")
    _signal(p, ref, -0.9, derivation="test_result")
    p._flush_rewards()
    assert brain.reward_calls[0]["valence"] == -0.9      # failure punishes, not dropped


def test_stage2_neutral_valence_skips_reward():
    brain = FakeBrain()
    p = _provider(brain, stage=2)
    ref = p.record_fork_lesson("lesson body", provenance="t")
    p.sync_turn("u", "a", session_id="S1")
    _signal(p, ref, 0.0)
    p._flush_rewards()
    assert brain.reward_calls == []                      # neutral is not a reward


def test_stage2_stash_is_popped_one_shot():
    brain = FakeBrain()
    p = _provider(brain, stage=2)
    ref = p.record_fork_lesson("lesson body", provenance="t")
    p.sync_turn("u", "a", session_id="S1")               # one observation stashed
    _signal(p, ref, 0.6)
    _signal(p, ref, 0.6)                                  # second signal, no fresh observe
    p._flush_rewards()
    assert len(brain.reward_calls) == 1, "second signal must not re-credit a popped id"


def test_stage2_signal_without_prior_observe_does_not_pair():
    brain = FakeBrain()
    p = _provider(brain, stage=2)
    ref = p.record_fork_lesson("lesson body", provenance="t")
    # no sync_turn -> nothing stashed
    _signal(p, ref, 0.6)
    p._flush_rewards()
    # either no reward, or a reward with observation_id=None (legacy path) — never a crash
    assert all(c["observation_id"] is None for c in brain.reward_calls)


# --- R4: reward must NOT block the turn-thread handle_tool_call ----------------------

def test_stage2_reward_is_off_the_turn_thread():
    brain = FakeBrain(block_reward=True)                 # reward blocks until released
    p = _provider(brain, stage=2)
    ref = p.record_fork_lesson("lesson body", provenance="t")
    p.sync_turn("u", "a", session_id="S1")
    # handle_tool_call must return promptly even though brain.reward is blocked
    res = _signal(p, ref, 0.7)
    assert "error" not in res                            # store result returned now
    assert res["ack"]["brain"] == "pending"              # reward backgrounded, not awaited
    brain._gate.set()                                    # release the blocked reward
    p._flush_rewards()
    assert len(brain.reward_calls) == 1


# --- session lifecycle clears the stash ---------------------------------------------

def test_session_end_clears_pending_observation():
    brain = FakeBrain()
    p = _provider(brain, stage=2)
    p.sync_turn("u", "a", session_id="S1")
    p.on_session_end([])
    assert p._last_observation.get("S1") is None
