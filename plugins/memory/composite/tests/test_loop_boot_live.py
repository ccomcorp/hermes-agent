"""AC-PX5 #2 LIVE-BOOT SAFETY GATE — the live config must boot clean.

The worst outcome of the boot wiring assertion is a FALSE POSITIVE: a raise on a correctly
wired boot would prevent the live desktop from starting. This test constructs the provider
exactly as ``build_provider`` does (under a HERMES_HOME), wires it through a REAL
``MemoryManager`` as ``initialize_all`` does, and asserts ``initialize()`` does NOT raise.

Brain stage is forced to 0 so no network is touched (the boot assertion is independent of the
brain leg). The store is opened against a temp HERMES_HOME so no live ``experience.db`` moves.
"""

from __future__ import annotations

import os

from agent.memory_manager import MemoryManager
from plugins.memory.composite.provider import build_provider


def test_live_build_provider_initialize_does_not_raise(tmp_path, monkeypatch):
    """build_provider(...) + MemoryManager.initialize_all wiring -> initialize() clean."""
    monkeypatch.setenv("HERMES_BRAIN_STAGE", "0")  # no brain, no network at build
    hermes_home = str(tmp_path)

    provider = build_provider(hermes_home)

    # Wire exactly as agent_init -> MemoryManager.initialize_all does.
    manager = MemoryManager()
    manager.add_provider(provider)

    # Must NOT raise (LoopWiringError or otherwise). A raise here means the live boot would
    # have been blocked — the false-positive failure mode we guard against.
    manager.initialize_all(
        session_id="live-boot-safety",
        platform="cli",
        hermes_home=hermes_home,
        agent_context="primary",
    )

    # Sanity: the store was opened lazily in initialize (D1), so the provider is live.
    assert provider._store is not None
    assert os.path.isdir(hermes_home)


def test_initialize_directly_clean_with_class_fallback(tmp_path, monkeypatch):
    """Calling initialize() WITHOUT threading a manager still passes (class-surface fallback)."""
    monkeypatch.setenv("HERMES_BRAIN_STAGE", "0")
    provider = build_provider(str(tmp_path))
    # No memory_manager kwarg -> falls back to verifying the MemoryManager class dispatch.
    provider.initialize("live-boot-class-fallback")
    assert provider._store is not None
