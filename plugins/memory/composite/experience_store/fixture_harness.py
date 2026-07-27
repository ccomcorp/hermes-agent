"""Fail-closed fixture harness for the native ExperienceStore (B2A preparation).

Requires an EXPLICIT operator-provided fixture bundle directory containing:

    bundle/
    ├── manifest.json          # required — SHA-256 hashes of every fixture file
    ├── experience.db
    ├── experience.db-wal
    ├── experience.db-shm
    ├── composite/config.json
    └── .env.placeholders      # profile .env with placeholder values

manifest.json schema:
    {
        "version": 1,
        "source_commit": "<aios-commit-sha>",
        "source_sha256": "<store.py-sha256>",
        "files": {
            "experience.db":       "<sha256>",
            "experience.db-wal":   "<sha256>",
            "experience.db-shm":   "<sha256>",
            "composite/config.json": "<sha256>",
            ".env.placeholders":   "<sha256>"
        }
    }

The harness validates the manifest and every declared file BEFORE opening SQLite.
If the bundle is absent, manifest is missing, or any declared file has a hash
mismatch, the harness returns a distinct status code (BACKUP_MISSING /
FIXTURE_INVALID / MANIFEST_PARSE_ERROR) and NEVER opens a database connection.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# --- Status constants ---

BACKUP_MISSING = "BACKUP_MISSING"
FIXTURE_INVALID = "FIXTURE_INVALID"
MANIFEST_PARSE_ERROR = "MANIFEST_PARSE_ERROR"
OK = "OK"


@dataclass
class FixtureResult:
    """Outcome of a fixture bundle validation."""
    status: str                        # OK | BACKUP_MISSING | FIXTURE_INVALID | MANIFEST_PARSE_ERROR
    detail: str = ""                   # human-readable detail
    missing_files: list[str] = field(default_factory=list)
    mismatched_files: list[str] = field(default_factory=list)
    manifest: dict | None = None       # parsed manifest if valid

    @property
    def is_valid(self) -> bool:
        return self.status == OK


# --- API ---

def validate_fixture_bundle(bundle_dir: str | Path) -> FixtureResult:
    """Validate a fixture bundle directory.

    Checks (in order):
      1. Bundle directory exists.
      2. manifest.json exists and parses to valid JSON.
      3. Every file declared in manifest.files exists at the expected sha256.

    Returns a FixtureResult — if result.is_valid is False, the caller MUST NOT
    open any SQLite or read any fixture file.
    """
    bundle = Path(bundle_dir)

    if not bundle.is_dir():
        return FixtureResult(
            status=BACKUP_MISSING,
            detail=f"Fixture bundle directory does not exist: {bundle}",
        )

    manifest_path = bundle / "manifest.json"
    if not manifest_path.is_file():
        return FixtureResult(
            status=BACKUP_MISSING,
            detail=f"manifest.json not found in bundle: {bundle}",
        )

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return FixtureResult(
            status=MANIFEST_PARSE_ERROR,
            detail=f"Failed to parse manifest.json: {exc}",
        )

    files: dict[str, str] = manifest.get("files", {})
    if not isinstance(files, dict) or not files:
        return FixtureResult(
            status=FIXTURE_INVALID,
            detail="manifest.files is missing or empty",
        )

    missing_files: list[str] = []
    mismatched_files: list[str] = []

    for rel_path, expected_hash in files.items():
        file_path = bundle / rel_path
        if not file_path.is_file():
            missing_files.append(rel_path)
            continue

        actual_hash = _sha256_file(file_path)
        if actual_hash != expected_hash:
            mismatched_files.append(
                f"{rel_path} (expected={expected_hash[:12]}..., actual={actual_hash[:12]}...)"
            )

    if missing_files:
        return FixtureResult(
            status=FIXTURE_INVALID,
            detail="Required fixture files are missing",
            missing_files=missing_files,
        )

    if mismatched_files:
        return FixtureResult(
            status=FIXTURE_INVALID,
            detail="Fixture file hash mismatch — bundle may be tampered or stale",
            mismatched_files=mismatched_files,
        )

    return FixtureResult(
        status=OK,
        detail=f"Bundle validated successfully ({len(files)} files)",
        manifest=manifest,
    )


def open_fixture_store(bundle_dir: str | Path) -> tuple[FixtureResult, Any | None]:
    """Validate the bundle, then open the ExperienceStore if valid.

    Returns (result, store). If result.is_valid is False, store is None and
    NO SQLite connection was opened.
    """
    result = validate_fixture_bundle(bundle_dir)
    if not result.is_valid:
        return result, None

    from .store import ExperienceStore

    db_path = Path(bundle_dir) / "experience.db"
    store = ExperienceStore(db_path=str(db_path))
    return result, store


# --- helpers ---

def _sha256_file(path: Path) -> str:
    """Return the SHA-256 hex digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()


# --- builder (for operator use) ---

def write_manifest(bundle_dir: str | Path, source_commit: str = "", source_sha256: str = "") -> str:
    """Scan bundle_dir for declared files, compute their hashes, and write manifest.json.

    This is the operator-side helper — ONLY ever run against the verified
    operator-supplied bundle.
    """
    bundle = Path(bundle_dir)
    files = [
        "experience.db",
        "experience.db-wal",
        "experience.db-shm",
        "composite/config.json",
        ".env.placeholders",
    ]

    file_hashes: dict[str, str] = {}
    for rel in files:
        p = bundle / rel
        if not p.is_file():
            raise FileNotFoundError(f"Required fixture file missing: {p}")
        file_hashes[rel] = _sha256_file(p)

    manifest: dict[str, Any] = {
        "version": 1,
        "source_commit": source_commit,
        "source_sha256": source_sha256,
        "files": file_hashes,
    }
    manifest_path = bundle / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return str(manifest_path)


__all__ = [
    "BACKUP_MISSING",
    "FIXTURE_INVALID",
    "MANIFEST_PARSE_ERROR",
    "OK",
    "FixtureResult",
    "validate_fixture_bundle",
    "open_fixture_store",
    "write_manifest",
    "_sha256_file",
]
