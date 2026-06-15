#!/usr/bin/env python3
"""Real-transcript AC1 replay harness — M1 G4b (dev-instance, no .31).

Closes SPEC Q3 (corpus) and the "synthetic not real transcripts" gap recorded in
``docs/plans/M1-CLOSEOUT-AUDIT.md`` (G4b). The predecessor harness
(``scripts/synthetic_week_ac1.py``) exercises the REAL code paths but feeds them
HAND-AUTHORED placeholder lessons ("zephyr quux lockfile", "frobnicate vorpal
widget"). This harness replaces that synthetic corpus with the GENUINE
fork-authored lessons the live composite-brain-leg already wrote.

WHAT "REAL" MEANS HERE (honest scope) — and what it still does NOT prove:
  REAL: the lesson CONTENT is genuine. We read the ~6 fork-authored lessons the
    live background-review loop actually authored (source='reviewed', migrated=0,
    provenance='fork:background_review:...') out of the LIVE experience.db under
    HERMES_HOME, and replay THAT TEXT — not invented placeholders — through the
    REAL append + recall + circulation code. The recall queries are derived from
    each real lesson's own distinctive vocabulary, so an FTS hit is a real
    content match, not a rigged synthetic token.
  REAL: the code path is the production one. The replay drives
    ``agent.background_review.record_fork_authored_lessons`` -> a real
    ``MemoryManager.on_background_review`` fan-out ->
    ``HermesCompositeProvider.record_fork_lesson`` -> ``ExperienceStore.append``,
    then recalls at a real call site (``comp.prefetch`` -> circulation receipt ->
    ``confirm_prefetch_consumed``), exactly as the synthetic harness does. An
    independent SQL oracle (not ``circulation()``) cross-checks the count.
  NOT PROVED — the SAME residual limits the synthetic harness carries, inherited
    from the AIOS composite, NOT introduced here:
      (1) "consumed" is set when ``prefetch``/``confirm_prefetch_consumed`` runs,
          NOT when the model demonstrably reads the block (handoff Sev-2 #8,
          gameable-count; an AC1-DEFINITION limit).
      (2) END-TO-END INJECTION: this calls ``comp.prefetch`` directly, bypassing
          ``memory_manager.prefetch_all`` + prompt assembly. Proving the recalled
          block actually reaches the dispatched prompt is G4a's job, not this
          harness's.
    What is NEW vs synthetic is ONLY the corpus: real authored content instead of
    seeds. The injection-path gap is unchanged and explicitly still G4a's.

READ-ONLY GUARANTEE: the live experience.db is opened ``mode=ro`` and copied via
the SQLite online-backup API into a private tmp file; the live DB (and its WAL)
is never written, checkpointed, or locked for write. If the live DB is absent or
holds zero fork-authored lessons, the harness SKIPS (exit 2) rather than inventing
a corpus — a real-transcript harness with no real transcripts must not pass.

Run:  python scripts/realtranscript_ac1.py
Exit 0 = AC1 holds on the real corpus; 1 = AC1 violated; 2 = no real corpus (skip).
Pure stdlib + the AIOS packages (sibling repo) + the dev-instance chassis.

Override the source DB with ``REALTRANSCRIPT_AC1_DB`` (absolute path); default is
``$HERMES_HOME/experience.db`` then the canonical ``I:/PROJECTS/AIOS/hermes-home``.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

# --- path bootstrap (mirror synthetic_week_ac1) ---------------------------------------
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_HEALTH_DIR = os.environ.get("AIOS_HEALTH_DIR") or str(
    _REPO_ROOT.parent / "aios" / "packages" / "health"
)
if os.path.isdir(_HEALTH_DIR) and _HEALTH_DIR not in sys.path:
    sys.path.insert(0, _HEALTH_DIR)

from agent.background_review import record_fork_authored_lessons  # noqa: E402
from experience_health import ExperienceHealth  # noqa: E402
from plugins.memory.composite.provider import (  # noqa: E402  (inserts AIOS pkgs)
    ExperienceStore,
    HermesCompositeProvider,
)

# How many real fork lessons to replay at most (keeps the run bounded + deterministic).
_MAX_REAL_LESSONS = 6

# The negative-control migrated seed (identical role to the synthetic harness): recalled
# AND consumed below, but circulation MUST exclude it (migrated reads never count).
_MIGRATED_SEED = {
    "lesson": "Legacy migrated note about the plover subsystem timeout.",
    "task_type": "workflow",
    "tags": ["seed", "legacy"],
    "provenance": "migration:v0",
    "source": "auto",
    "migrated": True,
}
_SEED_QUERY = "plover subsystem timeout"

# A work-turn query that matches NOTHING in the real corpus — must emit a recall_miss
# receipt (never silent). Distinctive nonsense tokens that cannot collide with real text.
_MISS_QUERY = "nonexistent flibbertigibbet contraption zzzqxv"


# --- read the REAL corpus, read-only -------------------------------------------------
def _resolve_live_db() -> Path | None:
    """Locate the live experience.db without mutating anything. Order: explicit override
    env -> $HERMES_HOME/experience.db -> canonical hermes-home path."""
    override = os.environ.get("REALTRANSCRIPT_AC1_DB")
    if override:
        p = Path(override)
        return p if p.is_file() else None
    candidates = []
    hh = os.environ.get("HERMES_HOME")
    if hh:
        candidates.append(Path(hh) / "experience.db")
    candidates.append(Path("I:/PROJECTS/AIOS/hermes-home/experience.db"))
    for c in candidates:
        if c.is_file():
            return c
    return None


def _backup_live_db_readonly(live_db: Path) -> str:
    """Copy the live DB into a private tmp file via the SQLite online-backup API.

    The SOURCE is opened ``mode=ro`` (immutable to us) so we never write, checkpoint,
    or take a write lock on the live file or its WAL. The backup API reads a consistent
    snapshot (WAL included) into the tmp DEST. Returns the tmp dest path; the caller
    deletes it. This is the ONLY way the harness touches the live DB.
    """
    fd, dest = tempfile.mkstemp(prefix="realtranscript_ac1_", suffix=".db")
    os.close(fd)
    # mode=ro: read-only handle on the live DB. The backup reads the live WAL-merged view.
    src_uri = f"file:{live_db.as_posix()}?mode=ro"
    src = sqlite3.connect(src_uri, uri=True)
    try:
        out = sqlite3.connect(dest)
        try:
            src.backup(out)  # read-only snapshot copy; live file untouched
        finally:
            out.close()
    finally:
        src.close()
    return dest


def _read_real_fork_lessons(live_db: Path) -> list[dict]:
    """Return the genuine fork-authored lessons (migrated=0, source='reviewed') from a
    READ-ONLY backup copy of the live DB. Each dict: {lesson, task_type, tags, id}.
    """
    dest = _backup_live_db_readonly(live_db)
    try:
        conn = sqlite3.connect(dest)
        try:
            rows = conn.execute(
                """
                SELECT id, lesson, task_type, tags
                FROM lessons
                WHERE migrated = 0 AND source = 'reviewed' AND tombstoned = 0
                ORDER BY ts
                LIMIT ?
                """,
                (_MAX_REAL_LESSONS,),
            ).fetchall()
        finally:
            conn.close()
    finally:
        try:
            os.unlink(dest)
        except OSError:
            pass
    out: list[dict] = []
    for ref, lesson, task_type, tags_json in rows:
        try:
            tags = json.loads(tags_json) if tags_json else []
        except (ValueError, TypeError):
            tags = []
        out.append(
            {"id": ref, "lesson": lesson, "task_type": task_type, "tags": tags}
        )
    return out


# --- derive a real, distinctive recall query from each lesson's own text -------------
# Generic stopwords + domain-boilerplate that appear in EVERY neurolinked lesson (so a
# query built from them would cross-match many lessons and inflate the count). We strip
# these and keep each lesson's RARE tokens, making the recall hit its own lesson.
_STOP = {
    "the", "and", "for", "with", "that", "this", "from", "are", "but", "not",
    "you", "your", "via", "use", "uses", "used", "see", "one", "two", "all",
    "skill", "brain", "composite", "neurolinked", "provider", "memory", "config",
    "leg", "legs", "live", "tool", "tools", "when", "before", "each", "into",
    "they", "their", "have", "has", "was", "its", "any", "can", "may", "per",
}


def _distinctive_query(lesson_text: str, others: list[str]) -> str:
    """Pick tokens that occur in THIS lesson but are rare across the OTHER real lessons,
    so the FTS recall lands on this lesson specifically (deterministic, content-derived).
    Falls back to the longest tokens if differencing yields too few.
    """
    import re

    def toks(s: str) -> list[str]:
        return [
            t for t in re.findall(r"[a-z0-9_]+", s.lower())
            if len(t) >= 5 and t not in _STOP and not t.isdigit()
        ]

    mine = toks(lesson_text)
    other_set: set[str] = set()
    for o in others:
        other_set.update(toks(o))
    # tokens unique-ish to this lesson, preserving order, deduped
    seen: set[str] = set()
    unique = []
    for t in mine:
        if t in seen:
            continue
        seen.add(t)
        if t not in other_set:
            unique.append(t)
    pool = unique if len(unique) >= 2 else sorted(set(mine), key=len, reverse=True)
    return " ".join(pool[:4])


def _review_messages(lessons: list[dict]):
    """Build a simulated background-review message log from REAL lesson content, so the
    replay drives the REAL extraction/append path (assistant skill_manage tool_calls +
    successful tool results) — the same shape the live fork produces. Each real lesson is
    framed as the skill_manage write that authored it (its text begins '[skill:NAME] ...').
    """
    import re

    msgs = []
    for i, les in enumerate(lessons):
        cid = f"call-real-{i}"
        text = les["lesson"]
        m = re.match(r"^\[skill:([^\]]+)\]\s*(.*)$", text, re.DOTALL)
        if m:
            name, content = m.group(1).strip(), m.group(2)
            args = {"action": "patch", "name": name, "new_string": content}
        else:
            # Memory-style real lesson: route as a memory add of the real content.
            args = {"action": "add", "target": "user", "content": text}
        tool_name = "skill_manage" if m else "memory"
        msgs.append(
            {
                "role": "assistant",
                "tool_calls": [
                    {"id": cid, "function": {"name": tool_name, "arguments": json.dumps(args)}}
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
    """Minimal parent-agent surface the fork-append path reaches into (mirror synthetic)."""

    def __init__(self, manager, session_id="realtranscript-replay"):
        self._memory_manager = manager
        self.session_id = session_id


def run_real_transcript(db_path: str = ":memory:") -> dict | None:
    """Replay the REAL fork-authored corpus through the full append+recall+circulation
    path and return a result dict. Returns ``None`` when there is no real corpus to replay
    (caller treats that as SKIP, exit 2) — a real-transcript harness must not pass on a
    synthetic fallback.
    """
    from agent.memory_manager import MemoryManager

    live_db = _resolve_live_db()
    if live_db is None:
        return None
    real_lessons = _read_real_fork_lessons(live_db)
    if not real_lessons:
        return None

    # Build a distinctive recall query per lesson from its OWN vocabulary.
    all_texts = [l["lesson"] for l in real_lessons]
    for i, les in enumerate(real_lessons):
        others = [t for j, t in enumerate(all_texts) if j != i]
        les["query"] = _distinctive_query(les["lesson"], others)

    store = ExperienceStore(db_path=db_path)
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize("realtranscript-replay")
    manager = MemoryManager()
    manager.add_provider(comp)
    agent = _ForkAgent(manager)

    # The fork re-authors the REAL lessons through the production append leg.
    fork_written = record_fork_authored_lessons(agent, _review_messages(real_lessons), [])

    # Migration import drops a seed lesson (migrated=True) into the same corpus.
    seed_ref = store.append(dict(_MIGRATED_SEED))

    # Work turns recall the real lessons at a real call site (prefetch -> receipt ->
    # confirm). Each query is content-derived; count distinct lessons that actually hit.
    fork_hits = 0
    queries_that_hit: list[str] = []
    for les in real_lessons:
        if not les["query"]:
            continue
        ctx = comp.prefetch(les["query"])
        if ctx:
            fork_hits += 1
            queries_that_hit.append(les["query"])
            comp.confirm_prefetch_consumed()  # block injected into this turn's prompt

    # Negative control: a turn recalls ONLY the migrated seed (consumed, but excluded).
    seed_ctx = comp.prefetch(_SEED_QUERY)
    if seed_ctx:
        comp.confirm_prefetch_consumed()

    # A turn whose query matches NOTHING — the miss must be recorded, not swallowed.
    miss_ctx = comp.prefetch(_MISS_QUERY)

    report = ExperienceHealth(store).circulation_report()

    # Independent re-derivation of circulation from raw rows (mirror synthetic oracle):
    # MUST match circulation() exactly — migrated = 0 with NO tombstoned clause.
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
        "live_db": str(live_db),
        "real_count": len(real_lessons),
        "fork_written": fork_written,
        "fork_hits": fork_hits,
        "queries_that_hit": queries_that_hit,
        "seed_ref": seed_ref,
        "seed_consumed": bool(seed_ctx),
        "miss_empty": miss_ctx == "",
        "oracle_circulation": oracle_circulation,
    }


def check_ac1(result: dict) -> list[str]:
    """Return a list of AC1 violation strings ([] == pass). The bar for the REAL corpus:
    circulation > 0 from distinct fork-authored (migrated=0) consumed reads, migrated
    excluded, misses recorded, WRITE_ONLY off, oracle agrees with the health report.
    """
    r = result["report"]
    failures: list[str] = []

    # The fork must have re-authored every real lesson it was handed.
    if result["fork_written"] != result["real_count"]:
        failures.append(
            f"fork wrote {result['fork_written']} lessons, expected "
            f"{result['real_count']} (every real lesson must append)"
        )
    # At least one real lesson must recall (content-derived queries on real text).
    if result["fork_hits"] < 1:
        failures.append(
            "no real fork lesson recalled — content-derived queries hit nothing "
            "(FTS recall against the real corpus produced zero hits)"
        )
    # Circulation must be > 0 and equal to the number of distinct real lessons that hit.
    if r["circulation"] < 1:
        failures.append(
            f"circulation={r['circulation']} — real fork-authored lessons did not "
            "circulate into consumed recalls (AC1 numerator stuck at 0)"
        )
    if r["circulation"] != result["fork_hits"]:
        failures.append(
            f"circulation={r['circulation']} != distinct real hits "
            f"{result['fork_hits']} (migrated seed leaked in, or a hit was lost)"
        )
    # Independent oracle must agree with circulation() (shared-path bug guard).
    if result["oracle_circulation"] != r["circulation"]:
        failures.append(
            f"oracle circulation={result['oracle_circulation']} disagrees with "
            f"health-report circulation={r['circulation']} (shared-path bug?)"
        )
    # Negative controls.
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

    result = run_real_transcript()
    if result is None:
        print("=== Real-transcript AC1 replay (dev instance) ===")
        print(
            "SKIP: no real fork-authored corpus found (live experience.db absent or holds "
            "0 lessons with migrated=0 source='reviewed'). A real-transcript harness will "
            "not pass on a synthetic fallback. Set REALTRANSCRIPT_AC1_DB or HERMES_HOME."
        )
        return 2

    r = result["report"]
    health = ExperienceHealth(result["store"])

    print("=== Real-transcript AC1 replay (dev instance) ===")
    print(f"  source live DB (read-only copy): {result['live_db']}")
    print(f"  real fork-authored lessons replayed: {result['real_count']}")
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
    print(f"  content-derived queries that hit: {result['queries_that_hit']}")
    for f in r["flags"]:
        state = "ON " if f["active"] else "off"
        print(f"  [{state}] {f['name']} ({f['severity']}): {f['message']}")

    failures = check_ac1(result)
    if failures:
        print("\nAC1 FAIL (real corpus):")
        for msg in failures:
            print(f"  - {msg}")
        return 1
    print(
        "\nAC1 PASS: REAL fork-authored lessons (genuine composite-brain-leg content) "
        "circulated into consumed recalls; migrated reads excluded; misses recorded."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
