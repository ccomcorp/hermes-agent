#!/usr/bin/env python3
"""Synthetic-week AC1 harness — M1 Task 2 BLOCKER #4 (dev-instance, no .31).

Replays a synthetic week of agent activity through the REAL composite + the REAL
fork->composite append path (``agent.background_review.record_fork_authored_lessons``)
and asserts AC1 against the turnkey AIOS health metric (``ExperienceHealth``).

Why this exists / how it differs from the AIOS unit tests: those pre-seed the store
directly, so they never exercise the fork write leg — the exact gap that left the
predecessor at "15 lessons, 0 reads". This harness drives the full loop:

    fork authors lessons (migrated=False)
        -> store
        -> recalled at a real call site (comp.prefetch)
        -> marked consumed
        -> ExperienceHealth.circulation_report() counts them

and pins the two anti-gaming guarantees AC1 is really about:
  * SEED/MIGRATED reads do NOT count — a migrated=True lesson is recalled AND consumed
    here, yet circulation excludes it (negative control).
  * MISSES are never silent — a no-match query writes a kind='miss' receipt.

WHAT THIS PROVES — and what it does NOT (honest scope, per adversarial review):
  PROVES: the fork-write leg populates the migrated=0 band; circulation()'s migrated
    exclusion is real (SQL-enforced); misses emit receipts; the WRITE_ONLY_MEMORY flag
    toggles. An independent SQL oracle (not circulation()/aggregate()) cross-checks the
    count so producer and grader don't share one code path.
  DOES NOT PROVE: (1) that the recalled context actually influenced the model — "consumed"
    is set by composite.prefetch the moment it returns non-empty text (composite_provider
    .py mark_consumed), NOT when the model reads it. This is the handoff's open Sev-2 #8
    (gameable-count) and is an AC1-DEFINITION limit inherited from the AIOS composite, not
    fixable here without a chassis injection-confirmation callback. (2) End-to-end chassis
    injection — this harness calls comp.prefetch directly, bypassing memory_manager
    .prefetch_all and prompt assembly (the AIOS prefetch docstring marks that DEFERRED).
  So: this gates the store/health accounting + the fork-write leg. It is NOT a substitute
  for a live, registered-composite run that confirms recalled lessons reach the prompt.

Run:  python scripts/synthetic_week_ac1.py
Exit 0 = AC1 holds; 1 = AC1 violated. Pure stdlib + the AIOS packages (sibling repo).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# --- path bootstrap -------------------------------------------------------------------
# Repo root (so `plugins.memory.composite` + `agent.background_review` import) and the
# AIOS health package (so `experience_health` imports). The composite plugin itself adds
# the AIOS composite/store dirs on import.
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_HEALTH_DIR = os.environ.get("AIOS_HEALTH_DIR") or str(
    _REPO_ROOT.parent / "aios" / "packages" / "health"
)
if os.path.isdir(_HEALTH_DIR) and _HEALTH_DIR not in sys.path:
    sys.path.insert(0, _HEALTH_DIR)

from agent.background_review import record_fork_authored_lessons  # noqa: E402
from experience_health import ExperienceHealth  # noqa: E402  (AIOS health pkg on path)
from plugins.memory.composite.provider import (  # noqa: E402  (inserts AIOS pkgs)
    ExperienceStore,
    HermesCompositeProvider,
)


# --- the synthetic week ---------------------------------------------------------------
# Each fork lesson uses DISTINCT vocabulary so an FTS query hits exactly its target —
# the circulation count is then deterministic (no cross-matching inflation).
#
# (tool_name, tool_args, the work-turn query that recalls it on a later day)
_FORK_WRITES = [
    (
        "skill_manage",
        {
            "action": "create",
            "name": "deploy-zephyr",
            "content": "When the zephyr deploy stalls, clear the quux lockfile before retrying.",
        },
        "zephyr quux lockfile",
    ),
    (
        "memory",
        {
            "action": "add",
            "target": "user",
            "content": "Frobnicate the widget cache with the vorpal flag to avoid stale renders.",
        },
        "frobnicate vorpal widget",
    ),
    (
        "skill_manage",
        {
            "action": "patch",
            "name": "grommet-pipeline",
            "new_string": "Run the grommet calibration before the swizzle stage or the build wedges.",
        },
        "grommet calibration swizzle",
    ),
]

# A migrated seed lesson — the negative control. Recalled AND consumed below, but it must
# NOT count toward circulation (migrated reads are excluded by construction).
_MIGRATED_SEED = {
    "lesson": "Legacy migrated note about the plover subsystem timeout.",
    "task_type": "workflow",
    "tags": ["seed", "legacy"],
    "provenance": "migration:v0",
    "source": "auto",
    "migrated": True,
}
_SEED_QUERY = "plover subsystem timeout"

# A normal turn. Under the #5 gate, sync_turn appends NOTHING to the store (brain-observe
# only) — included here to prove the per-turn path no longer pollutes the corpus.
_OBSERVE_TURN = (
    "How does the griffin telemetry feed work?",
    "Griffin telemetry rides the snark bus and is sampled hourly.",
)

# A work-turn query that matches NOTHING — must produce a recall_miss receipt (never silent).
_MISS_QUERY = "nonexistent flibbertigibbet contraption"


def _review_messages(writes):
    """Build a simulated background-review message log (assistant tool_calls + successful
    tool results) so the harness drives the REAL extraction/append path, not a shortcut."""
    msgs = []
    for i, (name, args, _query) in enumerate(writes):
        cid = f"call-{name}-{i}"
        msgs.append(
            {
                "role": "assistant",
                "tool_calls": [
                    {"id": cid, "function": {"name": name, "arguments": json.dumps(args)}}
                ],
            }
        )
        msgs.append(
            {
                "role": "tool",
                "tool_call_id": cid,
                "content": json.dumps(
                    {"success": True, "message": "saved", "target": args.get("target", "")}
                ),
            }
        )
    return msgs


class _ForkAgent:
    """Minimal parent-agent surface the fork-append path reaches into."""

    def __init__(self, manager, session_id="synthetic-week"):
        self._memory_manager = manager
        self.session_id = session_id


def run_synthetic_week(db_path: str = ":memory:") -> dict:
    """Drive the full week and return a result dict (report + expectations) for callers.

    Does NOT assert — the script ``main()`` and the pytest both consume this and apply
    their own checks, keeping the replay logic single-sourced.
    """
    from agent.memory_manager import MemoryManager

    store = ExperienceStore(db_path=db_path)
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize("synthetic-week")
    # Drive the fork-append leg through a REAL MemoryManager so AC1 exercises the generic,
    # capability-guarded on_background_review fan-out end-to-end (no get_provider lookup).
    manager = MemoryManager()
    manager.add_provider(comp)
    agent = _ForkAgent(manager)

    # Days 1-2 — the background-review fork authors lessons through the composite.
    fork_written = record_fork_authored_lessons(agent, _review_messages(_FORK_WRITES), [])

    # Migration import drops a seed lesson (migrated=True) into the same corpus.
    seed_ref = store.append(dict(_MIGRATED_SEED))

    # A normal turn's observe-only sync (auto, non-matching vocabulary).
    comp.sync_turn(*_OBSERVE_TURN)

    # Days 3-7 — work turns recall the fork lessons at a real call site (prefetch =
    # recall + receipt + mark_consumed). Each hits exactly one distinct fork lesson.
    fork_hits = 0
    # D4-A: prefetch no longer self-marks consumed — it stashes the receipt and the chassis
    # confirms AFTER injecting the block. Model that here: prefetch (stash) -> confirm
    # (inject), once per "turn", so circulation counts only blocks that reached the prompt.
    for _name, _args, query in _FORK_WRITES:
        ctx = comp.prefetch(query)
        if ctx:
            fork_hits += 1
            comp.confirm_prefetch_consumed()  # block injected into this turn's prompt

    # Negative control: a turn recalls ONLY the migrated seed (consumed, but excluded).
    seed_ctx = comp.prefetch(_SEED_QUERY)
    if seed_ctx:
        comp.confirm_prefetch_consumed()

    # A turn whose query matches nothing — the miss must be recorded, not swallowed.
    # (No confirm: a miss stashes no receipt and injects nothing.)
    miss_ctx = comp.prefetch(_MISS_QUERY)

    report = ExperienceHealth(store).circulation_report()

    # Independent re-derivation of circulation from the raw receipt/lesson rows (R2: this is
    # an INDEPENDENT re-derivation of the SAME definition — it catches a shared-table/JOIN
    # bug or a typo inside circulation()/aggregate(), NOT a wrong consumption *semantic*
    # (that is D4's concern: "consumed" currently means "prefetch returned text", not "the
    # model used it")). R1: the filter MUST match circulation() exactly — `migrated = 0`
    # with NO tombstoned clause (store.py:circulation). circulation() counts a migrated=0
    # ref that appears in a consumed hit receipt even if the lesson is later tombstoned (the
    # receipt is historical); over-filtering with `tombstoned = 0` would diverge.
    conn = store._conn
    consumed_hit_refs: set[str] = set()
    for (refs_json,) in conn.execute(
        "SELECT lesson_refs FROM receipts WHERE consumed = 1 AND kind = 'hit'"
    ).fetchall():
        consumed_hit_refs.update(json.loads(refs_json))
    fork_ids = {
        r for (r,) in conn.execute(
            "SELECT id FROM lessons WHERE migrated = 0"
        ).fetchall()
    }
    oracle_circulation = len(consumed_hit_refs & fork_ids)

    return {
        "store": store,
        "comp": comp,
        "report": report,
        "fork_written": fork_written,
        "fork_hits": fork_hits,
        "seed_ref": seed_ref,
        "seed_consumed": bool(seed_ctx),
        "miss_empty": miss_ctx == "",
        "expected_circulation": len(_FORK_WRITES),
        "oracle_circulation": oracle_circulation,
    }


def check_ac1(result: dict) -> list[str]:
    """Return a list of AC1 violation strings ([] == pass)."""
    r = result["report"]
    failures: list[str] = []

    if result["fork_written"] != len(_FORK_WRITES):
        failures.append(
            f"fork wrote {result['fork_written']} lessons, expected {len(_FORK_WRITES)}"
        )
    if result["fork_hits"] != len(_FORK_WRITES):
        failures.append(
            f"only {result['fork_hits']}/{len(_FORK_WRITES)} fork lessons recalled"
        )
    # The bar: circulation counts fork-authored consumed reads ONLY. The migrated seed
    # was consumed too, so an off-by-one here means migrated reads are leaking in.
    if r["circulation"] != result["expected_circulation"]:
        failures.append(
            f"circulation={r['circulation']}, expected exactly "
            f"{result['expected_circulation']} (migrated seed must not count)"
        )
    # Independent oracle must agree with circulation() — divergence means a bug shared
    # between circulation()/aggregate() and the raw rows (or in the oracle itself).
    if result["oracle_circulation"] != r["circulation"]:
        failures.append(
            f"oracle circulation={result['oracle_circulation']} disagrees with "
            f"health-report circulation={r['circulation']} (shared-path bug?)"
        )
    if not result["seed_consumed"]:
        failures.append("negative control invalid: migrated seed was not consumed")
    if r["migrated_lessons"] < 1:
        failures.append("no migrated lesson present — negative control absent")
    if r["recall_misses"] < 1 or not result["miss_empty"]:
        failures.append("miss was silent: no recall_miss receipt written")

    write_only = next((f for f in r["flags"] if f["name"] == "WRITE_ONLY_MEMORY"), None)
    if write_only is None or write_only["active"]:
        failures.append("WRITE_ONLY_MEMORY flag is active — memory not circulating")

    return failures


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    result = run_synthetic_week()
    r = result["report"]
    health = ExperienceHealth(result["store"])

    print("=== Synthetic-week AC1 replay (dev instance) ===")
    print(health.summary())
    print(
        f"  circulation={r['circulation']}  fork_authored={r['fork_authored']}  "
        f"migrated={r['migrated_lessons']}  total={r['total_lessons']}"
    )
    print(
        f"  recall: {r['recall_hits']} hit / {r['recall_misses']} miss   "
        f"fork_written={result['fork_written']}  fork_hits={result['fork_hits']}  "
        f"seed_consumed={result['seed_consumed']}"
    )
    for f in r["flags"]:
        state = "ON " if f["active"] else "off"
        print(f"  [{state}] {f['name']} ({f['severity']}): {f['message']}")

    failures = check_ac1(result)
    if failures:
        print("\nAC1 FAIL:")
        for msg in failures:
            print(f"  - {msg}")
        return 1
    print(
        "\nAC1 PASS: fork-authored lessons circulated into consumed recalls; "
        "migrated reads excluded; misses recorded."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
