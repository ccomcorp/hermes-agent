"""M0-B3A: native binding — provider imports from .core + .experience_store.

EVAL-CB3-01: no legacy resolver/path mutation
EVAL-CB3-02: provider store identity is plugins.memory.composite.experience_store.ExperienceStore
EVAL-CB3-03: build+initialize succeeds under absent/unreachable AIOS vars without opening store before initialize
EVAL-CB3-04: native loop_self_check parity (write-only, circulating, fresh-store cases)
"""

from __future__ import annotations

import logging
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

import pytest


# ── CB3-01: no legacy resolver / sys.path mutation ──────────────────────────

def test_provider_has_no_aios_resolver():
    """The provider module must NOT expose _resolve_aios_package_dirs or
    _resolve_aios_health_dir — those are the legacy AIOS path hacks."""
    from plugins.memory.composite import provider

    assert not hasattr(provider, "_resolve_aios_package_dirs"), (
        "EVAL-CB3-01 FAIL: legacy _resolve_aios_package_dirs still present — "
        "provider must use relative imports from .core and .experience_store, not AIOS path resolution"
    )
    assert not hasattr(provider, "_resolve_aios_health_dir"), (
        "EVAL-CB3-01 FAIL: legacy _resolve_aios_health_dir still present"
    )
    # _STORE_DIR / _COMPOSITE_DIR / _HEALTH_DIR are the resolved-path caches
    assert not hasattr(provider, "_STORE_DIR"), (
        "EVAL-CB3-01 FAIL: legacy _STORE_DIR still present"
    )
    assert not hasattr(provider, "_COMPOSITE_DIR"), (
        "EVAL-CB3-01 FAIL: legacy _COMPOSITE_DIR still present"
    )
    assert not hasattr(provider, "_HEALTH_DIR"), (
        "EVAL-CB3-01 FAIL: legacy _HEALTH_DIR still present"
    )


def test_provider_import_does_not_mutate_sys_path():
    """Importing provider MUST NOT insert AIOS package dirs onto sys.path."""
    path_snapshot = list(sys.path)

    # Force reimport to trigger any module-level side effects
    mod = sys.modules.pop("plugins.memory.composite.provider", None)
    # Also pop flat-imported modules that provider may have loaded
    for key in list(sys.modules):
        if key in ("store", "composite_provider", "backends",
                    "experience_health", "loop_guard", "vault_qmd", "brain_http"):
            # Don't remove if they're the native versions
            if key not in ("experience_health",):
                sys.modules.pop(key, None)

    try:
        from plugins.memory.composite import provider as prov  # noqa: F811
    except ImportError as exc:
        # Restore the popped module so subsequent tests work
        if mod is not None:
            sys.modules["plugins.memory.composite.provider"] = mod
        pytest.fail(
            f"EVAL-CB3-01 FAIL: importing provider raised ImportError: {exc} — "
            f"provider must import cleanly without AIOS packages on the path"
        )

    new_entries = [p for p in sys.path if p not in path_snapshot]
    assert not new_entries, (
        f"EVAL-CB3-01 FAIL: provider import added {len(new_entries)} entries to sys.path: "
        f"{new_entries} — provider must not mutate sys.path"
    )


# ── CB3-02: store identity is native ExperienceStore ─────────────────────────

def test_provider_experience_store_identity():
    """The ExperienceStore re-exported by provider MUST be the native
    plugins.memory.composite.experience_store.ExperienceStore."""
    from plugins.memory.composite.experience_store import ExperienceStore as NativeStore
    from plugins.memory.composite.provider import ExperienceStore

    assert ExperienceStore is NativeStore, (
        "EVAL-CB3-02 FAIL: provider.ExperienceStore is not the native store — "
        f"got {ExperienceStore.__module__}.{ExperienceStore.__qualname__}, "
        f"expected plugins.memory.composite.experience_store.store.ExperienceStore"
    )
    assert ExperienceStore.__module__.startswith("plugins.memory.composite.experience_store"), (
        "EVAL-CB3-02 FAIL: ExperienceStore __module__ does not point into native package"
    )


def test_provider_composite_base_identity():
    """CompositeMemoryProvider imported via provider MUST be the native core."""
    from plugins.memory.composite.core import CompositeMemoryProvider as NativeCMP
    from plugins.memory.composite.provider import CompositeMemoryProvider

    assert CompositeMemoryProvider is NativeCMP, (
        "EVAL-CB3-02 FAIL: provider.CompositeMemoryProvider is not the native core"
    )


# ── CB3-03: build + initialize under absent AIOS vars ────────────────────────

def test_build_provider_with_aios_vars_absent():
    """build_provider + initialize must succeed with NO AIOS env vars set and
    MUST NOT open the store before initialize (D1)."""
    tmp = tempfile.mkdtemp(prefix="hermes-b3-")
    try:
        # Scrub AIOS env vars for this test
        saved = {}
        for vk in ("AIOS_PACKAGES_DIR", "AIOS_HEALTH_DIR"):
            saved[vk] = os.environ.pop(vk, None)

        try:
            from plugins.memory.composite.provider import build_provider

            prov = build_provider(tmp)
            assert prov is not None, "EVAL-CB3-03 FAIL: build_provider returned None"

            # D1: store must NOT be open yet (only _db_path set)
            assert prov._store is None, (
                "EVAL-CB3-03 FAIL: store was opened during build_provider — "
                "D1 deferred construction violated"
            )
            assert prov._db_path is not None, (
                "EVAL-CB3-03 FAIL: _db_path not set — deferred construction broken"
            )

            # is_available must return True (we have a path) without opening the store
            assert prov.is_available() is True, (
                "EVAL-CB3-03 FAIL: is_available returned False with a valid db_path"
            )

            # Initialize must open the store
            prov.initialize("b3-test-session")
            assert prov._store is not None, (
                "EVAL-CB3-03 FAIL: initialize did not open the store"
            )

            # Shut down to release SQLite connection (Windows tempdir cleanup)
            prov.shutdown()
        finally:
            # Restore AIOS env vars
            for vk, vv in saved.items():
                if vv is not None:
                    os.environ[vk] = vv
    finally:
        # Best-effort cleanup (Windows may have handles open briefly)
        import shutil
        try:
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass


def test_import_provider_works_without_aios_env():
    """A fresh import of provider MUST succeed with AIOS_PACKAGES_DIR unset
    (the legacy resolver would ImportError)."""
    saved = os.environ.pop("AIOS_PACKAGES_DIR", None)
    try:
        # Force reimport
        sys.modules.pop("plugins.memory.composite.provider", None)
        from plugins.memory.composite import provider  # noqa: F401
    except ImportError as exc:
        pytest.fail(
            f"EVAL-CB3-01 FAIL: import raised ImportError with AIOS_PACKAGES_DIR unset: {exc}"
        )
    finally:
        if saved is not None:
            os.environ["AIOS_PACKAGES_DIR"] = saved


# ── CB3-04: native loop_self_check parity ────────────────────────────────────

def _make_native_store_compat():
    """Build a native :memory: store and a provider using deferred-init D1."""
    from plugins.memory.composite.provider import HermesCompositeProvider

    comp = HermesCompositeProvider(
        None, db_path=":memory:", brain=None, vault=None, owns_brain=False
    )
    comp.initialize("loop-self-check")
    return comp._store, comp


def _seed_write_only(store, n=3):
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


def test_native_write_only_trips_after_k(caplog):
    """EVAL-CB3-04: K=2 consecutive write-only session-ends → ERROR + alarm."""
    store, comp = _make_native_store_compat()
    _seed_write_only(store, n=3)

    # First check: write-only, streak=1, no alarm
    r1 = comp.loop_self_check()
    assert r1["checked"] is True, "EVAL-CB3-04 FAIL: checked not True"
    assert r1["write_only"] is True, (
        f"EVAL-CB3-04 FAIL: write_only not True (got {r1}) — "
        "store has 3 lessons with 0 circulation"
    )
    assert r1["streak"] == 1
    assert r1["alarm"] is False
    assert comp.loop_health()["status"] == "write-only"

    # Second check via on_session_end → K reached → ERROR + alarm
    with caplog.at_level(logging.ERROR):
        comp.on_session_end([])
    assert comp._writeonly_streak >= 2
    health = comp.loop_health()
    assert health["status"] == "write-only-alarm", (
        f"EVAL-CB3-04 FAIL: expected write-only-alarm, got {health['status']}"
    )
    assert health["write_only_alarm"] is True
    assert any("LOOP WRITE-ONLY" in rec.message for rec in caplog.records), (
        "EVAL-CB3-04 FAIL: no LOOP WRITE-ONLY ERROR log emitted"
    )


def test_native_circulating_store_stays_quiet(caplog):
    """EVAL-CB3-04: circulation > 0 → no alarm, no ERROR."""
    store, comp = _make_native_store_compat()
    store.append(
        {
            "lesson": "circulating lesson about gizmo calibration",
            "task_type": "workflow",
            "tags": ["fork"],
            "provenance": "fork:test:circ",
            "source": "reviewed",
            "migrated": False,
        }
    )
    # Recall + consume → circulation > 0
    ctx = comp.prefetch("gizmo calibration")
    assert ctx
    comp.confirm_prefetch_consumed()

    with caplog.at_level(logging.ERROR):
        r = comp.loop_self_check()
    assert r["checked"] is True
    assert r["write_only"] is False, (
        f"EVAL-CB3-04 FAIL: expected write_only=False with circulation>0, got {r}"
    )
    assert comp.loop_health()["status"] == "ok"
    assert not any("LOOP WRITE-ONLY" in rec.message for rec in caplog.records)


def test_native_fresh_store_is_quiet(caplog):
    """EVAL-CB3-04: empty store (0 lessons) → never trips."""
    _, comp = _make_native_store_compat()
    with caplog.at_level(logging.ERROR):
        for _ in range(5):
            comp.loop_self_check()
    assert comp.loop_health()["status"] == "ok"
    assert comp._writeonly_streak == 0
    assert not any("LOOP WRITE-ONLY" in rec.message for rec in caplog.records)


def test_native_floor_suppresses_small_corpus():
    """EVAL-CB3-04: floor > corpus size → write_only stays False."""
    store, comp = _make_native_store_compat()
    comp._loop_writeonly_floor = 10
    _seed_write_only(store, n=3)
    r = comp.loop_self_check()
    assert r["checked"] is True
    assert r["write_only"] is False


def test_native_streak_resets_on_recovery():
    """EVAL-CB3-04: alarm clears when circulation returns."""
    store, comp = _make_native_store_compat()
    comp._loop_writeonly_k = 1
    _seed_write_only(store, n=2)
    comp.loop_self_check()
    assert comp.loop_health()["status"] == "write-only-alarm"

    # Recall + consume → circulation > 0
    ctx = comp.prefetch("subsystem alpha-0")
    assert ctx
    comp.confirm_prefetch_consumed()
    r = comp.loop_self_check()
    assert r["write_only"] is False
    assert comp.loop_health()["status"] == "ok"
    assert comp._writeonly_streak == 0
