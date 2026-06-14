"""AC-R4 / AC-R2 / AC-R6 — the REAL D3b pre-delegation recall hook
(`tools.delegate_tool._apply_predelegation_recall`).

Asserts: it augments the child context from a live composite, does NOT mutate task_list
(no double-prepend on reuse), defers consumption to after-build (the helper never marks
consumed), and is a clean no-op without a composite or against a Mock parent.
"""

from __future__ import annotations

import pytest

from agent.memory_manager import MemoryManager
from tools.delegate_tool import _apply_predelegation_recall

try:
    from plugins.memory.composite.provider import ExperienceStore, HermesCompositeProvider

    _HAVE_AIOS = True
except Exception:  # pragma: no cover - sibling AIOS repo absent
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(not _HAVE_AIOS, reason="AIOS composite/store not importable")


class _Parent:
    def __init__(self, manager):
        self._memory_manager = manager


def _parent_with_lesson():
    store = ExperienceStore(db_path=":memory:")
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize("p", agent_context="primary")
    mgr = MemoryManager()
    mgr.add_provider(comp)
    comp.record_fork_lesson(
        "Run the grommet calibration before the swizzle stage.",
        provenance="fork:background_review:p", task_type="implementation-pattern",
    )
    return store, comp, _Parent(mgr)


def test_augments_context_without_mutation_and_defers_consume():
    store, comp, parent = _parent_with_lesson()
    task_list = [{"goal": "grommet calibration swizzle"}]

    augmented, receipts, c = _apply_predelegation_recall(parent, task_list)

    assert 0 in augmented and "grommet" in augmented[0].lower()
    assert 0 in receipts and c is comp
    assert "context" not in task_list[0]          # R2-7: task_list NOT mutated
    assert store.circulation() == 0               # R2-2: not consumed at recall time

    # "after successful build" -> confirm -> circulation moves
    assert comp.confirm_consumed(receipts[0]) is True
    assert store.circulation() == 1


def test_build_failure_does_not_overcount():
    """R2-2/AC-R2: if the child build fails (modeled here by NOT confirming), the lesson is
    never marked consumed -> no AC1 over-count."""
    store, comp, parent = _parent_with_lesson()
    augmented, receipts, _ = _apply_predelegation_recall(parent, [{"goal": "grommet swizzle"}])
    assert receipts                                # a hit receipt exists
    assert store.circulation() == 0               # build "failed" (no confirm) -> not counted


def test_no_double_prepend_on_reuse():
    """R2-6/AC-R6: re-running the hook over the same task_list yields identical augmentation
    (one block), never block+block, and never mutates the caller's context."""
    store, comp, parent = _parent_with_lesson()
    task_list = [{"goal": "grommet calibration swizzle", "context": "orig"}]

    aug1, _, _ = _apply_predelegation_recall(parent, task_list)
    aug2, _, _ = _apply_predelegation_recall(parent, task_list)

    assert aug1[0] == aug2[0]
    assert aug1[0].lower().count("grommet calibration") == 1
    assert aug1[0].endswith("orig")
    assert task_list[0]["context"] == "orig"      # caller's dict untouched


def test_noop_without_composite():
    parent = _Parent(MemoryManager())  # no composite registered
    task_list = [{"goal": "anything", "context": "orig"}]
    augmented, receipts, c = _apply_predelegation_recall(parent, task_list)
    assert augmented == {} and receipts == {} and c is None
    assert task_list[0]["context"] == "orig"


def test_robust_against_mock_parent():
    from unittest.mock import MagicMock

    parent = MagicMock()  # every hasattr is True; recall_for returns a non-tuple Mock
    task_list = [{"goal": "x", "context": "orig"}]
    augmented, receipts, _ = _apply_predelegation_recall(parent, task_list)
    # The unpack of a Mock result raises and is caught -> skipped, no crash, no mutation.
    assert augmented == {} and receipts == {}
    assert task_list[0]["context"] == "orig"
