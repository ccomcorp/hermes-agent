-- Experience-store SQLite schema (M1 engine).
-- Ported from AIOS packages/memory/experience-store/schema.sql
-- Source provenance: AIOS commit 089213f, SHA-256 352BD22A...
--
-- Design guarantees encoded here:
--  * lessons.id is a restart-stable UUID TEXT (uuid4 hex), the PRIMARY KEY.
--    It is NEVER a sqlite rowid (learn from the NeuroLinked rowid-reassignment bug).
--  * success_rate is DERIVED (wins/(wins+losses)) and is NOT a column.
--  * lessons_fts mirrors lesson text + tags for BM25 keyword recall; it is kept in
--    sync by triggers so a tombstoned/forgotten row can be removed from the index.
--  * receipts is the AC1 circulation evidence ledger. Every recall writes exactly one
--    row (kind='hit' or kind='miss'); never silent.

CREATE TABLE IF NOT EXISTS lessons (
    id              TEXT PRIMARY KEY,          -- uuid4 hex, restart-stable
    lesson          TEXT NOT NULL,
    task_type       TEXT NOT NULL,
    what_failed     TEXT,
    resolution      TEXT,
    tags            TEXT NOT NULL DEFAULT '[]',-- JSON array of strings
    provenance      TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'auto',   -- auto | reviewed
    migrated        INTEGER NOT NULL DEFAULT 0,     -- 0=fork-authored, 1=seed/migrated
    wins            INTEGER NOT NULL DEFAULT 0,
    losses          INTEGER NOT NULL DEFAULT 0,
    uses            INTEGER NOT NULL DEFAULT 0,
    last_accessed_at REAL,
    ts              REAL NOT NULL,
    tombstoned      INTEGER NOT NULL DEFAULT 0
);

-- FTS5 keyword index over lesson body + flattened tags. A self-contained (managed-
-- content) FTS5 table: we insert/delete rows explicitly, keyed back to lessons.id via
-- the unindexed `ref` column, so a tombstoned/forgotten row is removed from the index.
CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
    lesson,
    tags,
    ref UNINDEXED
);

-- Signals ledger: one row per signal() call. Backs success_rate derivation and the
-- AC4-hard variance(valence) > 0 guard.
CREATE TABLE IF NOT EXISTS signals (
    id          TEXT PRIMARY KEY,
    lesson_ref  TEXT NOT NULL,
    valence     REAL NOT NULL,
    derivation  TEXT NOT NULL,
    ts          REAL NOT NULL
);

-- Circulation-receipt ledger (AC1 evidence). lesson_refs is a JSON array of lessons.id.
-- latency_ms + timed_out are the latency-budget evidence (M1 gap G5, SPEC §4): every
-- recall records its MEASURED latency, and a budget breach (> RECALL_BUDGET_MS) flips
-- timed_out=1 (the observable recall_miss-on-timeout signal; never a silent drop). A p95
-- is computed over latency_ms across the ledger.
CREATE TABLE IF NOT EXISTS receipts (
    id          TEXT PRIMARY KEY,
    lesson_refs TEXT NOT NULL DEFAULT '[]',  -- JSON array of lessons.id
    call_site   TEXT NOT NULL,
    query       TEXT NOT NULL,
    consumed    INTEGER NOT NULL DEFAULT 0,
    kind        TEXT NOT NULL,               -- hit | miss
    latency_ms  REAL NOT NULL DEFAULT 0,     -- measured recall latency (G5)
    timed_out   INTEGER NOT NULL DEFAULT 0,  -- 1 = breached RECALL_BUDGET_MS (G5)
    ts          REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_lesson ON signals(lesson_ref);
CREATE INDEX IF NOT EXISTS idx_receipts_consumed ON receipts(consumed, kind);
