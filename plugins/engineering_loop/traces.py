"""Self-evolution trace export.

Exports engineering run data in a format consumable by Hermes' existing
self-evolution and learning tooling. Does NOT duplicate existing GEPA or
background-review pipelines — feeds them structured evidence.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .schemas import EngineeringRunState, FailureClass

logger = logging.getLogger(__name__)

# Trace schema version
TRACE_VERSION = "1.0"


def export_trace(
    state: EngineeringRunState,
    events: List[Dict[str, Any]],
    artifacts_dir: Path,
) -> Dict[str, Any]:
    """Export a complete engineering run trace.

    Returns a structured trace dict ready for JSON serialization.
    The trace includes:
    - Run metadata (goal, criteria, loop type, timestamps)
    - Gate results with pass/fail status
    - Failure summary with classification counts
    - Stuck signals and resolution
    - Reviewer verdict
    - Commit info
    - Skill improvement candidates
    """
    # Summarize failures
    failure_counts: Dict[str, int] = {}
    failure_samples: List[Dict[str, Any]] = []
    for f in state.failures:
        fc = f.failure_class
        failure_counts[fc] = failure_counts.get(fc, 0) + 1
        if len(failure_samples) < 5:
            failure_samples.append({
                "class": fc,
                "fingerprint": f.fingerprint,
                "message": f.message[:200],
                "count": f.count,
            })

    # Summarize gates
    gate_summary = {
        "total": len(state.verification_gates),
        "passed": sum(1 for g in state.verification_gates if g.passed),
        "failed": sum(1 for g in state.verification_gates if not g.passed),
        "results": [
            {
                "name": g.gate_name,
                "passed": g.passed,
                "duration_s": round(g.duration_seconds, 1),
                "attempts": g.attempts,
            }
            for g in state.verification_gates
        ],
    }

    # Skill improvement candidates
    skill_candidates = _derive_skill_candidates(state)

    trace = {
        "schema_version": TRACE_VERSION,
        "exported_at": time.time(),
        "run": {
            "run_id": state.run_id,
            "session_id": state.session_id,
            "goal": state.goal,
            "acceptance_criteria": state.acceptance_criteria,
            "loop_type": state.loop_type,
            "outcome": state.outcome,
            "phase": state.phase,
            "created_at": state.created_at,
            "completed_at": state.completed_at,
        },
        "metrics": {
            "iteration_count": state.iteration_count,
            "tool_calls": state.tool_calls_observed,
            "changed_files": len(state.changed_files),
            "commands_run": len(state.commands_run),
        },
        "verification": gate_summary,
        "failures": {
            "total": len(state.failures),
            "by_class": failure_counts,
            "samples": failure_samples,
            "stuck_signals": state.stuck_signals,
        },
        "review": {
            "status": (
                state.reviewer.status.value
                if hasattr(state.reviewer.status, "value")
                else str(state.reviewer.status)
            ),
            "reviewer_model": state.reviewer.reviewer_model,
            "same_model_warning": state.reviewer.same_model_warning,
            "action_items": state.reviewer.action_items,
        },
        "commit": {
            "status": state.commit_status,
            "hash": state.commit_hash,
        },
        "skill_candidates": skill_candidates,
        "files": {
            "changed": state.changed_files[:50],
            "commands": state.commands_run[-20:],
        },
    }
    return trace


def export_trace_to_file(
    state: EngineeringRunState,
    events: List[Dict[str, Any]],
    artifacts_dir: Path,
) -> Path:
    """Export trace to a JSON file. Returns the file path."""
    trace = export_trace(state, events, artifacts_dir)
    ts = time.strftime("%Y%m%d-%H%M%S")
    path = artifacts_dir / f"trace-{state.run_id}-{ts}.json"
    path.write_text(json.dumps(trace, indent=2, default=str), "utf-8")
    logger.info("Exported trace to %s", path)
    return path


def _derive_skill_candidates(
    state: EngineeringRunState,
) -> List[Dict[str, Any]]:
    """Derive skill improvement candidates from the run.

    These are structured suggestions, NOT auto-applied changes.
    The existing background-review and curator pipelines decide what to do.
    """
    candidates: List[Dict[str, Any]] = []

    # If a specific failure class dominated, suggest a skill improvement
    if len(state.failures) >= 3:
        from collections import Counter
        counts = Counter(f.failure_class for f in state.failures)
        most_common = counts.most_common(1)
        if most_common and most_common[0][1] >= 3:
            fc = most_common[0][0]
            candidates.append({
                "type": "skill_patch",
                "reason": f"Run had {most_common[0][1]} failures of class '{fc}'",
                "suggestion": f"Consider adding a pitfall for '{fc}' failures to the relevant skill",
                "failure_class": fc,
            })

    # If stuck signals were detected, suggest a stuck-recovery workflow
    if state.stuck_signals:
        candidates.append({
            "type": "workflow",
            "reason": "Stuck detection fired during this run",
            "suggestion": "Consider adding a stuck-recovery checklist to the engineering-loop skill",
            "stuck_signals": state.stuck_signals,
        })

    # If gate discovery found no gates, suggest project setup
    if not state.verification_gates:
        candidates.append({
            "type": "project_setup",
            "reason": "No verification gates were discovered",
            "suggestion": "Add test/lint/format scripts to the project for better harness support",
        })

    return candidates
