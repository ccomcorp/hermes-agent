"""TDD RED — native ExperienceStore import tests (B2A preparation).

These tests MUST fail until the experience_store package is implemented.
They verify:

1. The native ExperienceStore imports without any AIOS sys.path hack.
2. AIOS_PACKAGES_DIR is not required — the engine is self-contained.
3. A deliberate negative-import test guards against accidental AIOS leakage.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# EVAL-CB2-01: native import — no AIOS hack required
# ---------------------------------------------------------------------------

def test_experience_store_is_native_and_its_schema_bootstraps(tmp_path: Path) -> None:
    """Import ExperienceStore from the native vendor package and bootstrap a DB.

    This is the PREPARATORY proof for the B2 compatibility baseline:
    the engine must import natively (no AIOS sys.path hack) and its schema
    must create the expected tables on first open against a clean :memory: DB.
    """
    from plugins.memory.composite.experience_store import ExperienceStore

    store = ExperienceStore(db_path=":memory:")
    try:
        # Schema bootstrapped: all expected tables exist.
        tables = {
            r[0] for r in
            store._conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
        }
        assert "lessons" in tables
        assert "signals" in tables
        assert "receipts" in tables
        # FTS tables appear differently — check via sqlite_master type='virtual table'
        fts_tables = {
            r[1] for r in
            store._conn.execute(
                "SELECT * FROM sqlite_master WHERE type='table' AND name LIKE 'lessons_fts%'"
            ).fetchall()
        }
        assert len(fts_tables) >= 1, f"Expected FTS5 shadow tables, got: {tables}"
    finally:
        store.close()


def test_experience_store_appends_and_recalls(tmp_path: Path) -> None:
    """Round-trip: append a lesson, recall it, signal it, forget it.

    Proves the full engine surface works against an in-memory DB with no
    external dependencies.
    """
    from plugins.memory.composite.experience_store import ExperienceStore

    store = ExperienceStore(db_path=":memory:")
    try:
        ref = store.append({
            "lesson": "Use blake2b not md5 for content hashing",
            "task_type": "implementation-pattern",
            "tags": ["crypto", "hashing"],
            "provenance": "test:round-trip",
            "source": "auto",
        })
        assert isinstance(ref, str) and len(ref) == 32  # uuid4 hex

        # Recall finds it
        records, receipt = store.recall(
            "blake2b hashing", call_site="test-session-start", limit=5,
        )
        assert receipt["kind"] == "hit"
        assert len(records) == 1
        assert records[0]["id"] == ref
        assert "blake2b" in records[0]["lesson"]

        # Signal an outcome
        result = store.signal(ref, valence=1.0, derivation="task_completed")
        assert result["ok"] is True

        # Forget (tombstone)
        forgotten = store.forget(ref)
        assert forgotten is not None
        assert forgotten["tombstoned"] is True

        # Recall no longer returns tombstoned rows
        records2, receipt2 = store.recall(
            "blake2b hashing", call_site="test-session-start", limit=5,
        )
        assert len(records2) == 0
    finally:
        store.close()


# ---------------------------------------------------------------------------
# EVAL-RB-01: deliberate native-import negative test
# ---------------------------------------------------------------------------

def test_experience_store_does_not_need_aios_variables(monkeypatch) -> None:
    """Prove that AIOS_PACKAGES_DIR and AIOS_HEALTH_DIR are NOT required.

    This is a deliberate negative test — it UNSETs both variables before the
    import, ensuring the native package does not crash or depend on them.
    """
    for var in ("AIOS_PACKAGES_DIR", "AIOS_HEALTH_DIR", "AIOS_SKILLS_DIR"):
        monkeypatch.delenv(var, raising=False)

    # Import must succeed with no AIOS env vars set
    from plugins.memory.composite.experience_store import ExperienceStore

    store = ExperienceStore(db_path=":memory:")
    store.close()


# ---------------------------------------------------------------------------
# EVAL-CB2-02: ensure class identity for the composite contract
# ---------------------------------------------------------------------------

def test_experience_store_has_required_public_api() -> None:
    """The native ExperienceStore must expose the contract surface the
    CompositeMemoryProvider expects: append, recall, signal, forget,
    mark_consumed, aggregate, circulation, close.
    """
    from plugins.memory.composite.experience_store import ExperienceStore

    expected_methods = {
        "append", "recall", "signal", "forget",
        "mark_consumed", "aggregate", "circulation", "close",
    }
    for name in expected_methods:
        assert hasattr(ExperienceStore, name), (
            f"ExperienceStore missing method: {name}"
        )
