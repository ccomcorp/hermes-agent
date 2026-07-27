# AGENTS.md — composite memory provider (chassis-side)

> Hand-maintained dir guide. This is **hermes-agent**, NOT AIOS — it is outside the AIOS
> DOX index (the AIOS root index does not scan this repo) and needs no index registration.

The chassis-side binding of the experience-store composite. Activated by
`memory.provider: composite` in `config.yaml` — the package merely existing does not
register anything; the config key does.

## Directory map

- **`provider.py`** — chassis-side binding (sys.path hack to AIOS packages, subclasses
  `CompositeMemoryProvider`). Adds fork-append seam (`record_fork_lesson`), D4-A prefetch,
  D3b recall, brain staging (0/1/2), `brain_health()`, and `build_provider(hermes_home)`.
  WILL be refactored to use `core/` in a follow-up.
- **`core/`** — M0-B1: vendor-native composite engine, ported from AIOS
  `packages/memory/composite-provider/`. Zero `sys.path` hacks, zero AIOS dependency
  for the engine itself (the store is still injected; B2 ports that).
  - `core/composite_provider.py` — `CompositeMemoryProvider` with fan-out across three
    backends (store, brain, vault), prefetch/queue_prefetch inversion, defer-consume,
    tool routing (experience_signal/experience_forget). Binds to the real chassis
    `agent.memory_provider.MemoryProvider` ABC — no `_base_shim` fallback.
  - `core/backends.py` — `BrainClient` + `VaultCache` Protocol interfaces, plus
    `BRAIN_OK`/`BRAIN_DEGRADED`/`BRAIN_FAIL` status constants.
  - `core/__init__.py` — public re-exports.
  - `core/tests/` — 29 B1 tests (ported from AIOS), all green.  B1 tests use a native
    `FakeStore` (M0-B1R — zero AIOS dependency).  Real store behavior belongs to B2.
- **`experience_store/`** — M0-B2A: vendor-native experience engine (ported from AIOS
  `packages/memory/experience-store/`). Zero `sys.path` hacks, zero AIOS dependency.
  Self-contained SQLite + FTS5 store with schema, embedder, receipts, and the native
  `ExperienceStore` class.
  - `experience_store/store.py` — `ExperienceStore`: SQLite-backed engine with append,
    recall (FTS5/BM25 + embedder re-rank), signal (non-constant by construction),
    forget (tombstone), aggregate/circulation/valence-window health primitives.
    Thread-safe (check_same_thread=False + RLock).
  - `experience_store/schema.sql` — SQLite schema (lessons, lessons_fts, signals,
    receipts tables). Idempotent `CREATE TABLE IF NOT EXISTS`.
  - `experience_store/receipts.py` — `Receipt` dataclass + insert/get/mark_consumed.
  - `experience_store/embed.py` — `Embedder` Protocol + `LexicalEmbedder` (hashing-
    trick, zero numpy/third-party deps).
  - `experience_store/fixture_harness.py` — Fail-closed bundle validation harness.
    Requires an explicit operator-provided bundle with `manifest.json` (SHA-256 hashes
    of all fixture files). Fails with `BACKUP_MISSING` / `FIXTURE_INVALID` /
    `MANIFEST_PARSE_ERROR` BEFORE opening SQLite — never silent.
  - `experience_store/tests/` — B2A preparation tests (4 native import + 7 fixture
    harness = 11 tests), all green.
- **`brain_http.py`** — `HttpBrainClient`, blocking-HTTP brain adapter.
- **`__init__.py`** — plugin entry point.
- **`tests/`** — chassis-side integration tests (brain staging, outcome signals, etc.).

## Activation (M1 brain add-on)

Staged via env, read by `build_provider` at gateway startup (a **full relaunch** is
required to change stage). Requires `memory.provider: composite` — with the default
provider the brain leg is never constructed regardless of env.

- `HERMES_BRAIN_STAGE` = `0` (off, default — live agent byte-for-byte unchanged) /
  `1` (observe + recall) / `2` (+ backgrounded paired reward, the learning leg).
  Garbage clamps to `0`.
- `HERMES_BRAIN_URL` overrides the endpoint (default `http://1.1.11.31:8000`).
- `AIOS_PACKAGES_DIR` overrides the sibling-checkout path to the two AIOS packages.
- Canonical instance home: `HERMES_HOME=I:\PROJECTS\AIOS\hermes-home` (where
  `experience.db` lives) — NOT the stale `%LOCALAPPDATA%\hermes` home.

Stage 1 verified live 2026-06-13 on the canonical desktop. Full design lives AIOS-side in
`docs/architecture/SPEC-m1-experience-store.md`; operator quick-reference in the AIOS root
`AGENTS.md` ("Brain activation (M1 add-on)") and `docs/architecture/REF-brain-activation-settings.md`.
