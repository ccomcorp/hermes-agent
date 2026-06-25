"""D3 — lesson-keyed brain reward pairing tests for ``HermesCompositeProvider``.

Validates the three-event design that wires the agent's self-improvement loop into the
brain so a LATER real outcome reinforces the recalled LESSON's synapses (not the last turn):

  * Event 1 (authoring): ``on_background_review`` OBSERVES each stored lesson, fires NO reward.
  * Event 2 (recall):    ``recall_for`` re-observes served lessons on a BACKGROUND worker,
                         keying the fresh observation_id by lesson ref in a bounded map.
  * Event 3 (outcome):   ``handle_tool_call`` prefers the lesson-keyed observation; falls back
                         to the session-turn observation (``_last_observation``) with zero
                         regression for non-lesson signals.

The Event-2 re-observe is dispatched OFF the synchronous recall path, so tests call
``p._flush_observes()`` after ``recall_for`` before asserting on ``_lesson_observation``.

Uses a ``SeqBrain`` spy that returns a DISTINCT observation_id per observe + an in-memory
store. No network.

Run: python -m pytest plugins/memory/composite/tests/test_d3_lesson_keyed_pairing.py -q
"""

from __future__ import annotations

import json
import threading

from store import ExperienceStore
from backends import BRAIN_OK
from plugins.memory.composite.provider import HermesCompositeProvider


class SeqBrain:
    """Brain spy: unique observation_id per observe, tagged by content type, so tests can
    prove WHICH observation a reward paired against. Thread-safe counter (the re-observe
    runs on a background worker)."""

    def __init__(self):
        self.observe_calls = []
        self.reward_calls = []
        self.prefetch_calls = []
        self._n = 0
        self._lock = threading.Lock()
        self._last_reward_dW = 0.5
        self._brain_dW_total = 0.0

    def brain_dW_total(self):
        return self._brain_dW_total

    def prefetch(self, query):
        self.prefetch_calls.append(query)
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


def _provider(brain, stage):
    store = ExperienceStore(db_path=":memory:")
    p = HermesCompositeProvider(store=store, brain=brain, owns_brain=False, brain_stage=stage)
    p.initialize("S1")
    return p


def _recall(p, query):
    """recall_for then drain the background re-observe so the map is settled for asserts."""
    block, rid = p.recall_for("pre-delegation", query)
    p._flush_observes()
    return block, rid


def _signal(p, ref, valence, derivation="task_completed", session_id="S1"):
    out = p.handle_tool_call(
        "experience_signal",
        {"ref": ref, "valence": valence, "derivation": derivation},
        session_id=session_id,
    )
    return json.loads(out)


# --- Event 1: authoring observes, never rewards -------------------------------------

def test_authoring_observes_lesson_text_and_fires_no_reward():
    brain = SeqBrain()
    p = _provider(brain, stage=2)  # even at the reward-capable stage, authoring must not reward
    n = p.on_background_review(
        [{"lesson": "distilled lesson body", "provenance": "fork:t", "task_type": "workflow",
          "tags": ["fork"]}],
        session_id="S1",
    )
    p._flush_rewards()
    assert n == 1
    assert len(brain.observe_calls) == 1
    assert brain.observe_calls[0]["record"]["type"] == "text"
    assert "distilled lesson body" in brain.observe_calls[0]["record"]["content"]
    assert p._review_observe_count == 1
    assert brain.reward_calls == []  # NO reward at authoring (no RPE baseline saturation)


def test_authoring_failed_store_skips_observe():
    brain = SeqBrain()
    p = _provider(brain, stage=2)
    n = p.on_background_review([{"provenance": "fork:t"}], session_id="S1")
    p._flush_rewards()
    assert n == 0
    assert brain.observe_calls == []  # did not observe a lesson that failed to store


# --- Event 2 + 3: recall re-observes, outcome pairs to the LESSON's observation ------

def test_outcome_pairs_to_recalled_lesson_observation_not_turn():
    brain = SeqBrain()
    p = _provider(brain, stage=2)
    ref = p.record_fork_lesson("a recallable lesson", provenance="fork:t")

    p.sync_turn("u", "assistant text", session_id="S1")
    turn_obs = brain.observe_calls[-1]["obs_id"]
    assert turn_obs.startswith("obs-context-")

    block, _rid = _recall(p, "recallable")
    assert block
    recall_obs = p._lesson_observation.get(ref)
    assert recall_obs is not None and recall_obs.startswith("obs-text-")

    _signal(p, ref, 1.0, derivation="test_result")
    p._flush_rewards()
    assert len(brain.reward_calls) == 1
    call = brain.reward_calls[0]
    assert call["observation_id"] == recall_obs       # the LESSON's synapses, not the turn's
    assert call["observation_id"] != turn_obs
    assert call["ref"] == ref
    assert call["valence"] == 1.0
    assert ref not in p._lesson_observation           # one-shot consumed


def test_outcome_falls_back_to_turn_observation_when_lesson_not_recalled():
    brain = SeqBrain()
    p = _provider(brain, stage=2)
    ref = p.record_fork_lesson("never recalled here", provenance="fork:t")

    p.sync_turn("u", "assistant text", session_id="S1")
    turn_obs = brain.observe_calls[-1]["obs_id"]
    assert ref not in p._lesson_observation

    _signal(p, ref, 0.8)
    p._flush_rewards()
    assert len(brain.reward_calls) == 1
    assert brain.reward_calls[0]["observation_id"] == turn_obs  # zero regression (pre-D3)


def test_double_recall_before_outcome_keeps_only_latest_and_rewards_once():
    """AC5 coverage: the same ref recalled twice before any outcome keeps ONLY the second
    observation_id (one entry per ref), and exactly ONE reward fires, paired to that second
    observation. The first (stale) observation is dropped (its trace decays unrewarded)."""
    brain = SeqBrain()
    p = _provider(brain, stage=2)
    ref = p.record_fork_lesson("a twice-recalled lesson", provenance="fork:t")

    _recall(p, "twice")
    first_obs = p._lesson_observation.get(ref)
    _recall(p, "twice")
    second_obs = p._lesson_observation.get(ref)

    assert first_obs is not None and second_obs is not None
    assert first_obs != second_obs                    # a fresh observation each recall
    assert second_obs.startswith("obs-text-")
    # only ONE entry for the ref, holding the LATEST observation
    assert list(p._lesson_observation).count(ref) == 1
    assert p._lesson_observation[ref] == second_obs

    _signal(p, ref, 1.0, derivation="test_result")
    p._flush_rewards()
    assert len(brain.reward_calls) == 1               # exactly one reward (one-shot)
    assert brain.reward_calls[0]["observation_id"] == second_obs  # the latest, not the stale
    assert ref not in p._lesson_observation


def test_stale_unconsumed_stash_is_bounded_not_pinned():
    """A lesson recalled (stashed) whose outcome never names its ref must not pin forever:
    the bounded FIFO evicts it once the map exceeds _LESSON_OBS_MAX."""
    brain = SeqBrain()
    p = _provider(brain, stage=1)
    p._LESSON_OBS_MAX = 3
    for i in range(5):
        p.record_fork_lesson(f"lesson number {i} body", provenance="fork:t")
    for i in range(5):
        _recall(p, f"number {i}")
    assert len(p._lesson_observation) <= 3            # evicted, never pinned


def test_recall_reobserve_is_best_effort_on_brain_fault():
    class BoomBrain(SeqBrain):
        def observe(self, record):
            if record.get("type") == "text":
                raise RuntimeError("brain down")
            return super().observe(record)

    brain = BoomBrain()
    p = _provider(brain, stage=1)
    p.record_fork_lesson("lesson that will recall", provenance="fork:t")
    block, rid = _recall(p, "recall")
    assert block       # recall not broken by the brain fault
    assert rid
    assert p._lesson_observation == {}  # nothing stashed (observe failed), no crash


def test_recall_does_not_block_on_slow_brain():
    """Event 2 must be OFF the synchronous recall path: recall_for returns promptly even if
    brain.observe is slow (proven by recall_for returning BEFORE the re-observe is flushed)."""
    gate = threading.Event()

    class SlowBrain(SeqBrain):
        def observe(self, record):
            if record.get("type") == "text":
                gate.wait(5.0)  # block the re-observe worker
            return super().observe(record)

    brain = SlowBrain()
    p = _provider(brain, stage=1)
    p.record_fork_lesson("slow lesson", provenance="fork:t")
    # recall_for returns immediately even though the background observe is gated
    block, rid = p.recall_for("pre-delegation", "slow")
    assert rid                                  # returned without waiting on the brain
    assert p._lesson_observation == {}          # worker still blocked -> not yet stashed
    gate.set()
    p._flush_observes()                          # now let it finish
