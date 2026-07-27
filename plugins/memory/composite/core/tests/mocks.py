"""Mock brain + vault backends for the vendor-native composite core tests (M0-B1).

The brain mock RECORDS whether reward() is ever called — this is the load-bearing assertion
for the anti-constant-valence guarantee (sync_turn must never reward). reward() returns
'degraded' to mimic the NeuroLinked dW=0 state.

Ported from AIOS composite-provider/tests/mocks.py. Uses the vendor copy's backends
(Protocol types) as the implicit interface contract.
"""

from __future__ import annotations

from typing import Any


class MockBrain:
    def __init__(self, *, online: bool = True, prefetch_items: list[dict] | None = None):
        self.online = online
        self._prefetch_items = prefetch_items or []
        self.observe_calls: list[dict] = []
        self.reward_calls: list[dict] = []   # MUST stay empty after sync_turn
        self.prefetch_calls = 0              # MUST be 0 after prefetch() (no inline HTTP)
        self.shutdown_called = False

    def prefetch(self, query: str) -> list[dict[str, Any]]:
        self.prefetch_calls += 1
        return list(self._prefetch_items) if self.online else []

    def observe(self, record: dict[str, Any]) -> bool:
        self.observe_calls.append(record)
        return self.online

    def reward(self, ref: str, *, valence: float, derivation: str) -> str:
        self.reward_calls.append({"ref": ref, "valence": valence, "derivation": derivation})
        return "degraded"  # NeuroLinked dW=0 — never 'ok' in M1

    def shutdown(self) -> None:
        self.shutdown_called = True


class MockVault:
    def __init__(self, *, items: list[dict] | None = None):
        self._items = items or []
        self.recall_calls = 0

    def recall(self, query: str) -> list[dict[str, Any]]:
        self.recall_calls += 1
        return list(self._items)
