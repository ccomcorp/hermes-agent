"""Composite memory provider plugin entry point.

Activated via ``memory.provider: composite`` in config.yaml. The chassis plugin loader
(:mod:`plugins.memory`) calls :func:`register` with a collector exposing
``register_memory_provider``.

NOTE (M1 Task 2 gating): per the integration handoff, do NOT flip
``memory.provider: composite`` in config.yaml until ALL pre-binding Sev-5/Sev-4 blockers
are resolved. This package existing does not register the provider on its own — the
config key does. The fork-append path (BLOCKER #2) routes through whatever composite is
registered and degrades to a no-op when none is, so it is safe to ship ahead of the flip.
"""

from __future__ import annotations

from agent.memory_provider import MemoryProvider  # noqa: F401  (loader heuristic marker)


def register(ctx) -> None:
    """Build the composite over the active HERMES_HOME and register it."""
    from hermes_constants import get_hermes_home

    from .provider import build_provider

    provider = build_provider(str(get_hermes_home()))
    ctx.register_memory_provider(provider)
