"""M1 Task 2 BLOCKER #2 — the fork->composite append path.

These tests prove the structural fix for AC1's zero numerator: the background-review
fork's authored writes (memory + skill) are mirrored into the experience store as
``migrated=False`` lessons, which then become eligible for circulation once recalled
into a consumed context.
"""

from __future__ import annotations

import json

import pytest

import agent.background_review as bg

# The composite + store engines live in the sibling AIOS repo. Skip cleanly if they are
# not on the path (e.g. CI without the sibling checkout) — this is a dev-instance test.
try:
    from plugins.memory.composite.provider import (  # noqa: E402
        ExperienceStore,
        HermesCompositeProvider,
    )

    _HAVE_AIOS = True
except Exception:  # pragma: no cover - environment-dependent
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(
    not _HAVE_AIOS, reason="AIOS experience-store/composite packages not importable"
)


# --- fixtures -------------------------------------------------------------------------

def _assistant_call(call_id: str, name: str, args: dict) -> dict:
    return {
        "role": "assistant",
        "tool_calls": [
            {"id": call_id, "function": {"name": name, "arguments": json.dumps(args)}}
        ],
    }


def _tool_result(call_id: str, success: bool = True, **extra) -> dict:
    payload = {"success": success, "message": "Entry added", **extra}
    return {"role": "tool", "tool_call_id": call_id, "content": json.dumps(payload)}


from agent.memory_manager import MemoryManager  # noqa: E402


def _manager_with(comp):
    """A real MemoryManager wrapping the given provider — the chassis routes fork lessons
    through generic ``MemoryManager.on_background_review`` fan-out (no get_provider lookup)."""
    mgr = MemoryManager()
    mgr.add_provider(comp)
    return mgr


class _FakeAgent:
    def __init__(self, manager, session_id="sess-1"):
        self._memory_manager = manager
        self.session_id = session_id


# --- extraction ------------------------------------------------------------------------

def test_extract_pairs_new_writes_and_skips_prior_and_removals():
    prior = [_tool_result("old1")]  # a write from before this review pass
    review = [
        # stale: same tool_call_id as a prior result -> must be skipped
        _assistant_call("old1", "memory", {"action": "add", "content": "stale"}),
        _tool_result("old1"),
        # new memory write -> lesson
        _assistant_call(
            "c1", "memory",
            {"action": "add", "target": "user", "content": "User prefers concise answers."},
        ),
        _tool_result("c1", target="user"),
        # new skill write -> lesson
        _assistant_call(
            "c2", "skill_manage",
            {"action": "create", "name": "deploy-flow", "content": "Run tests before deploy."},
        ),
        _tool_result("c2"),
        # removal -> no durable content, skipped
        _assistant_call("c3", "memory", {"action": "remove", "old_text": "x"}),
        _tool_result("c3"),
        # failed write -> skipped
        _assistant_call("c4", "memory", {"action": "add", "content": "nope"}),
        _tool_result("c4", success=False),
    ]

    lessons = bg.extract_fork_authored_lessons(review, prior)

    texts = [lesson["lesson"] for lesson in lessons]
    assert "User prefers concise answers." in texts
    assert any(t.startswith("[skill:deploy-flow]") for t in texts)
    assert "stale" not in " ".join(texts)
    assert len(lessons) == 2
    # task_type mapping + provenance-ready tags
    by_text = {lesson["lesson"]: lesson for lesson in lessons}
    assert by_text["User prefers concise answers."]["task_type"] == "workflow"
    skill_lesson = next(t for t in lessons if t["lesson"].startswith("[skill:"))
    assert skill_lesson["task_type"] == "implementation-pattern"
    assert "skill" in skill_lesson["tags"] and "deploy-flow" in skill_lesson["tags"]


# --- append + circulation --------------------------------------------------------------

def test_fork_lessons_write_migrated_false_and_circulate():
    store = ExperienceStore(db_path=":memory:")
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    agent = _FakeAgent(_manager_with(comp))

    review = [
        _assistant_call(
            "c1", "memory",
            {"action": "add", "target": "user", "content": "User prefers concise answers."},
        ),
        _tool_result("c1", target="user"),
    ]

    written = bg.record_fork_authored_lessons(agent, review, prior_snapshot=[])
    assert written == 1

    # The row exists, fork-authored (migrated=False), with fork provenance.
    rows = list(store.iter_lessons())
    assert len(rows) == 1
    row = rows[0]
    assert row["migrated"] is False
    assert row["source"] == "reviewed"
    assert row["provenance"] == "fork:background_review:sess-1"

    # AC1 numerator: recall the fork lesson into a consumed context -> circulation >= 1.
    assert store.circulation() == 0  # nothing consumed yet
    records, receipt = store.recall("concise answers", call_site="pre-delegation")
    assert records and receipt["kind"] == "hit"
    assert store.mark_consumed(receipt["id"]) is True
    assert store.circulation() >= 1  # the predecessor's zero is broken


def test_record_is_noop_without_composite_provider():
    # builtin-only / non-composite config: no manager at all, or a real manager with no
    # provider implementing on_background_review -> fan-out writes nothing.
    assert bg.record_fork_authored_lessons(_FakeAgent(None), [], []) == 0

    review = [
        _assistant_call("c1", "memory", {"action": "add", "content": "x"}),
        _tool_result("c1"),
    ]
    # Real manager, no recall/storage provider registered: clean no-op.
    assert bg.record_fork_authored_lessons(_FakeAgent(MemoryManager()), review, []) == 0


# --- R3: staged writes must not be mirrored ---------------------------------------------

def test_staged_writes_are_not_mirrored():
    """A successful-but-STAGED write (memory.write_approval gate) is not committed and may
    be rejected at approve-time — it must not become an experience lesson (store/disk skew)."""
    review = [
        _assistant_call("c1", "memory", {"action": "add", "target": "user", "content": "X"}),
        _tool_result("c1", staged=True),
    ]
    assert bg.extract_fork_authored_lessons(review, []) == []


# --- R5+: id-less tool results can't be deduped → never mirrored ------------------------

def test_idless_tool_results_are_not_mirrored():
    review = [
        {
            "role": "assistant",
            "tool_calls": [
                {"id": "", "function": {"name": "memory",
                                        "arguments": json.dumps({"action": "add", "content": "Y"})}}
            ],
        },
        {"role": "tool", "tool_call_id": "", "content": json.dumps({"success": True})},
    ]
    assert bg.extract_fork_authored_lessons(review, []) == []


# --- R6 / R6b: silent-failure guards ----------------------------------------------------

def test_r6_warns_when_lessons_extracted_but_none_written(caplog):
    """Store rejects every append (version skew) → written 0 → WARNING, never silent."""
    import logging

    from agent.memory_provider import MemoryProvider

    class _RejectingComposite(MemoryProvider):
        @property
        def name(self):
            return "composite"

        def is_available(self):
            return True

        def initialize(self, session_id, **kwargs):
            pass

        def get_tool_schemas(self):
            return []

        def on_background_review(self, candidates, *, session_id=""):
            # Store rejects every append (version skew) -> 0 written.
            return 0

    agent = _FakeAgent(_manager_with(_RejectingComposite()))
    review = [
        _assistant_call("c1", "memory", {"action": "add", "content": "a real lesson"}),
        _tool_result("c1"),
    ]
    with caplog.at_level(logging.WARNING, logger="agent.background_review"):
        written = bg.record_fork_authored_lessons(agent, review, [])
    assert written == 0
    assert any("wrote 0" in r.getMessage() for r in caplog.records)


def test_r6b_info_when_writes_seen_but_none_mapped(caplog):
    """Staged-only writes: fork tool calls happened but none mapped to lessons → INFO
    (distinguishes a mapping regression from a genuinely tool-less review)."""
    import logging

    store = ExperienceStore(db_path=":memory:")
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    agent = _FakeAgent(_manager_with(comp))
    review = [
        _assistant_call("c1", "memory", {"action": "add", "content": "X"}),
        _tool_result("c1", staged=True),
    ]
    with caplog.at_level(logging.INFO, logger="agent.background_review"):
        written = bg.record_fork_authored_lessons(agent, review, [])
    assert written == 0
    assert any("0 mapped to lessons" in r.getMessage() for r in caplog.records)
