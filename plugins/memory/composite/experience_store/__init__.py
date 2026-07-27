"""Native experience-store engine — vendor copy for hermes-agent.

This package provides a self-contained SQLite-backed ExperienceStore with FTS5
recall, outcome signalling, and circulation evidence. Zero AIOS dependency.

Ported from AIOS packages/memory/experience-store/ (commit 089213f).
"""

from .store import (
    ExperienceStore,
    ConstantValenceError,
    VALID_TASK_TYPES,
    VALID_SOURCES,
    VALID_DERIVATIONS,
    RECALL_BUDGET_MS,
)
from .embed import Embedder, LexicalEmbedder
from .receipts import Receipt, insert_receipt, get_receipt, mark_consumed

__all__ = [
    "ExperienceStore",
    "ConstantValenceError",
    "Embedder",
    "LexicalEmbedder",
    "Receipt",
    "insert_receipt",
    "get_receipt",
    "mark_consumed",
    "VALID_TASK_TYPES",
    "VALID_SOURCES",
    "VALID_DERIVATIONS",
    "RECALL_BUDGET_MS",
]
