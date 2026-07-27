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
    _REQUIRED_FILES,
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
# Fixture harness: BACKUP_MISSING — bundle directory absent
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
# Fixture harness: MANIFEST_PARSE_ERROR — corrupt manifest
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
# Fixture harness: FIXTURE_INVALID — missing or mismatched files
# ---------------------------------------------------------------------------

def test_fixture_harness_invalid_on_missing_file(tmp_path: Path) -> None:
    """A declared file is absent → FIXTURE_INVALID, no SQLite opened."""
    bundle = _make_minimal_bundle(tmp_path)

    # Write a manifest that declares a non-existent file.
    # After FH-01 repair: extra files are caught by the allowlist gate before
    # file-existence check. The test still proves fail-closed behavior.
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
            "missing-file.db": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result, store = open_fixture_store(bundle)
    assert result.status == FIXTURE_INVALID
    assert store is None
    # After FH-01 repair: extra-file is caught by allowlist gate.
    # The missing_files field is populated for truly missing required files,
    # not for extra/unexpected ones (which fire the allowlist mismatch first).


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
# Fixture harness: OK — valid bundle opens the store
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


# ============================================================================
# Adversarial tests — FH-01: fixed required-file allowlist enforcement
# ============================================================================

def test_fixture_harness_rejects_missing_required_file(tmp_path: Path) -> None:
    """Bundle missing one of the 5 required files → FIXTURE_INVALID."""
    bundle = _make_minimal_bundle(tmp_path)
    # Remove .env.placeholders
    (bundle / ".env.placeholders").unlink()

    # Write manifest manually (write_manifest requires all files present)
    manifest = {
        "version": 1,
        "source_commit": "089213f",
        "source_sha256": "352bd22a",
        "files": {
            "experience.db": _sha256_file(bundle / "experience.db"),
            "experience.db-wal": _sha256_file(bundle / "experience.db-wal"),
            "experience.db-shm": _sha256_file(bundle / "experience.db-shm"),
            "composite/config.json": _sha256_file(bundle / "composite/config.json"),
            ".env.placeholders": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result = validate_fixture_bundle(bundle)
    assert result.status == FIXTURE_INVALID
    assert any("env" in f.lower() for f in result.missing_files)


def test_fixture_harness_rejects_extra_file_in_manifest(tmp_path: Path) -> None:
    """Manifest declaring a non-required file → FIXTURE_INVALID."""
    bundle = _make_minimal_bundle(tmp_path)
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
            "extra-sneaky.db": "a" * 64,  # NOT in the fixed set
        },
    }
    (bundle / "extra-sneaky.db").write_text("malicious")
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result = validate_fixture_bundle(bundle)
    assert result.status == FIXTURE_INVALID
    assert "unexpected" in result.detail.lower() or "extra" in result.detail.lower()


def test_fixture_harness_rejects_manifest_missing_required_key(tmp_path: Path) -> None:
    """Manifest with fewer than 5 entries → FIXTURE_INVALID."""
    bundle = _make_minimal_bundle(tmp_path)
    manifest = {
        "version": 1,
        "files": {
            "experience.db": _sha256_file(bundle / "experience.db"),
            # Only one file — 4 missing
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result = validate_fixture_bundle(bundle)
    assert result.status == FIXTURE_INVALID


def test_fixture_harness_rejects_hermes_home_bundle(tmp_path: Path, monkeypatch) -> None:
    """Opening a bundle that resolves to current HERMES_HOME → rejected."""
    bundle = _make_minimal_bundle(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(bundle))
    manifest_path = write_manifest(bundle_dir=str(bundle))

    result = validate_fixture_bundle(bundle)
    assert result.status == FIXTURE_INVALID
    assert "hermes_home" in result.detail.lower()


# ============================================================================
# Adversarial tests — FH-02: path-traversal rejection
# ============================================================================

def test_fixture_harness_rejects_traversal_path(tmp_path: Path) -> None:
    """Manifest entry with '..' → FIXTURE_INVALID."""
    bundle = _make_minimal_bundle(tmp_path)
    manifest = {
        "version": 1,
        "files": {
            "../etc/passwd": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result = validate_fixture_bundle(bundle)
    assert result.status == FIXTURE_INVALID
    assert "path" in result.detail.lower() or "traversal" in result.detail.lower()


def test_fixture_harness_rejects_absolute_path(tmp_path: Path) -> None:
    """Manifest entry with absolute path → FIXTURE_INVALID."""
    bundle = _make_minimal_bundle(tmp_path)
    manifest = {
        "version": 1,
        "files": {
            "/etc/passwd": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result = validate_fixture_bundle(bundle)
    assert result.status == FIXTURE_INVALID
    # After FH-02-before-FH-01 reorder: absolute path caught first.
    assert "absolute" in result.detail.lower()


def test_fixture_harness_rejects_transversal_mixed_required_file(tmp_path: Path) -> None:
    """A required file declared with traversal prefix → FIXTURE_INVALID."""
    bundle = _make_minimal_bundle(tmp_path)
    manifest = {
        "version": 1,
        "files": {
            "../../experience.db": _sha256_file(bundle / "experience.db"),
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result = validate_fixture_bundle(bundle)
    assert result.status == FIXTURE_INVALID


# ============================================================================
# Adversarial tests — FH-03: digest-form validation
# ============================================================================

def test_fixture_harness_rejects_non_string_digest(tmp_path: Path) -> None:
    """Manifest with non-string hash value → FIXTURE_INVALID."""
    bundle = _make_minimal_bundle(tmp_path)
    manifest = {
        "version": 1,
        "files": {
            "experience.db": 12345,  # integer, not string
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result = validate_fixture_bundle(bundle)
    assert result.status == FIXTURE_INVALID


def test_fixture_harness_rejects_short_digest(tmp_path: Path) -> None:
    """Manifest with hash shorter than 64 chars → FIXTURE_INVALID."""
    bundle = _make_minimal_bundle(tmp_path)
    manifest = {
        "version": 1,
        "files": {
            "experience.db": "abc123",  # too short
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result = validate_fixture_bundle(bundle)
    assert result.status == FIXTURE_INVALID


def test_fixture_harness_rejects_non_hex_digest(tmp_path: Path) -> None:
    """Manifest with non-hex hash → FIXTURE_INVALID."""
    bundle = _make_minimal_bundle(tmp_path)
    manifest = {
        "version": 1,
        "files": {
            "experience.db": "g" * 64,  # 'g' is not valid hex
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest))

    result = validate_fixture_bundle(bundle)
    assert result.status == FIXTURE_INVALID


# ============================================================================
# Adversarial tests — FH-04: write_manifest disabled
# ============================================================================

def test_write_manifest_not_exported_for_operator_use() -> None:
    """write_manifest must either be removed or return an error when called outside tests."""
    # After repair, write_manifest should raise an error or be removed from __all__.
    # This test asserts the function exists but is disabled.
    import plugins.memory.composite.experience_store.fixture_harness as fh
    if hasattr(fh, "write_manifest"):
        with pytest.raises((RuntimeError, NotImplementedError, AssertionError)):
            fh.write_manifest("/nonexistent/path")
