"""Circulation-receipt dataclass + insert/query helpers (AC1 evidence ledger).

A receipt is written on EVERY recall (kind='hit' or kind='miss') — recall is never
silent. `consumed` is flipped True only when the caller signals the recalled context
was actually used; circulation (in store.py) counts distinct fork-authored refs that
appear in a consumed hit receipt.

Ported from AIOS packages/memory/experience-store/receipts.py
Source: commit 089213f, SHA-256 352BD22A...
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field


@dataclass
class Receipt:
    call_site: str
    query: str
    kind: str                                   # 'hit' | 'miss'
    lesson_refs: list[str] = field(default_factory=list)
    consumed: bool = False
    # Latency-budget evidence (M1 gap G5, SPEC §4): the MEASURED recall latency and a
    # budget-breach flag. `timed_out` is orthogonal to kind — a slow HIT is both. It is
    # the observable "recall_miss"-on-timeout signal (never a silent drop). latency_ms
    # feeds a p95 over the receipt ledger.
    latency_ms: float = 0.0
    timed_out: bool = False
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    ts: float = field(default_factory=time.time)

    def to_row(self) -> tuple:
        return (
            self.id,
            json.dumps(self.lesson_refs),
            self.call_site,
            self.query,
            1 if self.consumed else 0,
            self.kind,
            float(self.latency_ms),
            1 if self.timed_out else 0,
            self.ts,
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lesson_refs": list(self.lesson_refs),
            "call_site": self.call_site,
            "query": self.query,
            "consumed": self.consumed,
            "latency_ms": self.latency_ms,
            "timed_out": self.timed_out,
            "kind": self.kind,
            "ts": self.ts,
        }


_INSERT = (
    "INSERT INTO receipts (id, lesson_refs, call_site, query, consumed, kind, "
    "latency_ms, timed_out, ts) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def insert_receipt(conn, receipt: Receipt) -> str:
    """Persist a receipt; returns its id."""
    conn.execute(_INSERT, receipt.to_row())
    conn.commit()
    return receipt.id


def row_to_dict(row) -> dict | None:
    if row is None:
        return None
    return {
        "id": row[0],
        "lesson_refs": json.loads(row[1]),
        "call_site": row[2],
        "query": row[3],
        "consumed": bool(row[4]),
        "kind": row[5],
        "latency_ms": row[6],
        "timed_out": bool(row[7]),
        "ts": row[8],
    }


def get_receipt(conn, receipt_id: str) -> dict | None:
    cur = conn.execute(
        "SELECT id, lesson_refs, call_site, query, consumed, kind, latency_ms, "
        "timed_out, ts FROM receipts WHERE id = ?",
        (receipt_id,),
    )
    return row_to_dict(cur.fetchone())


def mark_consumed(conn, receipt_id: str) -> bool:
    cur = conn.execute(
        "UPDATE receipts SET consumed = 1 WHERE id = ?", (receipt_id,)
    )
    conn.commit()
    return cur.rowcount > 0


__all__ = ["Receipt", "insert_receipt", "get_receipt", "mark_consumed", "row_to_dict"]
