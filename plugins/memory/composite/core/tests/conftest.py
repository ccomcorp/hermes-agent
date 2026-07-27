"""Pytest path bootstrap for the vendor-native composite core tests (M0-B1R).

B1 tests now use a native FakeStore (tests/fake_store.py) — zero AIOS dependency.
The composite *core* (composite_provider + backends) imports natively from
``plugins.memory.composite.core`` — no sys.path hack needed for the engine being
tested.

The M0-B1R repair removed the legacy AIOS store path injection. All 29 tests
pass under a clean HERMES_HOME with AIOS_PACKAGES_DIR and AIOS_HEALTH_DIR unset.
"""
