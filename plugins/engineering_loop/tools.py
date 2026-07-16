"""Engineering Loop Harness tool handlers.

Registers 10 tools that provide explicit harness lifecycle control:
start, status, update, record_feedback, run_gate, monitor_app,
request_review, check_termination, commit, export_trace.

All tools are gated: they only appear in the agent schema when the
engineering_loop plugin is loaded and active.
"""

from __future__ import annotations

import importlib
import inspect
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from tools.registry import registry

from .state import StateManager
from .schemas import (
    EngineeringRunState,
    EngineeringRunHeader,
    FeedbackRecord,
    FailureRecord,
    GateDefinition,
    GateResult,
    AppMonitorResult,
    ReviewerResult,
    ReviewerStatus,
    CommitStatus,
    LoopType,
    RunPhase,
    FailureClass,
)
from .gates import discover_gates, execute_gate, execute_gates
from .feedback import (
    classify_failure,
    fingerprint_failure,
    parse_command_feedback,
    detect_stuck_signal,
)
from .loop_classifier import classify_loop
from .app_monitor import AppMonitor
from .reviewer import build_review_context, parse_review_response, check_same_model
from .git_commit import (
    commit,
    get_diff,
    get_changed_files,
    get_commit_hash,
    stage_files_safely,
)
from .traces import export_trace_to_file

logger = logging.getLogger(__name__)

# App monitor is tool-local; run state and manager are owned by plugin hooks.
_app_monitor: Optional[AppMonitor] = None


def _outcome_signal_enabled() -> bool:
    """Kill switch: HERMES_OUTCOME_SIGNAL=0 disables auto experience signaling."""
    return os.environ.get("HERMES_OUTCOME_SIGNAL", "1").strip() not in (
        "0", "false", "False", "no", "NO",
    )


def _derivation_for_command(command: str) -> str:
    c = (command or "").lower()
    if any(k in c for k in ("pytest", "npm test", "jest", "vitest", "go test", "cargo test", "gate")):
        return "test_result"
    return "task_completed"


def _emit_outcome_signal(
    *,
    valence: float,
    derivation: str,
    note: str = "",
) -> Optional[Dict[str, Any]]:
    """Best-effort bridge to composite experience_signal via active agent.

    Never raises; never blocks engineering_loop correctness.
    """
    if not _outcome_signal_enabled():
        return {"ok": True, "skipped": "disabled"}
    if float(valence) == 0.0:
        return {"ok": True, "skipped": "neutral"}
    try:
        agent = None
        try:
            import cli as _cli  # type: ignore

            agent = getattr(_cli, "_active_agent_ref", None)
        except Exception:
            agent = None
        mm = getattr(agent, "_memory_manager", None) if agent is not None else None
        if mm is None or not hasattr(mm, "signal_outcome"):
            return {"ok": True, "skipped": "no_memory_manager"}
        sid = getattr(agent, "session_id", "") or ""
        return mm.signal_outcome(
            valence=float(valence),
            derivation=derivation,
            session_id=str(sid),
            note=note[:500],
        )
    except Exception as exc:
        logger.debug("engineering_loop outcome signal failed: %s", exc)
        return {"ok": False, "error": str(exc)}


def _plugin_module() -> Any:
    """Return the plugin package module that owns session state.

    Resolve lazily to avoid a circular import while the package imports this
    tools module during initialization.
    """
    return importlib.import_module(__package__ or "plugins.engineering_loop")


def reset_session_state() -> None:
    """Clear cached tool state for a new session or isolated test.

    Tool handlers cache their ``StateManager`` to avoid rebuilding it on every
    call.  That cache is session-scoped, not process-scoped: a new Hermes
    session or a test that changes cwd/HERMES_HOME must not inherit the prior
    workspace's active run.
    """
    global _app_monitor
    _app_monitor = None
    try:
        plugin = _plugin_module()
        plugin._session_state = None
        plugin._session_manager = None
    except Exception:
        logger.debug("engineering_loop: failed to reset plugin state", exc_info=True)


def _get_manager() -> StateManager:
    """Get or create the state manager for the current workspace."""
    return _plugin_module()._get_manager()


def _get_state() -> Optional[EngineeringRunState]:
    """Get the current run state (from memory or disk)."""
    return _plugin_module()._get_state()


def _save_state() -> None:
    """Persist the current run state."""
    _plugin_module()._save_state()


def _set_state(state: EngineeringRunState) -> None:
    """Replace the shared plugin-owned state object."""
    _plugin_module()._session_state = state


# ── Tool: engineering_loop_start ───────────────────────────────────────────


def _handle_start(
    goal: str,
    acceptance_criteria: Optional[List[str]] = None,
    loop_type: str = "",
    task_source: str = "",
    session_id: str = "",
    force: bool = False,
) -> Dict[str, Any]:
    """Start a new engineering loop run."""
    mgr = _get_manager()
    existing = mgr.load()
    if existing and existing.active:
        if not force:
            return {
                "ok": False,
                "error": "An active engineering run already exists. Complete it first or pass force=true to archive it.",
                "run_id": existing.run_id,
            }
        existing.outcome = "Force-finalized before replacement engineering run."
        mgr.finalize(existing)
        _plugin_module()._session_state = None

    # Auto-classify if loop_type not specified
    if not loop_type:
        lt = classify_loop(goal, acceptance_criteria or [], [])
        loop_type = lt.value

    state = mgr.create(
        goal=goal,
        loop_type=loop_type,
        acceptance_criteria=acceptance_criteria or [],
        session_id=session_id,
        task_source=task_source,
    )
    _set_state(state)

    header = mgr.build_header(state)
    return {
        "ok": True,
        "run_id": state.run_id,
        "loop_type": state.loop_type,
        "phase": state.phase,
        "header_summary": header.render()[:600],
    }


# ── Tool: engineering_loop_status ──────────────────────────────────────────


def _handle_status() -> Dict[str, Any]:
    """Return the current engineering run status."""
    state = _get_state()
    if state is None:
        return {"ok": False, "error": "No engineering run active."}

    mgr = _get_manager()
    header = mgr.build_header(state)

    gate_status = []
    for g in state.verification_gates:
        icon = "[PASS]" if g.passed else "[FAIL]"
        gate_status.append(f"{icon} {g.gate_name} ({g.duration_seconds:.1f}s)")

    return {
        "ok": True,
        "run_id": state.run_id,
        "goal": state.goal,
        "loop_type": state.loop_type,
        "phase": state.phase,
        "iteration": state.iteration_count,
        "gates": gate_status,
        "failures": len(state.failures),
        "stuck": bool(state.stuck_signals),
        "reviewer": (
            state.reviewer.status.value
            if hasattr(state.reviewer.status, "value")
            else str(state.reviewer.status)
        ),
        "commit": state.commit_status,
        "header": header.render(),
    }


# ── Tool: engineering_loop_update ──────────────────────────────────────────


def _handle_update(
    phase: str = "",
    hypothesis: str = "",
    changed_files: Optional[List[str]] = None,
    iteration_count: Optional[int] = None,
    budget_remaining: Optional[int] = None,
) -> Dict[str, Any]:
    """Update the engineering run state."""
    state = _get_state()
    if state is None:
        return {"ok": False, "error": "No engineering run active."}

    if phase:
        state.phase = phase
    if hypothesis:
        state.hypothesis = hypothesis
    if changed_files is not None:
        state.changed_files = list(
            dict.fromkeys(state.changed_files + changed_files)
        )  # merge unique
    if iteration_count is not None:
        state.iteration_count = iteration_count
    if budget_remaining is not None:
        state.budget_remaining = budget_remaining

    _save_state()
    return {"ok": True, "phase": state.phase, "iteration": state.iteration_count}


# ── Tool: engineering_loop_record_feedback ─────────────────────────────────


def _handle_record_feedback(
    command: str,
    cwd: str,
    exit_code: int,
    stdout: str = "",
    stderr: str = "",
    timeout: bool = False,
    log_path: str = "",
    affected_files: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Record structured feedback from a command execution."""
    state = _get_state()
    if state is None:
        return {"ok": False, "error": "No engineering run active."}

    start_time = time.time() - 1  # approximate
    end_time = time.time()

    fb = parse_command_feedback(
        command=command,
        cwd=cwd,
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        start_time=start_time,
        end_time=end_time,
        timeout=timeout,
        log_path=log_path,
    )

    mgr = _get_manager()
    mgr.append_event("feedback_recorded", {
        "command": command,
        "exit_code": exit_code,
        "failure_class": fb.failure_class,
    })

    # Track changed files
    if affected_files:
        state.changed_files = list(
            dict.fromkeys(state.changed_files + affected_files)
        )

    state.commands_run.append(command)

    # Classify and fingerprint failure
    stuck_signal = None
    if exit_code != 0 or timeout:
        fc = fb.failure_class or FailureClass.UNKNOWN.value
        fingerprint = fingerprint_failure(
            FailureClass(fc) if fc else FailureClass.UNKNOWN,
            command,
            stderr or stdout,
        )
        failure_record = FailureRecord(
            failure_class=fc,
            command=command,
            message=stderr[:300] or stdout[:300],
            fingerprint=fingerprint,
            occurred_at=time.time(),
        )
        state.failures.append(failure_record)

        # Check for stuck
        stuck_signal = detect_stuck_signal(
            state.failures, state.changed_files
        )
        if stuck_signal:
            state.stuck_signals.append(stuck_signal)

    _save_state()

    result = {
        "ok": True,
        "failure_class": fb.failure_class,
        "root_cause": fb.root_cause,
        "recommendation": fb.recommendation,
        "stuck_signal": stuck_signal,
    }
    if stuck_signal:
        result["warning"] = stuck_signal

    # Outcome-gated learning: strengthen/punish stashed lessons (or auto_outcome).
    valence = -0.8 if (exit_code != 0 or timeout) else 0.8
    result["experience_signal"] = _emit_outcome_signal(
        valence=valence,
        derivation=_derivation_for_command(command),
        note=f"feedback exit={exit_code} timeout={timeout} cmd={command[:200]}",
    )
    return result


# ── Tool: engineering_loop_run_gate ────────────────────────────────────────


def _handle_run_gate(
    gate_name: str = "",
    all_gates: bool = False,
) -> Dict[str, Any]:
    """Execute verification gates."""
    state = _get_state()
    if state is None:
        return {"ok": False, "error": "No engineering run active."}

    mgr = _get_manager()
    log_dir = mgr.logs_dir

    # Discover gates if none cached
    if not state.verification_gates and not gate_name:
        discovered = discover_gates(Path(state.workspace_path))
        if not discovered:
            result = GateResult(
                gate_name="gate-discovery",
                command="discover_gates",
                exit_code=0,
                passed=True,
                duration_seconds=0.0,
                required=False,
                stdout_snippet="No gates discovered for this project.",
                executed_at=time.time(),
            )
            state.verification_gates = [result]
            mgr.save_gate_results(state.verification_gates)
            _save_state()
            return {
                "ok": True,
                "total": 1,
                "passed": 1,
                "failed": 0,
                "results": [
                    {
                        "name": result.gate_name,
                        "passed": result.passed,
                        "required": result.required,
                        "duration_s": 0.0,
                        "error": "",
                    }
                ],
                "message": "No gates discovered for this project; recorded optional gate-discovery evidence.",
            }
        # Convert to definitions that will be executed
        gates_to_run = discovered
    elif gate_name:
        # Re-discover and find the specific gate
        discovered = discover_gates(Path(state.workspace_path))
        gates_to_run = [g for g in discovered if g.name == gate_name]
        if not gates_to_run:
            return {"ok": False, "error": f"Gate '{gate_name}' not found."}
    elif all_gates:
        # Re-discover all
        gates_to_run = discover_gates(Path(state.workspace_path))
    else:
        return {"ok": False, "error": "Specify a gate name or set all_gates=true."}

    # Execute gates
    results = execute_gates(gates_to_run, log_dir, stop_on_failure=True)

    if not results and state.verification_gates:
        # Re-running all_gates in a project with no discovered gates must be
        # idempotent. Preserve prior optional gate-discovery evidence instead
        # of overwriting it with an empty list.
        results = state.verification_gates

    # Merge results into state
    state.verification_gates = results
    mgr.save_gate_results(results)
    _save_state()

    passed = sum(1 for r in results if r.passed)
    failed = len(results) - passed
    # Skip empty / optional "no gates discovered" noise for learning.
    real_results = [r for r in results if getattr(r, "gate_name", "") != "gate-discovery"]
    exp = None
    if real_results:
        valence = 1.0 if failed == 0 else -1.0
        names = ",".join(getattr(r, "gate_name", "?") for r in real_results[:5])
        exp = _emit_outcome_signal(
            valence=valence,
            derivation="test_result",
            note=f"gates passed={passed} failed={failed} names={names}",
        )
    out = {
        "ok": True,
        "total": len(results),
        "passed": passed,
        "failed": failed,
        "results": [
            {
                "name": r.gate_name,
                "passed": r.passed,
                "required": r.required,
                "duration_s": round(r.duration_seconds, 1),
                "error": r.error[:200] if r.error else "",
            }
            for r in results
        ],
    }
    if exp is not None:
        out["experience_signal"] = exp
    return out


# ── Tool: engineering_loop_monitor_app ─────────────────────────────────────


def _handle_monitor_app(
    command: str = "",
    action: str = "status",
    port: int = 0,
    health_endpoint: str = "",
) -> Dict[str, Any]:
    """Manage the app development monitor."""
    global _app_monitor

    state = _get_state()
    if state is None:
        return {"ok": False, "error": "No engineering run active."}

    mgr = _get_manager()

    if action == "start":
        if not command:
            return {"ok": False, "error": "command is required for start action."}

        _app_monitor = AppMonitor(
            Path(state.workspace_path),
            mgr.logs_dir,
        )
        result = _app_monitor.start(
            command,
            port=port,
            health_endpoint=health_endpoint,
        )

        state.app_monitor_status = "running" if result.running else "failed"
        _save_state()

        return {
            "ok": True,
            "running": result.running,
            "ready": result.ready,
            "port": result.port,
            "health_status": result.health_status,
            "log_path": result.server_logs_path,
            "errors": result.error_summary[:500] if result.error_summary else "",
        }

    elif action == "stop":
        if _app_monitor:
            _app_monitor.stop()
            _app_monitor = None
        state.app_monitor_status = "stopped"
        _save_state()
        return {"ok": True, "stopped": True}

    elif action == "status":
        if _app_monitor and _app_monitor.is_running:
            result = _app_monitor.check()
            return {
                "ok": True,
                "running": result.running,
                "pid": result.pid,
                "errors": result.error_summary[:500] if result.error_summary else "",
            }
        return {"ok": True, "running": False, "message": "App is not running."}

    return {"ok": False, "error": f"Unknown action: {action}"}


# ── Tool: engineering_loop_request_review ──────────────────────────────────


def _handle_request_review(
    diff: str = "",
    changed_files: Optional[List[str]] = None,
    verification_results: str = "",
    reviewer_model: str = "",
    risks: str = "",
) -> Dict[str, Any]:
    """Request an adversarial review."""
    state = _get_state()
    if state is None:
        return {"ok": False, "error": "No engineering run active."}

    # Get diff if not provided
    if not diff:
        diff = get_diff(Path(state.workspace_path))

    if not changed_files:
        changed_files = get_changed_files(Path(state.workspace_path))

    if not verification_results:
        verification_results = json.dumps([
            {"name": g.gate_name, "passed": g.passed}
            for g in state.verification_gates
        ], indent=2)

    # Build review context
    review_prompt = build_review_context(
        goal=state.goal,
        acceptance_criteria=state.acceptance_criteria,
        loop_type=state.loop_type,
        changed_files=changed_files or [],
        diff=diff,
        verification_results=verification_results,
        risks=risks,
    )

    mgr = _get_manager()

    # Mark that we need a reviewer response — the actual review is routed
    # via delegate_task by the calling agent.  We provide the review prompt
    # and context, and parse whatever comes back.
    return {
        "ok": True,
        "review_prompt": review_prompt[:12000],  # Cap for context
        "run_id": state.run_id,
        "changed_files": changed_files,
        "instruction": (
            "Delegate this review to a DIFFERENT model or agent using "
            "delegate_task. The reviewer must return JSON: "
            '{"verdict": "PASS|CHANGES_REQUIRED|BLOCKED", "feedback": "...", '
            '"action_items": [...]}. '
            "Then call engineering_loop_update with the reviewer_response parameter."
        ),
    }


# ── Tool: engineering_loop_check_termination ───────────────────────────────


def _handle_check_termination(
    reviewer_response: str = "",
    reviewer_model: str = "",
    main_model: str = "",
) -> Dict[str, Any]:
    """Check if the engineering run can be terminated."""
    state = _get_state()
    if state is None:
        return {"ok": False, "error": "No engineering run active."}

    issues: List[str] = []
    warnings: List[str] = []

    # 1. Check acceptance criteria
    if not state.acceptance_criteria:
        issues.append("No acceptance criteria defined.")

    # 2. Check gates
    if not state.verification_gates:
        issues.append("No verification gates have been run.")
    else:
        for gate in state.verification_gates:
            if getattr(gate, "required", True) and not gate.passed:
                issues.append(f"Required gate '{gate.gate_name}' failed.")

    # 3. Check reviewer
    if reviewer_response:
        parsed = parse_review_response(reviewer_response)
        state.reviewer = parsed
        state.reviewer.reviewer_model = reviewer_model

        # Check same-model.  Deterministic and hybrid work require an
        # independent reviewer; subjective/non-deterministic work records the
        # warning but does not block termination.
        if check_same_model(main_model, "", reviewer_model, ""):
            state.reviewer.same_model_warning = True
            warning = (
                "WARNING: Reviewer used the same model as the main agent. "
                "Independent review is required for deterministic and hybrid work."
            )
            loop_type = (
                state.loop_type.value
                if hasattr(state.loop_type, "value")
                else str(state.loop_type)
            )
            if loop_type == LoopType.NON_DETERMINISTIC.value:
                warnings.append(warning)
            else:
                issues.append(warning)

        mgr = _get_manager()
        mgr.save_reviewer_feedback(parsed)

        if parsed.status == ReviewerStatus.CHANGES_REQUIRED:
            issues.append(f"Reviewer requires changes: {parsed.feedback[:200]}")
        elif parsed.status == ReviewerStatus.BLOCKED:
            issues.append(f"Review blocked: {parsed.feedback[:200]}")

    elif state.reviewer.status == ReviewerStatus.PENDING:
        issues.append("Adversarial review has not been completed.")

    # 4. Check commit
    if state.commit_status == CommitStatus.FAILED.value:
        issues.append("Commit failed.")

    _save_state()

    can_complete = len(issues) == 0
    can_complete = can_complete and (
        state.reviewer.status == ReviewerStatus.PASS
        or state.reviewer.status == ReviewerStatus.PENDING  # review skipped
    )

    return {
        "ok": True,
        "can_complete": can_complete,
        "issues": issues,
        "warnings": warnings,
        "phase": state.phase,
        "reviewer_status": (
            state.reviewer.status.value
            if hasattr(state.reviewer.status, "value")
            else str(state.reviewer.status)
        ),
        "next_action": "complete" if can_complete else "resolve issues",
    }


# ── Tool: engineering_loop_commit ──────────────────────────────────────────


def _handle_commit(
    message: str = "",
    author: str = "",
) -> Dict[str, Any]:
    """Commit changes safely."""
    state = _get_state()
    if state is None:
        return {"ok": False, "error": "No engineering run active."}

    workspace = Path(state.workspace_path)

    issues: List[str] = []
    if not state.verification_gates:
        issues.append("No verification gates have been run.")
    else:
        for gate in state.verification_gates:
            if getattr(gate, "required", True) and not gate.passed:
                issues.append(f"Required gate '{gate.gate_name}' failed.")

    if state.reviewer.status != ReviewerStatus.PASS:
        issues.append("Adversarial review has not passed.")
    else:
        loop_type = (
            state.loop_type.value
            if hasattr(state.loop_type, "value")
            else str(state.loop_type)
        )
        if state.reviewer.same_model_warning and loop_type in (
            LoopType.DETERMINISTIC.value,
            LoopType.HYBRID.value,
        ):
            issues.append(
                "Reviewer used the same model as the main agent. "
                "Independent review is required for deterministic and hybrid work."
            )

    if issues:
        state.commit_status = CommitStatus.FAILED.value
        _save_state()
        return {
            "ok": False,
            "commit_hash": "",
            "error": "Cannot commit: " + "; ".join(issues),
        }

    files_to_stage = state.changed_files or get_changed_files(workspace)
    staged, stage_error = stage_files_safely(workspace, files_to_stage)
    if not staged:
        state.commit_status = CommitStatus.FAILED.value
        _save_state()
        return {"ok": False, "commit_hash": "", "error": stage_error}

    # Build commit message if not provided
    if not message:
        changed = get_changed_files(workspace)
        message = f"feat: {state.goal[:80]}\n\n"
        if changed:
            message += "Changed files:\n" + "\n".join(f"- {f}" for f in changed[:10])

    success, result = commit(workspace, message, author)
    if success:
        state.commit_status = CommitStatus.COMMITTED.value
        state.commit_hash = result
    else:
        state.commit_status = CommitStatus.FAILED.value

    _save_state()
    return {
        "ok": success,
        "commit_hash": state.commit_hash if success else "",
        "error": "" if success else result,
    }


# ── Tool: engineering_loop_export_trace ────────────────────────────────────


def _handle_export_trace() -> Dict[str, Any]:
    """Export the engineering run trace for self-evolution."""
    state = _get_state()
    if state is None:
        return {"ok": False, "error": "No engineering run active."}

    mgr = _get_manager()
    events = list(mgr.iter_events())
    trace_path = export_trace_to_file(state, events, mgr.artifacts_dir)

    return {
        "ok": True,
        "trace_path": str(trace_path),
        "run_id": state.run_id,
        "metrics": {
            "iterations": state.iteration_count,
            "tool_calls": state.tool_calls_observed,
            "failures": len(state.failures),
            "gates_passed": sum(1 for g in state.verification_gates if g.passed),
        },
    }


# ── Tool Registration (called from __init__.py register()) ─────────────────


TOOL_DEFINITIONS = [
    {
        "name": "engineering_loop_start",
        "description": (
            "Start a new engineering loop run. Initializes state, classifies the "
            "task, and prepares the harness for Observe → Decide → Act → Capture "
            "Feedback → Check Termination cycle."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "The engineering goal/task description.",
                },
                "acceptance_criteria": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of specific, testable acceptance criteria.",
                },
                "loop_type": {
                    "type": "string",
                    "enum": ["deterministic", "non_deterministic", "hybrid"],
                    "description": "Auto-detected if not specified.",
                },
                "task_source": {
                    "type": "string",
                    "description": "Where this task came from (e.g., kanban, human, cron).",
                },
                "session_id": {
                    "type": "string",
                    "description": "Current session identifier.",
                },
                "force": {
                    "type": "boolean",
                    "description": "Archive/finalize an existing active run before starting a replacement.",
                },
            },
            "required": ["goal"],
        },
        "handler": _handle_start,
    },
    {
        "name": "engineering_loop_status",
        "description": "Get the current engineering loop status including gates, failures, reviewer, and commit state.",
        "parameters": {"type": "object", "properties": {}, "required": []},
        "handler": _handle_status,
    },
    {
        "name": "engineering_loop_update",
        "description": "Update the engineering run state (phase, hypothesis, changed files, iteration count).",
        "parameters": {
            "type": "object",
            "properties": {
                "phase": {
                    "type": "string",
                    "description": "Current phase: init, observe, decide, act, capture_feedback, check_termination, complete, blocked, stuck, review.",
                },
                "hypothesis": {"type": "string", "description": "Current working hypothesis."},
                "changed_files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Files changed in this iteration.",
                },
                "iteration_count": {"type": "integer", "description": "Current iteration count."},
                "budget_remaining": {"type": "integer", "description": "Remaining iteration budget."},
            },
        },
        "handler": _handle_update,
    },
    {
        "name": "engineering_loop_record_feedback",
        "description": (
            "Record structured feedback from a command execution. Classifies failures, "
            "fingerprints them for dedup, and detects stuckness."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The command that was run."},
                "cwd": {"type": "string", "description": "Working directory of the command."},
                "exit_code": {"type": "integer", "description": "Exit code of the command."},
                "stdout": {"type": "string", "description": "Standard output from the command."},
                "stderr": {"type": "string", "description": "Standard error from the command."},
                "timeout": {"type": "boolean", "description": "Whether the command timed out."},
                "log_path": {"type": "string", "description": "Path to the full log file."},
                "affected_files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Files affected by this command.",
                },
            },
            "required": ["command", "cwd", "exit_code"],
        },
        "handler": _handle_record_feedback,
    },
    {
        "name": "engineering_loop_run_gate",
        "description": (
            "Execute verification gates (format, lint, typecheck, test, build). "
            "Discovers gates from project conventions if none specified."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "gate_name": {
                    "type": "string",
                    "description": "Name of a specific gate to run (e.g., 'unit', 'lint').",
                },
                "all_gates": {
                    "type": "boolean",
                    "description": "Run all discovered gates in order.",
                },
            },
        },
        "handler": _handle_run_gate,
    },
    {
        "name": "engineering_loop_monitor_app",
        "description": (
            "Manage a development server lifecycle: start, check status, or stop. "
            "Captures logs, detects readiness, and runs health checks."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Dev server start command (required for start)."},
                "action": {
                    "type": "string",
                    "enum": ["start", "stop", "status"],
                    "description": "Action to perform.",
                },
                "port": {"type": "integer", "description": "Expected port number."},
                "health_endpoint": {
                    "type": "string",
                    "description": "Health check URL path (e.g., '/api/health').",
                },
            },
            "required": ["action"],
        },
        "handler": _handle_monitor_app,
    },
    {
        "name": "engineering_loop_request_review",
        "description": (
            "Request an adversarial code review. Returns a review prompt to be "
            "delegated to a DIFFERENT model or agent via delegate_task."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "diff": {"type": "string", "description": "Full diff of changes (auto-detected if omitted)."},
                "changed_files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of changed files.",
                },
                "verification_results": {
                    "type": "string",
                    "description": "Verification gate results summary.",
                },
                "reviewer_model": {"type": "string", "description": "Model to use for review."},
                "risks": {"type": "string", "description": "Known risks to highlight."},
            },
        },
        "handler": _handle_request_review,
    },
    {
        "name": "engineering_loop_check_termination",
        "description": (
            "Check if the engineering run meets all termination criteria: "
            "acceptance criteria, gates, review, and commit status."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "reviewer_response": {
                    "type": "string",
                    "description": "Raw response from the reviewer agent (JSON verdict).",
                },
                "reviewer_model": {"type": "string", "description": "Model used for review."},
                "main_model": {"type": "string", "description": "Main agent model for same-model detection."},
            },
        },
        "handler": _handle_check_termination,
    },
    {
        "name": "engineering_loop_commit",
        "description": (
            "Commit changes safely. Only commits after gates pass and review passes. "
            "Excludes secrets, logs, caches, and unrelated files."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Commit message (auto-generated if omitted)."},
                "author": {"type": "string", "description": "Optional commit author."},
            },
        },
        "handler": _handle_commit,
    },
    {
        "name": "engineering_loop_export_trace",
        "description": (
            "Export a structured trace of the engineering run for consumption by "
            "Hermes' existing self-evolution and learning tooling."
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
        "handler": _handle_export_trace,
    },
]


def _adapt_handler(handler):
    """Adapt a named-parameter handler to the registry calling contract.

    The central registry dispatches every tool as ``handler(args, **kwargs)``
    where ``args`` is the parameters dict and ``**kwargs`` carries framework
    injections (e.g. ``task_id``). The engineering-loop handlers are written
    with explicit named parameters, so we translate here: pull each declared
    parameter out of ``args`` (falling back to framework kwargs), and silently
    drop any framework kwargs the handler doesn't declare. This keeps the
    handler signatures readable while staying compatible with the registry.

    Handlers return plain dicts for readability; the registry's tool-result
    contract only accepts strings (or the multimodal envelope). Serialize
    dict/list results here so dispatch does not rewrite them as
    ``tool_result_contract`` / \"unsupported result type\" errors (seen on every
    kanban worker ``engineering_loop_start`` call in DOX logs).
    """
    sig = inspect.signature(handler)
    param_names = set(sig.parameters)
    accepts_var_kw = any(
        p.kind is inspect.Parameter.VAR_KEYWORD
        for p in sig.parameters.values()
    )

    def _normalize_result(result):
        if isinstance(result, str):
            return result
        if (
            isinstance(result, dict)
            and result.get("_multimodal") is True
            and isinstance(result.get("content"), list)
        ):
            return result
        if isinstance(result, (dict, list)):
            return json.dumps(result, ensure_ascii=False, default=str)
        if result is None:
            return json.dumps({"ok": True}, ensure_ascii=False)
        return json.dumps({"ok": True, "result": result}, ensure_ascii=False, default=str)

    def _wrapper(args, **kwargs):
        call_kwargs = {}
        merged = {**(args or {}), **kwargs}
        if accepts_var_kw:
            # Handler can absorb everything; pass the merged mapping through.
            return _normalize_result(handler(**merged))
        for key, value in merged.items():
            if key in param_names:
                call_kwargs[key] = value
        return _normalize_result(handler(**call_kwargs))

    _wrapper.__name__ = getattr(handler, "__name__", "engineering_loop_handler")
    _wrapper.__doc__ = handler.__doc__
    return _wrapper


def register_tools() -> None:
    """Register all engineering loop tools with the central registry."""
    for tool_def in TOOL_DEFINITIONS:
        registry.register(
            name=tool_def["name"],
            toolset="engineering_loop",
            schema={
                "description": tool_def["description"],
                "parameters": tool_def["parameters"],
            },
            handler=_adapt_handler(tool_def["handler"]),
            check_fn=lambda: True,  # Always available when plugin is loaded
        )
    logger.info(
        "Registered %d engineering loop tools", len(TOOL_DEFINITIONS)
    )
