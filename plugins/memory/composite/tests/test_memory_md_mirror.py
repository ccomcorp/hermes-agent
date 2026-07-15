"""MEMORY.md → composite store + NeuroLinked observe (on_memory_write).

Chassis already calls MemoryManager.notify_memory_tool_write after a successful
built-in memory tool commit. This suite proves the composite provider mirrors
those writes into experience.db + brain.observe — never reward.

Run: python -m pytest plugins/memory/composite/tests/test_memory_md_mirror.py -q
"""

from __future__ import annotations

import json
import threading

from store import ExperienceStore
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


def test_add_mirrors_to_store_and_brain_no_reward():
    p, brain = _provider(stage=2)
    p.on_memory_write("add", "memory", "HARD RULE: always use dedicated *_test DB")
    p._flush_rewards()

    assert len(brain.observe_calls) == 1
    assert "HARD RULE" in brain.observe_calls[0]["record"]["content"]
    assert "MEMORY.md" in brain.observe_calls[0]["record"]["content"]
    assert brain.reward_calls == []
    assert p.loop_health()["memory_md_observe_count"] == 1

    # Store can recall it
    block, rid = p.recall_for("pre-delegation", "HARD RULE dedicated test")
    p._flush_observes()
    assert block
    assert "HARD RULE" in block


def test_replace_mirrors_new_content():
    p, brain = _provider(stage=1)
    p.on_memory_write("replace", "memory", "updated canvas rule: index.html only")
    assert len(brain.observe_calls) == 1
    assert "updated canvas rule" in brain.observe_calls[0]["record"]["content"]
    assert brain.reward_calls == []


def test_remove_observes_tombstone_without_store_growth():
    p, brain = _provider(stage=2)
    # seed one real entry first
    p.on_memory_write("add", "memory", "keep this")
    before_n = p.loop_health()["memory_md_observe_count"]
    p.on_memory_write(
        "remove", "memory", "",
        metadata={"old_text": "stale preference entry"},
    )
    assert p.loop_health()["memory_md_observe_count"] == before_n + 1
    assert any("remove" in c["record"]["content"] and "stale preference" in c["record"]["content"]
               for c in brain.observe_calls)
    assert brain.reward_calls == []


def test_stage0_skips_brain_still_writes_store():
    p, brain = _provider(stage=0)
    p.on_memory_write("add", "user", "User prefers concise responses")
    assert brain.observe_calls == []
    assert p.loop_health()["memory_md_observe_count"] == 0
    block, _ = p.recall_for("pre-delegation", "concise responses")
    p._flush_observes()
    assert "concise" in block


def test_empty_content_is_noop():
    p, brain = _provider(stage=2)
    p.on_memory_write("add", "memory", "   ")
    assert brain.observe_calls == []
    assert p.loop_health()["memory_md_observe_count"] == 0


def test_manager_bridge_reaches_composite():
    """End-to-end: MemoryManager.notify → composite on_memory_write."""
    p, brain = _provider(stage=2)
    mgr = MemoryManager()
    mgr.add_provider(p)
    mgr.notify_memory_tool_write(
        json.dumps({"success": True}),
        {
            "action": "add",
            "target": "memory",
            "content": "FILE PLACEMENT: hermes-projects only",
        },
    )
    assert p.loop_health()["memory_md_observe_count"] == 1
    assert any("FILE PLACEMENT" in c["record"]["content"] for c in brain.observe_calls)
    assert brain.reward_calls == []
