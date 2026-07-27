"""Thin, injectable backend clients for the composite provider (M0-B1 vendor copy).

Two of the three composite backends are EXTERNAL services (the NeuroLinked brain and
the vault recall cache). The composite must be unit-testable WITHOUT either of them
running, so each is reached through a tiny duck-typed SYNC interface (the chassis
MemoryProvider contract is synchronous; the chassis backgrounds slow providers on its
own threads). In tests these are replaced by mocks. In the dev instance a real adapter
is injected: a thin blocking-HTTP brain client to the brain endpoint.

Vendored from AIOS packages/memory/composite-provider/backends.py (M0-B1).
No modifications — the backends are pure interfaces with zero project-level dependencies.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class BrainClient(Protocol):
    """Thin SYNC brain interface. Implemented by a real blocking-HTTP adapter in the dev
    instance; mocked in unit tests. Methods degrade gracefully (return, never raise).
    Calls should be reasonably fast — the chassis already isolates providers on its own
    background threads, so a blocking HTTP call here is fine and does not need asyncio."""

    def prefetch(self, query: str) -> list[dict[str, Any]]:
        """Cache-only recall (fast budget). Returns scored items; [] on miss/offline."""
        ...

    def observe(self, record: dict[str, Any]) -> bool:
        """Fire-and-forget observation. Returns True if accepted, False if offline."""
        ...

    def reward(self, ref: str, *, valence: float, derivation: str) -> str:
        """Deliver a reward. Returns a status STRING, not a bool — one of:
          'ok'        synaptic change confirmed (dW>0)         [post-fix only]
          'degraded'  HTTP-200 but dW=0 (NeuroLinked H7 bug)   [current M1 state]
          'fail'      transport/offline failure
        The composite maps this directly into the per-backend ack."""
        ...


@runtime_checkable
class VaultCache(Protocol):
    """Thin SYNC vault recall-cache interface. Read-only fast cache (no writes).
    (Sync to match the sync chassis + the composite's sync call site.)"""

    def recall(self, query: str) -> list[dict[str, Any]]:
        """Fast cache recall. Returns scored items; [] on miss/offline."""
        ...


# Brain reward status constants (mirrors the SPEC).
BRAIN_OK = "ok"
BRAIN_DEGRADED = "degraded"
BRAIN_FAIL = "fail"


__all__ = ["BrainClient", "VaultCache", "BRAIN_OK", "BRAIN_DEGRADED", "BRAIN_FAIL"]
