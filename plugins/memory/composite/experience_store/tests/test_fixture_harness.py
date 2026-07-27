"""TDD RED — fail-closed fixture harness tests (B2A preparation).

These tests verify the fixture harness fails closed in every observable
failure mode BEFORE opening a SQLite connection.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from plugins.memory.composite.experience_store.fixture_harness import (
    BACKUP_MISSING,
    FIXTURE_INVALID,
    MANIFEST_PARSE_ERROR,
    OK,
    FixtureResult,
    _sha256_file,
    open_fixture_store,
    validate_fixture_bundle,
    write_manifest,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_minimal_bundle(tmp_path: Path) -> Path:
    """Create a valid minimal fixture bundle with a fully initialized DB."""
    bundle = tmp_path / "bundle"
    bundle.mkdir()

    # Create a fully initialized experience.db using the native ExperienceStore
    from plugins.memory.composite.experience_store import ExperienceStore
    db_path = str(bundle / "experience.db")
    store = ExperienceStore(db_path=db_path)
    store.close()

    # Touch the companion files (they exist for a WAL-mode DB)
    (bundle / "experience.db-wal").write_text("")
    (bundle / "experience.db-shm").write_text("")

    # Composite config
    cfg_dir = bundle / "composite"
    cfg_dir.mkdir()
    (cfg_dir / "config.json").write_text(json.dumps({"provider": "composite"}))

    # .env placeholders
    (bundle / ".env.placeholders").write_text("HERMES_BRAIN_STAGE=0\n")

    return bundle


# ---------------------------------------------------------------------------
# EVAL-CB2-03: BACKUP_MISSING — bundle directory absent
# ---------------------------------------------------------------------------

def test_fixture_harness_backup_missing_when_dir_absent(tmp_path: Path) -> None:
    """Bundle directory that doesn't exist → BACKUP_MISSING, no SQLite opened."""
    nonexistent = tmp_path / "does_not_exist"
    result, store = open_fixture_store(nonexistent)
    assert result.status == BACKUP_MISSING
    assert store is None
    assert "does not exist" in result.detail.lower() or "not_found" in result.detail.lower()


def test_fixture_harness_backup_missing_when_manifest_absent(tmp_path: Path) -> None:
    """Bundle directory exists but no manifest.json → BACKUP_MISSING."""
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    result, store = open_fixture_store(bundle)
    assert result.status == BACKUP_MISSING
    assert store is None
    assert "manifest.json" in result.detail.lower()


# ---------------------------------------------------------------------------
# EVAL-CB2-05: MANIFEST_PARSE_ERROR — corrupt manifest
# ---------------------------------------------------------------------------

def test_fixture_harness_manifest_parse_error_on_corrupt_json(tmp_path: Path) -> None:
    """Corrupt manifest.json → MANIFEST_PARSE_ERROR, no SQLite opened."""
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "manifest.json").write_text("not valid json{{{")
    result, store = open_fixture_store(bundle)
    assert result.status == MANIFEST_PARSE_ERROR
    assert store is None


def test_fixture_harness_manifest_invalid_when_files_empty(tmp_path: Path) -> None:
    """manifest.json with empty files dict → FIXTURE_INVALID."""
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "manifest.json").write_text(json.dumps({"version": 1, "files": {}}))
    result, store = open_fixture_store(bundle)
    assert result.status == FIXTURE_INVALID
    assert store is None


# ---------------------------------------------------------------------------
# EVAL-CB2-03: FIXTURE_INVALID — missing or mismatched files
# ---------------------------------------------------------------------------

def test_fixture_harness_invalid_on_missing_file(tmp_path: Path) -> None:
    """A declared file is absent → FIXTURE_INVALID, no SQLite opened."""
    bundle = _make_minimal_bundle(tmp_path)

    # Write a manifest that declares a non-existent file
    manifest = {
        "version": 1,
        "source_commit": "089213f",
        "source_sha256": "352bd22a",
        "files": {
            "experience.db": _sha256_file(bundle / "experience.db"),
            "experience.db-wal": _sha256_file(bundle / "experience.db-wal"),
            "experience.db-shm": _sha256_file(bundle / "experience.db-shm"),
            "composite/config.json": _sha256_file(bundle / "composite/config.json"),
            ".env.placeholders": _sha256_file(bundle / ".env.placeholders"),
            "missing-file.db": "deadbeefdeadbeefdeadbeef",  # DOES NOT EXIST
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result, store = open_fixture_store(bundle)
    assert result.status == FIXTURE_INVALID
    assert store is None
    assert "missing-file.db" in result.missing_files


def test_fixture_harness_invalid_on_hash_mismatch(tmp_path: Path) -> None:
    """A declared file has wrong hash → FIXTURE_INVALID, no SQLite opened."""
    bundle = _make_minimal_bundle(tmp_path)

    # Write a manifest with a deliberately wrong hash
    manifest = {
        "version": 1,
        "source_commit": "089213f",
        "source_sha256": "352bd22a",
        "files": {
            "experience.db": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",  # WRONG (empty sha)
            "experience.db-wal": _sha256_file(bundle / "experience.db-wal"),
            "experience.db-shm": _sha256_file(bundle / "experience.db-shm"),
            "composite/config.json": _sha256_file(bundle / "composite/config.json"),
            ".env.placeholders": _sha256_file(bundle / ".env.placeholders"),
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result, store = open_fixture_store(bundle)
    assert result.status == FIXTURE_INVALID
    assert store is None
    assert len(result.mismatched_files) == 1
    assert "experience.db" in result.mismatched_files[0]


# ---------------------------------------------------------------------------
# EVAL-CB2-02: OK — valid bundle opens the store
# ---------------------------------------------------------------------------

def test_fixture_harness_ok_on_valid_bundle(tmp_path: Path) -> None:
    """All files present with correct hashes → OK, store is opened."""
    bundle = _make_minimal_bundle(tmp_path)

    # Write a correct manifest
    manifest_path = write_manifest(
        bundle_dir=str(bundle),
        source_commit="089213f",
        source_sha256="352bd22a5703cdbff93777524c1667fa440e29e8f2c5ac1f905612ec82e7a06f",
    )
    assert Path(manifest_path).exists()

    result, store = open_fixture_store(bundle)
    assert result.status == OK
    assert store is not None
    try:
        # Verify the store is usable
        ref = store.append({
            "lesson": "Test lesson for fixture validation",
            "task_type": "implementation-pattern",
            "tags": ["test"],
            "provenance": "test:fixture-harness",
            "source": "auto",
        })
        assert isinstance(ref, str) and len(ref) == 32
    finally:
        store.close()
