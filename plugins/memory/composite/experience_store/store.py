"""Native ExperienceStore — SQLite-backed experience memory engine.

Ported from AIOS packages/memory/experience-store/store.py
Source: AIOS commit 089213f, file SHA-256 352BD22A5703CDBFF93777524C1667FA440E29E8F2C5AC1F905612EC82E7A06F

This is the native vendor copy for hermes-agent plugins/memory/composite/.
Zero AIOS dependency — the schema, receipts, embedder, and engine are all
self-contained in this package.

M1 engine design guarantees:
  - lessons.id is a restart-stable UUID hex (NEVER a sqlite rowid).
  - Every recall writes a receipt (kind='hit' or 'miss') — never silent.
  - signal() requires a valid derivation; constant valence is rejected.
  - Thread-safe: the connection uses check_same_thread=False + an RLock.
  - FTS5 keyword recall with optional embedder re-rank.
"""

from __future__ import annotations

import functools
import json
import logging
import numbers
import os
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .embed import Embedder, LexicalEmbedder
from .receipts import Receipt, get_receipt, insert_receipt, mark_consumed

_log = logging.getLogger(__name__)

# Latency budget for recall (M1 gap G5). A breach flips the receipt's timed_out flag
# and emits a WARN — observable, never silent. Tunable via env for diagnostics.
RECALL_BUDGET_MS = int(os.environ.get("HERMES_RECALL_BUDGET_MS", "250"))

_SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")

VALID_TASK_TYPES = {
    "architecture",
    "error-recovery",
    "failure-mode",
    "test-methodology",
    "implementation-pattern",
    "knowledge-gate",
    "workflow",
}

VALID_DERIVATIONS = {
    "task_completed",
    "user_correction",
    "explicit_feedback",
    "test_result",
}

VALID_SOURCES = {"auto", "reviewed"}


def _perf_clock() -> float:
    return time.perf_counter()


class ConstantValenceError(ValueError):
    """Raised when signal() is given a missing/invalid derivation — the forbidden
    constant-valence path (NeuroLinked H7 `was_helpful=True` bug)."""


def _fts_escape(query: str) -> str:
    """Turn a free-text query into a safe FTS5 OR-of-terms match expression.

    Each alphanumeric token is wrapped in double quotes (FTS5 string literal) so
    punctuation / reserved chars can never produce a syntax error. Terms are OR'd so
    a multi-word query behaves like keyword recall rather than a strict phrase.
    """
    toks = re.findall(r"[A-Za-z0-9]+", query or "")
    if not toks:
        return ""
    return " OR ".join(f'"{t}"' for t in toks)


def _synchronized(method):
    """Serialize a method behind the instance's re-entrant store lock."""

    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return wrapper


class ExperienceStore:
    """SQLite-backed experience store with FTS5 recall and outcome signalling."""

    _MIGRATIONS = (
        ("receipts", "latency_ms", "ALTER TABLE receipts ADD COLUMN latency_ms REAL NOT NULL DEFAULT 0"),
        ("receipts", "timed_out", "ALTER TABLE receipts ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0"),
    )

    def __init__(self, db_path: str = ":memory:", *, embedder: Embedder | None = None):
        self.db_path = db_path
        # Re-entrant lock created FIRST: _init_schema() below is @_synchronized.
        self._lock = threading.RLock()
        # check_same_thread=False: serialized by self._lock.
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._embedder = embedder or LexicalEmbedder()
        self._init_schema()

    # ----- lifecycle -----

    @_synchronized
    def _init_schema(self):
        with open(_SCHEMA_PATH, "r", encoding="utf-8") as fh:
            self._conn.executescript(fh.read())
        self._migrate_schema()
        self._conn.commit()

    def _migrate_schema(self):
        """Apply additive column migrations to an existing db (caller holds self._lock)."""
        for table, column, ddl in self._MIGRATIONS:
            cols = {r[1] for r in self._conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if column not in cols:
                self._conn.execute(ddl)

    @_synchronized
    def close(self):
        self._conn.close()

    # ----- append -----

    @_synchronized
    def append(self, record: dict) -> str:
        """Insert a lesson. Returns a restart-stable uuid4 hex `ref` (NEVER a rowid)."""
        task_type = record.get("task_type")
        if task_type not in VALID_TASK_TYPES:
            raise ValueError(f"task_type must be one of {sorted(VALID_TASK_TYPES)}, got {task_type!r}")
        source = record.get("source", "auto")
        if source not in VALID_SOURCES:
            raise ValueError(f"source must be one of {sorted(VALID_SOURCES)}, got {source!r}")
        lesson = record.get("lesson")
        if not lesson or not str(lesson).strip():
            raise ValueError("lesson text is required")
        provenance = record.get("provenance")
        if not provenance:
            raise ValueError("provenance is required")

        ref = uuid.uuid4().hex  # restart-stable UUID; NOT a sqlite rowid
        tags = record.get("tags", []) or []
        if not isinstance(tags, (list, tuple)):
            raise ValueError("tags must be a list")
        tags = [str(t) for t in tags]
        ts = float(record.get("ts", time.time()))

        self._conn.execute(
            """
            INSERT INTO lessons (id, lesson, task_type, what_failed, resolution, tags,
                                 provenance, source, migrated, wins, losses, uses,
                                 last_accessed_at, ts, tombstoned)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, 0)
            """,
            (
                ref,
                str(lesson),
                task_type,
                record.get("what_failed"),
                record.get("resolution"),
                json.dumps(tags),
                provenance,
                source,
                1 if record.get("migrated", False) else 0,
                ts,
            ),
        )
        # mirror into the FTS index
        self._conn.execute(
            "INSERT INTO lessons_fts (lesson, tags, ref) VALUES (?, ?, ?)",
            (str(lesson), " ".join(tags), ref),
        )
        self._conn.commit()
        return ref

    # ----- recall -----

    @_synchronized
    def recall(self, query, *, kind=None, domain_filter=None, limit=5, call_site=None):
        """Keyword recall via FTS5 (BM25) over non-tombstoned rows.

        ALWAYS emits a circulation receipt. call_site is REQUIRED.
        Returns (records, receipt_dict).
        """
        if not call_site:
            raise ValueError("call_site is required for recall (receipt evidence; never anonymous)")
        _t0 = _perf_clock()
        if domain_filter is not None:
            raise NotImplementedError(
                "domain_filter is not implemented in the engine unit; pass None."
            )

        match_expr = _fts_escape(query)
        records: list[dict] = []
        if match_expr:
            sql = """
                SELECT l.id, bm25(lessons_fts) AS rank
                FROM lessons_fts
                JOIN lessons l ON l.id = lessons_fts.ref
                WHERE lessons_fts MATCH ? AND l.tombstoned = 0
            """
            params: list = [match_expr]
            if kind is not None:
                sql += " AND l.task_type = ?"
                params.append(kind)
            sql += " ORDER BY rank LIMIT ?"
            params.append(int(limit))
            rows = self._conn.execute(sql, params).fetchall()
            ids = [r[0] for r in rows]
            records = [self.get(i) for i in ids]
            records = [r for r in records if r is not None]
            records = self._rerank(query, records)[: int(limit)]

        latency_ms = (_perf_clock() - _t0) * 1000.0
        timed_out = latency_ms > RECALL_BUDGET_MS
        if timed_out:
            _log.warning(
                "recall latency budget breached: %.1fms > RECALL_BUDGET_MS=%dms "
                "(call_site=%s, kind=%s, n=%d) -- results returned, receipt timed_out=1",
                latency_ms, RECALL_BUDGET_MS, call_site,
                "hit" if records else "miss", len(records),
            )

        receipt = Receipt(
            call_site=call_site,
            query=str(query),
            kind="hit" if records else "miss",
            lesson_refs=[r["id"] for r in records],
            latency_ms=latency_ms,
            timed_out=timed_out,
        )
        insert_receipt(self._conn, receipt)

        if records:
            now = time.time()
            self._conn.executemany(
                "UPDATE lessons SET uses = uses + 1, last_accessed_at = ? WHERE id = ?",
                [(now, r["id"]) for r in records],
            )
            self._conn.commit()
            for r in records:
                r["uses"] += 1
                r["last_accessed_at"] = now

        return records, receipt.to_dict()

    def _rerank(self, query, records):
        """Optional embedder re-rank as a tie-break over FTS order. Stable for ties."""
        if not records:
            return records
        q_vec = self._embedder.embed(str(query))
        scored = []
        for idx, rec in enumerate(records):
            text = rec["lesson"] + " " + " ".join(rec.get("tags", []))
            sim = self._embedder.similarity(q_vec, self._embedder.embed(text))
            scored.append((idx, sim, rec))
        scored.sort(key=lambda t: (-t[1], t[0]))
        return [rec for _, _, rec in scored]

    # ----- signal (non-constant by construction) -----

    @_synchronized
    def signal(self, ref, *, valence, derivation):
        """Record an outcome-derived valence against a lesson.

        Non-constant BY CONSTRUCTION (C5):
          * derivation is REQUIRED and MUST be in VALID_DERIVATIONS.
          * valence MUST be a real number derived from an outcome (bool rejected).
        """
        if derivation is None or derivation == "" or derivation not in VALID_DERIVATIONS:
            raise ConstantValenceError(
                f"derivation must be one of {sorted(VALID_DERIVATIONS)}; "
                f"a missing/invalid derivation is the forbidden constant-valence path"
            )
        if isinstance(valence, bool) or not isinstance(valence, numbers.Real):
            raise ValueError("valence must be a real number derived from an outcome, not a constant boolean")
        valence = float(valence)

        rec = self.get(ref)
        if rec is None:
            raise KeyError(f"unknown lesson ref {ref!r}")

        self._conn.execute(
            "INSERT INTO signals (id, lesson_ref, valence, derivation, ts) VALUES (?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, ref, valence, derivation, time.time()),
        )
        if valence > 0:
            self._conn.execute("UPDATE lessons SET wins = wins + 1 WHERE id = ?", (ref,))
        elif valence < 0:
            self._conn.execute("UPDATE lessons SET losses = losses + 1 WHERE id = ?", (ref,))
        self._conn.commit()
        return {"ok": True, "ref": ref, "valence": valence, "derivation": derivation}

    # ----- forget -----

    @_synchronized
    def forget(self, ref):
        """Tombstone a lesson and remove it from the FTS index (excluded from recall)."""
        cur = self._conn.execute("UPDATE lessons SET tombstoned = 1 WHERE id = ?", (ref,))
        self._conn.execute("DELETE FROM lessons_fts WHERE ref = ?", (ref,))
        self._conn.commit()
        if cur.rowcount == 0:
            return None
        return {"ok": True, "ref": ref, "tombstoned": True}

    # ----- helpers -----

    @_synchronized
    def get(self, ref) -> dict | None:
        cur = self._conn.execute(
            """SELECT id, lesson, task_type, what_failed, resolution, tags, provenance,
                      source, migrated, wins, losses, uses, last_accessed_at, ts, tombstoned
               FROM lessons WHERE id = ?""",
            (ref,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "lesson": row[1],
            "task_type": row[2],
            "what_failed": row[3],
            "resolution": row[4],
            "tags": json.loads(row[5]),
            "provenance": row[6],
            "source": row[7],
            "migrated": bool(row[8]),
            "wins": row[9],
            "losses": row[10],
            "uses": row[11],
            "last_accessed_at": row[12],
            "ts": row[13],
            "tombstoned": bool(row[14]),
        }

    @_synchronized
    def mark_consumed(self, receipt_id: str) -> bool:
        return mark_consumed(self._conn, receipt_id)

    @_synchronized
    def set_source(self, ref, source: str) -> dict | None:
        """Set a lesson's source ('auto' | 'reviewed'). Returns the updated record or None."""
        if source not in VALID_SOURCES:
            raise ValueError(f"source must be one of {sorted(VALID_SOURCES)}, got {source!r}")
        cur = self._conn.execute(
            "UPDATE lessons SET source = ? WHERE id = ?", (source, ref)
        )
        if cur.rowcount == 0:
            return None
        self._conn.commit()
        return self.get(ref)

    @_synchronized
    def success_rate(self, ref) -> float | None:
        """DERIVED wins/(wins+losses). None when there are no signals yet."""
        rec = self.get(ref)
        if rec is None:
            return None
        total = rec["wins"] + rec["losses"]
        if total == 0:
            return None
        return rec["wins"] / total

    @_synchronized
    def valence_window(self, window: int | None = None) -> list[float]:
        """Return recorded valences (most-recent first), optionally limited to `window`."""
        sql = "SELECT valence FROM signals ORDER BY ts DESC, rowid DESC"
        params: list = []
        if window is not None:
            sql += " LIMIT ?"
            params.append(int(window))
        return [r[0] for r in self._conn.execute(sql, params).fetchall()]

    @_synchronized
    def recall_latency_window(self, window: int | None = None) -> list[float]:
        """Return recorded recall latencies in ms (most-recent first)."""
        sql = "SELECT latency_ms FROM receipts ORDER BY ts DESC, rowid DESC"
        params: list = []
        if window is not None:
            sql += " LIMIT ?"
            params.append(int(window))
        return [r[0] for r in self._conn.execute(sql, params).fetchall()]

    @_synchronized
    def circulation(self, window: int | None = None) -> int:
        """AC1 numerator primitive: count of DISTINCT fork-authored (migrated=False)
        lesson refs that appear in a consumed hit receipt."""
        sql = (
            "SELECT lesson_refs FROM receipts WHERE consumed = 1 AND kind = 'hit' "
            "ORDER BY ts DESC, rowid DESC"
        )
        params: list = []
        if window is not None:
            sql += " LIMIT ?"
            params.append(int(window))
        rows = self._conn.execute(sql, params).fetchall()

        distinct_refs: set[str] = set()
        for (refs_json,) in rows:
            for ref in json.loads(refs_json):
                distinct_refs.add(ref)
        if not distinct_refs:
            return 0

        placeholders = ",".join("?" for _ in distinct_refs)
        rows = self._conn.execute(
            f"SELECT id FROM lessons WHERE migrated = 0 AND id IN ({placeholders})",
            tuple(distinct_refs),
        ).fetchall()
        return len(rows)

    @_synchronized
    def aggregate(self, window: int | None = None) -> dict:
        """Return aggregate statistics for the store."""
        sql = "SELECT COUNT(*) FROM lessons WHERE tombstoned = 0"
        total_lessons = self._conn.execute(sql).fetchone()[0]

        sql2 = (
            "SELECT COUNT(*) FROM receipts WHERE kind = 'hit'"
        )
        recall_hits = self._conn.execute(sql2).fetchone()[0]

        sql3 = (
            "SELECT COUNT(*) FROM receipts WHERE kind = 'miss'"
        )
        recall_misses = self._conn.execute(sql3).fetchone()[0]

        consumed = self.circulation(window=window)

        all_signals = self.valence_window(window=None)
        signalled_lessons = len({
            r[0] for r in
            self._conn.execute(
                "SELECT DISTINCT lesson_ref FROM signals"
            ).fetchall()
        })

        variance = 0.0
        if len(all_signals) >= 2:
            mean = sum(all_signals) / len(all_signals)
            variance = sum((v - mean) ** 2 for v in all_signals) / len(all_signals)

        return {
            "total_lessons": total_lessons,
            "recall_hits": recall_hits,
            "recall_misses": recall_misses,
            "consumed_hits": consumed,
            "valence_count": len(all_signals),
            "signalled_lessons": signalled_lessons,
            "valence_variance": variance,
        }

    def iter_lessons(self, *, include_tombstoned: bool = False, source: str | None = None):
        """ADDITIVE read-only iterator over lessons (full records, via get())."""
        sql = "SELECT id FROM lessons"
        conds: list[str] = []
        params: list = []
        if not include_tombstoned:
            conds.append("tombstoned = 0")
        if source is not None:
            conds.append("source = ?")
            params.append(source)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY ts DESC"
        for (ref,) in self._conn.execute(sql, params).fetchall():
            rec = self.get(ref)
            if rec is not None:
                yield rec


__all__ = [
    "ExperienceStore",
    "ConstantValenceError",
    "VALID_TASK_TYPES",
    "VALID_SOURCES",
    "VALID_DERIVATIONS",
    "RECALL_BUDGET_MS",
]
