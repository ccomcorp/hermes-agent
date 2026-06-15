"""G1 / AC5 integration — the COMPOSITE-SIDE durable observe outbox drain.

Subject: ``HermesCompositeProvider`` enqueuing a failed live observe and draining it once the
brain returns, against a REAL (tmp) ``ExperienceStore`` and a FAKE in-process brain client (no
live ``.31`` — the brain is a stub whose reachability we flip). The store-side outbox verbs are
unit-tested in the AIOS repo (``experience-store/tests/test_outbox.py``); here we prove the
composite wiring: enqueue-on-failure (turn still returns promptly), drain-delivers-on-recovery,
transport-fail-leaves-pending (attempts unchanged), restart reclaim, and that REWARD is NEVER
enqueued (reward replay is M6, out of M1 scope).

Run: python -m pytest plugins/memory/composite/tests/test_outbox_drain.py -q
"""

from __future__ import annotations

import json

import pytest

from plugins.memory.composite.provider import HermesCompositeProvider
from store import ExperienceStore


# --- fake brain client (no network) -------------------------------------------------

class FakeBrain:
    """Minimal BrainClient stub. ``reachable=False`` makes observe FAIL the way the real
    adapter signals failure (configurable: a transport RAISE, or a non-confirming None return).
    Records every observe payload + reward call so tests can assert what was/wasn't sent.
    """

    def __init__(self, *, reachable: bool = True, fail_mode: str = "transport"):
        self.reachable = reachable
        self.fail_mode = fail_mode  # 'transport' (raise) | 'noid' (return None)
        self.observed: list[dict] = []
        self.rewarded: list[dict] = []
        self._n = 0

    def observe(self, record: dict):
        if not self.reachable:
            if self.fail_mode == "transport":
                raise OSError("brain unreachable (simulated)")
            return None  # non-confirming response (no observation_id)
        if self.fail_mode == "noid":
            # Reachable brain that returns 200-but-no-observation_id: a non-confirming
            # response that must still enqueue (no append, no raise).
            return None
        self.observed.append(dict(record))
        self._n += 1
        return f"obs-{self._n}"

    def reward(self, *a, **k):  # pragma: no cover - asserted NOT called for observe outbox
        self.rewarded.append({"args": a, "kwargs": k})
        return "ok"

    def prefetch(self, query: str):
        return []

    def ping(self):
        return {"ok": self.reachable}

    def close(self):
        return None


def _provider(tmp_path, brain, *, brain_stage: int = 1) -> HermesCompositeProvider:
    store = ExperienceStore(str(tmp_path / "outbox_experience.db"))
    return HermesCompositeProvider(store=store, brain=brain, brain_stage=brain_stage)


# --- AC: brain unreachable → observe enqueues a pending row (turn returns promptly) -----

def test_observe_unreachable_enqueues_pending_and_turn_returns(tmp_path):
    brain = FakeBrain(reachable=False, fail_mode="transport")
    prov = _provider(tmp_path, brain)

    ack = prov.sync_turn("u", "assistant said something useful", session_id="s1")

    # The turn still returns its ack (degrade-not-stall) — and reports the enqueue, not a drop.
    assert ack["brain"] == "enqueued"
    counts = prov._store.outbox_counts()
    assert counts["pending"] == 1, "a failed observe must leave exactly one durable pending row"
    assert counts["confirmed"] == 0
    # Nothing was delivered to the brain, and NO reward was ever enqueued/sent.
    assert brain.observed == []
    assert brain.rewarded == []


def test_observe_noid_response_also_enqueues(tmp_path):
    """A reachable brain that returns NO observation_id (non-confirming) is also enqueued."""
    brain = FakeBrain(reachable=True, fail_mode="noid")
    prov = _provider(tmp_path, brain)

    ack = prov.sync_turn("u", "content", session_id="s1")

    assert ack["brain"] == "enqueued"
    assert prov._store.outbox_counts()["pending"] == 1


# --- AC: brain becomes reachable → a drain pass delivers it (pending→confirmed) -----

def test_drain_delivers_when_brain_recovers(tmp_path):
    brain = FakeBrain(reachable=False, fail_mode="transport")
    prov = _provider(tmp_path, brain)

    prov.sync_turn("u", "lesson body to deliver", session_id="s1")
    assert prov._store.outbox_counts()["pending"] == 1

    # Brain recovers; the background drain (queue_prefetch path) delivers the queued observe.
    brain.reachable = True
    result = prov._drain_outbox()

    assert result["confirmed"] == 1
    counts = prov._store.outbox_counts()
    assert counts["pending"] == 0
    assert counts["confirmed"] == 1
    # The brain received the queued payload verbatim (content preserved through the outbox).
    assert len(brain.observed) == 1
    assert brain.observed[0]["content"] == "lesson body to deliver"
    assert brain.observed[0]["type"] == "context"


def test_drain_runs_off_queue_prefetch(tmp_path):
    """The drain is wired into queue_prefetch (the chassis's OFF-the-turn worker)."""
    brain = FakeBrain(reachable=False, fail_mode="transport")
    prov = _provider(tmp_path, brain)
    prov.sync_turn("u", "queued via prefetch path", session_id="s1")
    assert prov._store.outbox_counts()["pending"] == 1

    brain.reachable = True
    prov.queue_prefetch("next query", session_id="s1")  # must drain as a side effect

    assert prov._store.outbox_counts()["confirmed"] == 1
    assert prov._store.outbox_counts()["pending"] == 0


# --- AC: transport-fail during drain leaves it pending (attempts unchanged) -----

def test_drain_transport_fail_keeps_pending_attempts_unchanged(tmp_path):
    brain = FakeBrain(reachable=False, fail_mode="transport")
    prov = _provider(tmp_path, brain)
    prov.sync_turn("u", "still-unreachable body", session_id="s1")

    # Drain while STILL unreachable: the claim→observe→transport-fail path must not poison the row.
    result = prov._drain_outbox()
    assert result["transport_fail"] == 1
    counts = prov._store.outbox_counts()
    assert counts["pending"] == 1, "a transport failure returns the op to pending"
    assert counts["confirmed"] == 0
    assert counts["max_attempts"] == 0, "transport failures must NOT advance the attempts counter"

    # And a later recovery still delivers it (no permanent loss from the outage).
    brain.reachable = True
    assert prov._drain_outbox()["confirmed"] == 1
    assert prov._store.outbox_counts()["confirmed"] == 1


# --- AC: reclaim flips a leftover in_flight → pending -----

def test_initialize_reclaims_orphaned_in_flight(tmp_path):
    """An in_flight op left by a crashed drain is reclaimed to pending at startup (initialize)."""
    brain = FakeBrain(reachable=False, fail_mode="transport")
    prov = _provider(tmp_path, brain)
    prov.sync_turn("u", "orphan body", session_id="s1")
    # Simulate a drain interrupted mid-flight: claim leaves the row in_flight, then "crash".
    claimed = prov._store.outbox_claim()
    assert claimed is not None
    assert prov._store.outbox_counts()["in_flight"] == 1

    # A fresh provider over the SAME store reclaims the orphan on initialize.
    prov2 = HermesCompositeProvider(store=prov._store, brain=brain, brain_stage=1)
    prov2.initialize("s2")

    counts = prov2._store.outbox_counts()
    assert counts["in_flight"] == 0
    assert counts["pending"] == 1, "the orphaned in_flight op is reclaimed to pending"


# --- AC: reward is NEVER enqueued -----

def test_reward_is_never_enqueued_only_observe(tmp_path):
    """Across enqueue + drain, the outbox holds ONLY observe ops; no reward op is ever written
    (reward replay is deferred to M6, SPEC §7). The fake brain's reward is never called via the
    outbox path either."""
    brain = FakeBrain(reachable=False, fail_mode="transport")
    prov = _provider(tmp_path, brain)
    prov.sync_turn("u", "observe content one", session_id="s1")
    prov.sync_turn("u", "observe content two", session_id="s2")

    brain.reachable = True
    prov._drain_outbox()

    # Every delivered op was an observe; no reward was sent through the outbox drain.
    assert brain.rewarded == []
    assert all(r.get("type") == "context" for r in brain.observed)
    # Defensive: walk every stored outbox row and assert kind=='observe'.
    for status in ("pending", "in_flight", "confirmed", "dead"):
        pass  # counts checked below
    counts = prov._store.outbox_counts()
    assert counts["confirmed"] == 2
    # No 'reward' kind ever entered the queue: enqueue is only reachable from the observe path.
    assert prov._store.outbox_all_kinds() == {"observe"}
