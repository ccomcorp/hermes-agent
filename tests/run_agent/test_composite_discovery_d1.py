"""M1 Task 2 D1 (deferred store construction) + R8 (actionable import) + R9 (ack presence).

D1: a read-only discovery probe must construct NO sqlite store. The PRIMARY assertion is
that no ExperienceStore is constructed during build_provider/is_available (not merely that
no file appears — a `:memory:` store or leaked handle would pass a file-only check).
"""

from __future__ import annotations

import pytest

try:
    from plugins.memory.composite import provider

    _HAVE_AIOS = True
except Exception:  # pragma: no cover - sibling AIOS repo absent
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(not _HAVE_AIOS, reason="AIOS composite/store not importable")


def test_build_provider_defers_store_construction(tmp_path):
    prov = provider.build_provider(str(tmp_path))
    # PRIMARY: building the provider (the discovery path) constructs NO store.
    assert prov._store is None
    # is_available must answer truthfully WITHOUT constructing the store.
    assert prov.is_available() is True
    assert prov._store is None
    # SECONDARY: no experience.db on disk yet.
    assert not (tmp_path / "experience.db").exists()

    # Activation (initialize) builds the store exactly once.
    prov.initialize("sess", agent_context="primary")
    assert prov._store is not None
    assert (tmp_path / "experience.db").exists()

    # Idempotent: re-initialize does not replace the live store.
    live = prov._store
    prov.initialize("sess2", agent_context="primary")
    assert prov._store is live


def test_injected_store_form_still_works_for_tests():
    # The eager-store form (positional store) used by unit tests / the harness must remain.
    store = provider.ExperienceStore(db_path=":memory:")
    comp = provider.HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    assert comp.is_available() is True
    assert comp._store is store
    comp.initialize("s", agent_context="primary")
    assert comp._store is store  # injected store is not replaced


def test_resolve_aios_dirs_raises_actionable_error(monkeypatch, tmp_path):
    monkeypatch.setenv("AIOS_PACKAGES_DIR", str(tmp_path / "does-not-exist"))
    with pytest.raises(ImportError) as ei:
        provider._resolve_aios_package_dirs()
    assert "AIOS_PACKAGES_DIR" in str(ei.value)


def test_sync_turn_ack_reports_absent_legs_as_skipped():
    store = provider.ExperienceStore(db_path=":memory:")
    comp = provider.HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize("s", agent_context="primary")
    ack = comp.sync_turn("u", "a")
    assert ack["store"] == "skipped"
    assert ack["brain"] == "skipped"   # brain=None must not read as degraded/ok
    assert ack["vault"] == "skipped"   # vault=None must not read as ok
