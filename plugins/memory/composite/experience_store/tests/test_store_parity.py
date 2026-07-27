"""TDD RED — Store parity tests for M0-B2R repair (outbox, aggregate, iter_lessons, get_receipt).

These tests verify the native ExperienceStore restores full AIOS parity
required for native binding.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest


@pytest.fixture
def store():
    from plugins.memory.composite.experience_store import ExperienceStore
    s = ExperienceStore(db_path=":memory:")
    yield s
    s.close()


# ============================================================================
# FI-01: Outbox APIs
# ============================================================================

def test_outbox_table_exists(store) -> None:
    """The outbox table must exist in the schema."""
    tables = {
        r[0] for r in
        store._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    }
    assert "outbox" in tables, f"outbox table missing; tables: {tables}"


def test_outbox_enqueue_claim_confirm(store) -> None:
    """Outbox: enqueue → claim → confirm lifecycle."""
    ref = store.append({
        "lesson": "Test outbox lifecycle",
        "task_type": "implementation-pattern",
        "tags": ["test"],
        "provenance": "test:outbox",
        "source": "auto",
    })

    # Enqueue a pending signal
    entry_id = store.outbox_enqueue(
        lesson_ref=ref, valence=1.0, derivation="test_result"
    )
    assert isinstance(entry_id, str)

    # Claim the entry
    claimed = store.outbox_claim()
    assert claimed is not None
    assert claimed["lesson_ref"] == ref
    assert claimed["valence"] == 1.0

    # Confirm it was processed
    store.outbox_confirm(claimed["id"])

    # Confirm again should be a no-op (idempotent)
    store.outbox_confirm(claimed["id"])


def test_outbox_fail_and_reclaim(store) -> None:
    """Outbox: fail → reclaim cycle."""
    ref = store.append({
        "lesson": "Test outbox recovery",
        "task_type": "error-recovery",
        "tags": ["test"],
        "provenance": "test:outbox",
        "source": "auto",
    })

    entry_id = store.outbox_enqueue(
        lesson_ref=ref, valence=-0.5, derivation="user_correction"
    )
    assert isinstance(entry_id, str)

    # Claim
    claimed = store.outbox_claim()
    assert claimed is not None

    # Fail it (simulating a transient error)
    store.outbox_fail(claimed["id"])

    # Reclaim should eventually pick it up again
    store.outbox_reclaim(max_age_seconds=0)
    reclaimed = store.outbox_claim()
    assert reclaimed is not None
    assert reclaimed["lesson_ref"] == ref

    # Confirm on second attempt
    store.outbox_confirm(reclaimed["id"])


def test_outbox_claim_returns_none_when_empty(store) -> None:
    """claim() on empty outbox returns None."""
    claimed = store.outbox_claim()
    assert claimed is None


def test_outbox_multiple_entries_fifo(store) -> None:
    """Outbox entries are claimed in FIFO order."""
    ref1 = store.append({
        "lesson": "First",
        "task_type": "implementation-pattern",
        "tags": ["test"],
        "provenance": "test:outbox",
        "source": "auto",
    })
    ref2 = store.append({
        "lesson": "Second",
        "task_type": "implementation-pattern",
        "tags": ["test"],
        "provenance": "test:outbox",
        "source": "auto",
    })

    store.outbox_enqueue(lesson_ref=ref1, valence=0.5, derivation="task_completed")
    store.outbox_enqueue(lesson_ref=ref2, valence=-1.0, derivation="user_correction")

    first = store.outbox_claim()
    second = store.outbox_claim()

    assert first["lesson_ref"] == ref1
    assert second["lesson_ref"] == ref2

    store.outbox_confirm(first["id"])
    store.outbox_confirm(second["id"])


# ============================================================================
# FI-02: Aggregate contract expansion
# ============================================================================

def test_aggregate_has_full_contract_fields(store) -> None:
    """aggregate() must return the expanded 14-field set (AIOS parity)."""
    result = store.aggregate()
    required_fields = {
        "total_lessons",
        "recall_hits",
        "recall_misses",
        "consumed_hits",
        "valence_count",
        "signalled_lessons",
        "valence_variance",
        # FI-02: fields that were missing from B2A
        "fork_authored",
        "migrated_lessons",
        "tombstoned",
        "never_recalled",
        "unsignalled_lessons",
    }
    missing = required_fields - set(result.keys())
    assert not missing, f"aggregate() missing fields: {missing}"


def test_aggregate_counts_fork_authored(store) -> None:
    """fork_authored counts only migrated=0 (non-seed) lessons."""
    # Append a fork-authored lesson (migrated=0 by default)
    store.append({
        "lesson": "Fork-authored pattern",
        "task_type": "implementation-pattern",
        "tags": ["test"],
        "provenance": "test:aggregate",
        "source": "auto",
    })
    result = store.aggregate()
    assert result["fork_authored"] >= 1
    assert result["total_lessons"] >= 1


def test_aggregate_counts_tombstoned(store) -> None:
    """tombstoned counts tombstoned lessons."""
    ref = store.append({
        "lesson": "Lesson to tombstone",
        "task_type": "implementation-pattern",
        "tags": ["test"],
        "provenance": "test:aggregate",
        "source": "auto",
    })
    store.forget(ref)
    result = store.aggregate()
    assert result["tombstoned"] >= 1


# ============================================================================
# FI-04: iter_lessons sort order
# ============================================================================

def test_iter_lessons_ascending_order(store) -> None:
    """iter_lessons must return lessons in ASCENDING ts order (not DESC)."""
    refs = []
    for i in range(3):
        ref = store.append({
            "lesson": f"Lesson {i}",
            "task_type": "implementation-pattern",
            "tags": ["test"],
            "provenance": "test:iter",
            "source": "auto",
        })
        refs.append(ref)
        time.sleep(0.001)  # ensure distinct timestamps

    lessons = list(store.iter_lessons())
    assert len(lessons) == 3
    # Ascending order: earliest ts first
    timestamps = [r["ts"] for r in lessons]
    assert timestamps == sorted(timestamps), (
        f"Expected ascending order, got: {timestamps}"
    )


# ============================================================================
# FI-05: get_receipt as instance method
# ============================================================================

def test_get_receipt_instance_method(store) -> None:
    """ExperienceStore must expose get_receipt() as an instance method."""
    assert hasattr(store, "get_receipt"), "store missing get_receipt() method"
    assert callable(store.get_receipt)


def test_get_receipt_returns_receipt_after_recall(store) -> None:
    """After a recall, get_receipt() returns the written receipt."""
    store.append({
        "lesson": "Some lesson for receipt test",
        "task_type": "implementation-pattern",
        "tags": ["test"],
        "provenance": "test:receipt",
        "source": "auto",
    })
    records, receipt_dict = store.recall("receipt test", call_site="test-callsite")

    receipt_id = receipt_dict["id"]
    fetched = store.get_receipt(receipt_id)
    assert fetched is not None
    assert fetched["id"] == receipt_id
    assert fetched["kind"] == receipt_dict["kind"]
    assert fetched["call_site"] == "test-callsite"
