"""Experience-circulation health — the AC1 measurement + anti-invisibility flags.

This is the EXPERIENCE-CIRCULATION SLICE of the health-view primitive
(PRIMITIVES section 9, `docs/primitives/09-health-view.md`) — the "anti-invisibility
organ". It reads the experience-store's read-only aggregates and turns them into
pathology FLAGS: the surfaces where a human would trip over an anomaly that was
historically INVISIBLE (write-only memory, vacuous/constant rewards, high-miss recall).

The numbers are necessary but NOT the point; the FLAGS are the point (§9 WHY). A
report of "circulation: 0" is ignorable; a `WRITE_ONLY_MEMORY` flag with a message
naming the predecessor death is not.

Other health-view slices (outbox, retrieval freshness, privacy audit, constraint
events, journal write-rate) depend on other primitives and are DEFERRED — this module
is the experience slice only, the data layer (no desktop panel).

Pure stdlib. Takes an `ExperienceStore` instance OR a db path; never mutates the store.

Vendored/Ported from AIOS packages/health/experience_health.py — zero AIOS dependency.
"""

from __future__ import annotations

import argparse
import json
import os

# Repo root and the default constraint-events journal the runtime auto-writes to
# (packages/constraints/auto-journal.cjs -> data/telemetry/journal.jsonl, PRIMITIVES §8b).
_HEALTH_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.normpath(
    os.path.join(_HEALTH_PKG_DIR, "..", "..", "..", "..")
)
DEFAULT_JOURNAL_PATH = os.path.join(_REPO_ROOT, "data", "telemetry", "journal.jsonl")

# ----- flag thresholds (named, so the report is auditable, not magic numbers) -----

# HIGH_RECALL_MISS only fires with a meaningful sample — a single miss on a cold store
# is not a pathology. Below this many total recalls we suppress the flag.
MIN_RECALL_SAMPLE = 4
# Above this miss fraction (with sample) recall is firing but finding nothing.
RECALL_MISS_THRESHOLD = 0.5
# NEVER_RECALLED_MAJORITY when more than this fraction of live lessons have uses==0.
NEVER_RECALLED_MAJORITY_THRESHOLD = 0.5

# ----- outbox (G2/SPEC-m1-outbox §2.5) thresholds -----
# OUTBOX_STUCK fires when the oldest pending op has waited longer than this (the drain
# is not advancing — the brain is unreachable or the worker is dead). TUNABLE.
OUTBOX_STUCK_AGE_S = 1800  # 30 minutes
# ...or when dead(rejected) (substantive-failure deaths, not overflow evictions) climbs
# past this count — ops the brain keeps refusing. TUNABLE.
OUTBOX_DEAD_REJECTED_THRESHOLD = 5

# ----- constraint-events (journal) bound -----
# How many recent constraint events to surface in the report (most-recent first).
CONSTRAINT_RECENT_LIMIT = 10
# How many of those recent events the human render prints (<= CONSTRAINT_RECENT_LIMIT).
CONSTRAINT_HUMAN_LIMIT = 5


class Flag:
    """One anti-invisibility flag: a severity + a human-readable pathology message."""

    __slots__ = ("name", "active", "severity", "message")

    def __init__(self, name: str, active: bool, severity: str, message: str):
        self.name = name
        self.active = active
        self.severity = severity  # 'info' | 'warn' | 'critical'
        self.message = message

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "active": self.active,
            "severity": self.severity,
            "message": self.message,
        }

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        state = "ON" if self.active else "off"
        return f"<Flag {self.name} {state} ({self.severity})>"


class ExperienceHealth:
    """Experience-circulation health view over a single ExperienceStore."""

    def __init__(self, store=None, *, db_path: str | None = None):
        if store is None:
            if db_path is None:
                raise ValueError("ExperienceHealth requires a store instance or a db_path")
            from .store import ExperienceStore

            store = ExperienceStore(db_path)
        self._store = store

    # ----- core report -----

    def circulation_report(self, window: int | None = None) -> dict:
        """The experience-circulation health report: AC1 circulation + derived rates +
        anti-invisibility flags. Read-only.
        """
        agg = self._store.aggregate(window)

        total = agg["total_lessons"]
        recall_hits = agg["recall_hits"]
        recall_misses = agg["recall_misses"]
        recall_total = recall_hits + recall_misses
        recall_miss_rate = (recall_misses / recall_total) if recall_total else 0.0
        never_recalled = agg["never_recalled"]
        never_recalled_rate = (never_recalled / total) if total else 0.0

        report = {
            "circulation": agg["circulation"],
            "total_lessons": total,
            "fork_authored": agg["fork_authored"],
            "migrated_lessons": agg["migrated_lessons"],
            "tombstoned": agg["tombstoned"],
            "recall_hits": recall_hits,
            "recall_misses": recall_misses,
            "recall_miss_rate": recall_miss_rate,
            "never_recalled": never_recalled,
            "never_recalled_rate": never_recalled_rate,
            "valence_count": agg["valence_count"],
            "valence_variance": agg["valence_variance"],
            "signalled_lessons": agg["signalled_lessons"],
            "unsignalled_lessons": agg["unsignalled_lessons"],
        }
        report["flags"] = [f.to_dict() for f in self._compute_flags(report)]
        return report

    # ----- outbox health (G2 counter 2; SPEC-m1-outbox §2.4/§2.5) -----

    def outbox_report(self) -> dict:
        """The durable-outbox health counter: per-status counts, dead-by-reason split,
        and the stuck-queue signal — plus an OUTBOX_STUCK pathology flag. Read-only.

        Sources `store.outbox_counts()` (the store owns the SQL; we never reach into the
        connection). Mirrors the §9 flag style: the numbers are necessary, the flag is the
        point — a stuck queue means observe ops are piling up and the loop is silently
        losing signal.
        """
        c = self._store.outbox_counts()
        oldest_age = c.get("oldest_pending_age_s")
        dead_by_reason = c.get("dead_by_reason") or {}
        dead_rejected = dead_by_reason.get("rejected", 0)

        report = {
            "pending": c.get("pending", 0),
            "in_flight": c.get("in_flight", 0),
            "confirmed": c.get("confirmed", 0),
            "dead": c.get("dead", 0),
            "dead_by_reason": dead_by_reason,
            "oldest_pending_age_s": oldest_age,
            "max_attempts": c.get("max_attempts", 0),
        }
        report["flags"] = [f.to_dict() for f in self._compute_outbox_flags(report, dead_rejected)]
        return report

    def _compute_outbox_flags(self, r: dict, dead_rejected: int) -> list[Flag]:
        # OUTBOX_STUCK — pending op aged past the stuck threshold (drain not advancing),
        # OR dead(rejected) climbing past the threshold (brain keeps refusing ops). Either
        # way the durable queue is silently shedding/holding signal — the §2.5 alarm.
        age = r["oldest_pending_age_s"]
        aged = age is not None and age > OUTBOX_STUCK_AGE_S
        rejecting = dead_rejected > OUTBOX_DEAD_REJECTED_THRESHOLD
        stuck = aged or rejecting
        if aged and rejecting:
            why = (
                f"oldest pending op has waited {age:.0f}s (> {OUTBOX_STUCK_AGE_S}s) AND "
                f"{dead_rejected} op(s) dead(rejected)"
            )
        elif aged:
            why = f"oldest pending op has waited {age:.0f}s (> {OUTBOX_STUCK_AGE_S}s)"
        elif rejecting:
            why = f"{dead_rejected} op(s) dead(rejected) (> {OUTBOX_DEAD_REJECTED_THRESHOLD})"
        else:
            why = ""
        return [
            Flag(
                "OUTBOX_STUCK",
                stuck,
                "warn",
                (
                    f"outbox stuck: {why} - the brain-bound drain is not advancing; "
                    f"observe ops are piling up (the loop is silently losing signal)"
                )
                if stuck
                else "outbox draining (no aged pending ops, dead-rejected within bounds)",
            )
        ]

    # ----- flags (the point — §9 anti-invisibility) -----

    def _compute_flags(self, r: dict) -> list[Flag]:
        flags: list[Flag] = []

        # WRITE_ONLY_MEMORY — lessons exist but nothing has circulated. The literal
        # "15 lessons, zero reads" predecessor death (SPEC §0/C4, §1 AC1).
        write_only = r["circulation"] == 0 and r["total_lessons"] > 0
        flags.append(
            Flag(
                "WRITE_ONLY_MEMORY",
                write_only,
                "critical",
                (
                    f"write-only memory: {r['total_lessons']} lesson(s) stored, "
                    f"0 fork-authored lessons in a consumed recall (the predecessor "
                    f"death — memory written, never read)"
                )
                if write_only
                else "memory is circulating (fork-authored lessons reach consumed recalls)",
            )
        )

        # VACUOUS_VALENCE — signals exist but every valence is the same (variance==0).
        # The store rejects literal constants by construction, but a caller can still
        # send the SAME derived value every time; that is the H7 vacuous-reward disease
        # surviving the construction-time guard, so flag it here.
        vacuous = r["valence_count"] > 0 and r["valence_variance"] == 0
        flags.append(
            Flag(
                "VACUOUS_VALENCE",
                vacuous,
                "warn",
                (
                    f"vacuous valence: {r['valence_count']} signal(s) with zero variance "
                    f"(constant reward — the H7 vacuous-reward disease; signals carry no "
                    f"information)"
                )
                if vacuous
                else "valence varies across signals",
            )
        )

        # HIGH_RECALL_MISS — recall is firing but finding nothing, with a meaningful
        # sample. Recall machinery alive, corpus not answering.
        recall_total = r["recall_hits"] + r["recall_misses"]
        high_miss = (
            recall_total >= MIN_RECALL_SAMPLE
            and r["recall_miss_rate"] > RECALL_MISS_THRESHOLD
        )
        flags.append(
            Flag(
                "HIGH_RECALL_MISS",
                high_miss,
                "warn",
                (
                    f"high recall-miss rate: {r['recall_miss_rate']:.0%} of "
                    f"{recall_total} recalls returned nothing (recall fires, corpus does "
                    f"not answer)"
                )
                if high_miss
                else "recall-miss rate within bounds",
            )
        )

        # NEVER_RECALLED_MAJORITY — most live lessons have never been recalled (uses==0).
        # A staleness/write-only smell weaker than WRITE_ONLY_MEMORY (some circulation may
        # exist, but the bulk is dead weight).
        majority_stale = (
            r["total_lessons"] > 0
            and r["never_recalled_rate"] > NEVER_RECALLED_MAJORITY_THRESHOLD
        )
        flags.append(
            Flag(
                "NEVER_RECALLED_MAJORITY",
                majority_stale,
                "warn",
                (
                    f"stale majority: {r['never_recalled']}/{r['total_lessons']} lesson(s) "
                    f"({r['never_recalled_rate']:.0%}) have never been recalled (uses==0)"
                )
                if majority_stale
                else "most lessons have been recalled at least once",
            )
        )

        return flags

    def flags(self, window: int | None = None) -> list[dict]:
        """Just the flags (active and inactive), for callers that don't need the numbers."""
        return self.circulation_report(window)["flags"]

    def active_flags(self, window: int | None = None) -> list[dict]:
        """Only the flags that are currently firing."""
        return [f for f in self.flags(window) if f["active"]]

    def summary(self, window: int | None = None) -> str:
        """One-line human summary: circulation headline + any firing pathology names."""
        r = self.circulation_report(window)
        firing = [f["name"] for f in r["flags"] if f["active"]]
        head = (
            f"circulation={r['circulation']} "
            f"lessons={r['total_lessons']} (fork={r['fork_authored']}) "
            f"recall={r['recall_hits']}h/{r['recall_misses']}m"
        )
        if firing:
            return f"DEGRADED: {head} | flags: {', '.join(firing)}"
        return f"HEALTHY: {head} | no pathologies"


# ----- constraint-events counter (G2 counter 3; LIVE — sourced from the journal) -----

def constraint_events_report(journal_path: str | None = None) -> dict:
    """The constraint-events counter, sourced from the runtime journal that the
    constraints primitive auto-writes (packages/constraints/auto-journal.cjs +
    session-end.cjs -> data/telemetry/journal.jsonl; PRIMITIVES §8b/§10). Each journal
    entry carries a `constraint_events[]` array of {constraint, status, detail}; we count
    them, split by status, surface the most-recent few, and call out fail-closed `block`
    events (the one M0 constraint that actually denies — its firing is a real pathology).

    LIVE when the journal exists; if it is absent we return an HONEST `wired: False`
    marker with a zero count and a note — never a fabricated number.
    """
    path = journal_path or DEFAULT_JOURNAL_PATH
    if not os.path.exists(path):
        return {
            "wired": False,
            "total": 0,
            "by_status": {},
            "blocks": 0,
            "recent": [],
            "journal_path": path,
            "note": (
                "constraint-events source not present (no journal at this path); "
                "counter wired to data/telemetry/journal.jsonl but the file is absent"
            ),
        }

    total = 0
    by_status: dict[str, int] = {}
    recent: list[dict] = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except (ValueError, TypeError):
                    continue  # skip a malformed line, never crash the health view
                events = entry.get("constraint_events") or []
                ts = entry.get("ts")
                for ev in events:
                    total += 1
                    status = ev.get("status", "unknown")
                    by_status[status] = by_status.get(status, 0) + 1
                    recent.append(
                        {
                            "ts": ts,
                            "constraint": ev.get("constraint", "?"),
                            "status": status,
                            "detail": ev.get("detail", ""),
                        }
                    )
    except OSError as e:  # pragma: no cover - unreadable file is rare
        return {
            "wired": False,
            "total": 0,
            "by_status": {},
            "blocks": 0,
            "recent": [],
            "journal_path": path,
            "note": f"constraint-events journal present but unreadable: {e}",
        }

    return {
        "wired": True,
        "total": total,
        "by_status": by_status,
        "blocks": by_status.get("block", 0),
        "recent": list(reversed(recent))[:CONSTRAINT_RECENT_LIMIT],
        "journal_path": path,
        "note": "constraint-events live from the runtime journal",
    }


# ----- full report assembly + human render + CLI -----

def build_full_report(store=None, *, db_path: str | None = None,
                      journal_path: str | None = None, window: int | None = None) -> dict:
    """Assemble all three ROADMAP-required counters into one report dict:
    circulation (experience-store), outbox (durable observe queue), constraint_events
    (runtime journal). Read-only; never mutates the store.
    """
    h = ExperienceHealth(store, db_path=db_path)
    return {
        "circulation": h.circulation_report(window),
        "outbox": h.outbox_report(),
        "constraint_events": constraint_events_report(journal_path),
    }


def _active(flags: list[dict]) -> list[str]:
    return [f["name"] for f in flags if f["active"]]


def render_human(report: dict) -> str:
    """Human-readable rendering of the full three-counter report (no emoji/non-ASCII)."""
    circ = report["circulation"]
    ob = report["outbox"]
    ce = report["constraint_events"]
    lines: list[str] = []

    firing = _active(circ["flags"]) + _active(ob["flags"])
    status = "DEGRADED" if firing else "HEALTHY"
    lines.append(f"experience-health: {status}")
    lines.append("")

    # 1. circulation
    lines.append("[circulation]")
    lines.append(
        f"  circulation={circ['circulation']}  lessons={circ['total_lessons']} "
        f"(fork={circ['fork_authored']} migrated={circ['migrated_lessons']} "
        f"tombstoned={circ['tombstoned']})"
    )
    lines.append(
        f"  recall={circ['recall_hits']}h/{circ['recall_misses']}m "
        f"(miss_rate={circ['recall_miss_rate']:.0%})  "
        f"never_recalled={circ['never_recalled']} ({circ['never_recalled_rate']:.0%})"
    )
    lines.append(
        f"  valence: count={circ['valence_count']} variance={circ['valence_variance']:.4f}"
    )
    for f in circ["flags"]:
        if f["active"]:
            lines.append(f"  ! {f['name']} ({f['severity']}): {f['message']}")

    # 2. outbox
    lines.append("")
    lines.append("[outbox]")
    lines.append(
        f"  pending={ob['pending']}  in_flight={ob['in_flight']}  "
        f"confirmed={ob['confirmed']}  dead={ob['dead']}"
    )
    if ob["dead_by_reason"]:
        reasons = " ".join(f"{k}={v}" for k, v in sorted(ob["dead_by_reason"].items()))
        lines.append(f"  dead_by_reason: {reasons}")
    age = ob["oldest_pending_age_s"]
    age_s = f"{age:.0f}s" if age is not None else "n/a"
    lines.append(f"  oldest_pending_age={age_s}  max_attempts={ob['max_attempts']}")
    for f in ob["flags"]:
        if f["active"]:
            lines.append(f"  ! {f['name']} ({f['severity']}): {f['message']}")

    # 3. constraint-events
    lines.append("")
    lines.append("[constraint-events]")
    if ce["wired"]:
        by = " ".join(f"{k}={v}" for k, v in sorted(ce["by_status"].items())) or "(none)"
        lines.append(f"  total={ce['total']}  blocks={ce['blocks']}  by_status: {by}")
        shown = ce["recent"][:CONSTRAINT_HUMAN_LIMIT]
        for ev in shown:
            lines.append(
                f"    - {ev['constraint']} [{ev['status']}] {ev.get('ts') or ''}"
            )
        hidden = len(ce["recent"]) - len(shown)
        if hidden > 0:
            lines.append(f"    ... (+{hidden} more recent; showing {CONSTRAINT_HUMAN_LIMIT})")
    else:
        lines.append(f"  (source not wired) {ce['note']}")
        lines.append(f"  journal_path={ce['journal_path']}")

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint: print the health view (circulation + outbox + constraint-events).

    Returns a process exit code (0 = report printed). Importable functions are unaffected.
    """
    parser = argparse.ArgumentParser(
        prog="experience-health",
        description=(
            "Health view v0 (M1 ROADMAP): circulation, outbox, and constraint-events "
            "counters over the experience store."
        ),
    )
    parser.add_argument(
        "--db", default=None,
        help="path to the experience-store sqlite db (default: in-memory empty store)",
    )
    parser.add_argument(
        "--journal", default=None,
        help=f"path to the constraint-events journal (default: {DEFAULT_JOURNAL_PATH})",
    )
    parser.add_argument(
        "--window", type=int, default=None,
        help="circulation receipt window (optional; forwarded to circulation())",
    )
    parser.add_argument(
        "--json", action="store_true", dest="as_json",
        help="emit machine-readable JSON instead of the human report",
    )
    args = parser.parse_args(argv)

    db_path = args.db or ":memory:"
    report = build_full_report(
        db_path=db_path, journal_path=args.journal, window=args.window
    )

    if args.as_json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_human(report))
    return 0


__all__ = [
    "ExperienceHealth",
    "Flag",
    "constraint_events_report",
    "build_full_report",
    "render_human",
    "main",
]


if __name__ == "__main__":  # pragma: no cover - exercised via main(argv) in tests
    raise SystemExit(main())
