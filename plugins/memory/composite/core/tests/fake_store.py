"""Native FakeStore for B1 core contract tests (M0-B1R — removes AIOS dependency).

Drop-in replacement for the legacy AIOS store.ExperienceStore, implementing the
exact contract surface the 29 B1 tests exercise. No SQLite, no AIOS imports.
Real SQLite/ExperienceStore behavior belongs to B2.
"""

from __future__ import annotations

from typing import Any


_VALID_DERIVATIONS = frozenset({
    "task_completed", "user_correction", "explicit_feedback", "test_result",
})


class ConstantValenceError(ValueError):
    """Raised when derivation is missing or not in the valid set."""


class _FakeReceiptCursor:
    """Minimal cursor shim so tests that reach into ``_conn.execute(...).fetchone()``
    still pass without SQLite."""
    def __init__(self, store: FakeStore) -> None:
        self._store = store

    def fetchone(self) -> tuple | None:
        rx = self._store._receipts
        if not rx:
            return None
        r = rx[-1]
        return (r["call_site"], r["kind"])


class _FakeReceiptConnection:
    """Minimal connection shim — only enough to satisfy the direct-receipt-assertion
    test in test_prefetch.py."""
    def __init__(self, store: FakeStore) -> None:
        self._store = store

    def execute(self, _sql: str) -> _FakeReceiptCursor:
        return _FakeReceiptCursor(self._store)


class FakeStore:
    """Pure-Python fake implementing the ExperienceStore contract B1 tests need."""

    def __init__(self, path: str = ":memory:") -> None:
        del path  # always in-memory for the fake
        self._records: dict[str, dict[str, Any]] = {}
        self._receipts: list[dict[str, Any]] = []
        self._ref_counter = 0
        self._circulation_count = 0
        self._recall_hits = 0
        self._recall_misses = 0
        self._conn = _FakeReceiptConnection(self)

    # -- helpers ---------------------------------------------------------------

    def _next_ref(self) -> str:
        self._ref_counter += 1
        return f"ref-{self._ref_counter}"

    @staticmethod
    def _match(query: str, record: dict[str, Any]) -> bool:
        """Simple keyword match — any query word appears in the lesson text."""
        text = (record.get("lesson") or "").lower()
        return any(word in text for word in query.lower().split())

    # -- public api (mirrors ExperienceStore) ----------------------------------

    def append(self, record: dict[str, Any]) -> str:
        ref = self._next_ref()
        stored = dict(record)
        stored["id"] = ref
        stored.setdefault("wins", 0)
        stored.setdefault("losses", 0)
        stored.setdefault("signals", [])
        self._records[ref] = stored
        return ref

    def close(self) -> None:
        pass  # nothing to close; tests call this in teardown

    def aggregate(self) -> dict[str, Any]:
        active = [r for r in self._records.values() if not r.get("tombstoned")]
        signalled = [r for r in active if r.get("signals")]
        all_signals = [s for r in active for s in r.get("signals", [])]
        valence_values = [s[0] for s in all_signals if isinstance(s[0], (int, float))]

        variance = 0.0
        if len(valence_values) >= 2:
            mean = sum(valence_values) / len(valence_values)
            variance = sum((v - mean) ** 2 for v in valence_values) / len(valence_values)

        return {
            "total_lessons": len(active),
            "recall_hits": self._recall_hits,
            "recall_misses": self._recall_misses,
            "consumed_hits": self._circulation_count,
            "valence_count": len(all_signals),
            "signalled_lessons": len(signalled),
            "valence_variance": variance,
        }

    def circulation(self) -> int:
        return self._circulation_count

    def get(self, ref: str) -> dict[str, Any]:
        if ref not in self._records:
            raise KeyError(ref)
        return self._records[ref]

    def success_rate(self, ref: str) -> float:
        r = self.get(ref)
        wins = r.get("wins", 0)
        losses = r.get("losses", 0)
        total = wins + losses
        return wins / total if total > 0 else 0.0

    def recall(
        self, query: str, *, call_site: str = "unknown", limit: int = 5,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for ref, record in self._records.items():
            if record.get("tombstoned"):
                continue
            if self._match(query, record):
                results.append({
                    "id": ref,
                    "lesson": record.get("lesson", ""),
                    "score": 1.0,
                    "source": record.get("source", "auto"),
                })

        receipt: dict[str, Any] = {
            "id": f"rcpt-{self._ref_counter + 1}",
            "kind": "hit" if results else "miss",
            "call_site": call_site,
        }
        if results:
            self._recall_hits += 1
        else:
            self._recall_misses += 1
        self._receipts.append(receipt)
        return results[:limit], receipt

    def mark_consumed(self, rid: str) -> bool:
        del rid  # fake: just count it
        self._circulation_count += 1
        return True

    def signal(
        self, ref: str, *, valence: float, derivation: str,
    ) -> dict[str, Any]:
        if not derivation or derivation not in _VALID_DERIVATIONS:
            raise ConstantValenceError(
                f"derivation must be one of {sorted(_VALID_DERIVATIONS)}, "
                f"got {derivation!r}"
            )
        if isinstance(valence, bool) or not isinstance(valence, (int, float)):
            raise ValueError(
                f"valence must be numeric, got {type(valence).__name__}"
            )
        if ref not in self._records:
            raise KeyError(ref)
        record = self._records[ref]
        record.setdefault("signals", []).append((valence, derivation))
        if valence > 0:
            record["wins"] = record.get("wins", 0) + 1
        elif valence < 0:
            record["losses"] = record.get("losses", 0) + 1
        return {"ok": True, "derivation": derivation}

    def forget(self, ref: str) -> dict[str, Any] | None:
        if ref not in self._records:
            return None
        self._records[ref]["tombstoned"] = True
        return {"tombstoned": True}

    def valence_window(self) -> list:
        all_signals: list = []
        for r in self._records.values():
            all_signals.extend(r.get("signals", []))
        return all_signals[-10:]
