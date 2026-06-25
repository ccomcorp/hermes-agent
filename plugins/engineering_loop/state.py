"""Engineering run state persistence.

Manages project-local state files: state.json, events.jsonl, and supporting
artifacts.  All writes are atomic (temp file + rename).  Event log is
append-only JSONL with recovery from partial last-line writes.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

from .schemas import (
    EngineeringRunState,
    EngineeringRunHeader,
    FeedbackRecord,
    FailureRecord,
    GateResult,
    AppMonitorResult,
    ReviewerResult,
    ReviewerStatus,
    CommitStatus,
    RunPhase,
    LoopType,
    FailureClass,
)

logger = logging.getLogger(__name__)

# Directory layout under project root
ELOOP_DIR = ".hermes" / Path("engineering-loop")
STATE_FILE = "state.json"
EVENTS_FILE = "events.jsonl"
VERIFICATION_FILE = "verification.json"
REVIEWER_FEEDBACK_FILE = "reviewer-feedback.json"
LOGS_DIR = "logs"
ARTIFACTS_DIR = "artifacts"


class StateManager:
    """Manages persistent engineering run state at a project-local path.

    Usage::

        mgr = StateManager(Path("/path/to/project"))
        state = mgr.load() or mgr.create(goal="...", loop_type="deterministic")
        mgr.save(state)
        mgr.append_event("tool_observed", {"tool": "terminal", "exit_code": 0})
    """

    def __init__(self, project_root: Path) -> None:
        self._project_root = project_root.resolve()
        self._eloop_root = self._project_root / ELOOP_DIR
        self._ensure_dirs()

    def _ensure_dirs(self) -> None:
        """Create the ELOOP directory tree if it doesn't exist."""
        self._eloop_root.mkdir(parents=True, exist_ok=True)
        (self._eloop_root / LOGS_DIR).mkdir(exist_ok=True)
        (self._eloop_root / ARTIFACTS_DIR).mkdir(exist_ok=True)

    # ── Path helpers ───────────────────────────────────────────────────────

    @property
    def state_path(self) -> Path:
        return self._eloop_root / STATE_FILE

    @property
    def events_path(self) -> Path:
        return self._eloop_root / EVENTS_FILE

    @property
    def verification_path(self) -> Path:
        return self._eloop_root / VERIFICATION_FILE

    @property
    def reviewer_feedback_path(self) -> Path:
        return self._eloop_root / REVIEWER_FEEDBACK_FILE

    @property
    def logs_dir(self) -> Path:
        return self._eloop_root / LOGS_DIR

    @property
    def artifacts_dir(self) -> Path:
        return self._eloop_root / ARTIFACTS_DIR

    # ── State CRUD ─────────────────────────────────────────────────────────

    def load(self) -> Optional[EngineeringRunState]:
        """Load the current run state from disk, or None if no state exists."""
        if not self.state_path.exists():
            return None
        try:
            raw = json.loads(self.state_path.read_text("utf-8"))
            # Handle nested dataclass reconstruction
            state = EngineeringRunState(
                run_id=raw.get("run_id", ""),
                session_id=raw.get("session_id", ""),
                workspace_path=raw.get("workspace_path", ""),
                task_source=raw.get("task_source", ""),
                goal=raw.get("goal", ""),
                acceptance_criteria=raw.get("acceptance_criteria", []),
                loop_type=raw.get("loop_type", "hybrid"),
                phase=raw.get("phase", "init"),
                hypothesis=raw.get("hypothesis", ""),
                active_skills=raw.get("active_skills", []),
                iteration_count=raw.get("iteration_count", 0),
                budget_remaining=raw.get("budget_remaining", 0),
                changed_files=raw.get("changed_files", []),
                commands_run=raw.get("commands_run", []),
                tool_calls_observed=raw.get("tool_calls_observed", 0),
                verification_gates=[
                    GateResult(**g) for g in raw.get("verification_gates", [])
                ],
                app_monitor_status=raw.get("app_monitor_status", "not_started"),
                failures=[
                    FailureRecord(**f) for f in raw.get("failures", [])
                ],
                stuck_signals=raw.get("stuck_signals", []),
                reviewer=ReviewerResult(**raw["reviewer"])
                if raw.get("reviewer")
                else ReviewerResult(),
                human_input_required=raw.get("human_input_required", False),
                human_input_question=raw.get("human_input_question", ""),
                commit_status=raw.get("commit_status", "pending"),
                commit_hash=raw.get("commit_hash", ""),
                outcome=raw.get("outcome", ""),
                created_at=raw.get("created_at", time.time()),
                updated_at=raw.get("updated_at", time.time()),
                completed_at=raw.get("completed_at", 0.0),
                active=raw.get("active", True),
            )
            return state
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            logger.warning("Failed to load engineering state: %s", exc)
            return None

    def create(
        self,
        goal: str,
        loop_type: str = "hybrid",
        acceptance_criteria: Optional[List[str]] = None,
        session_id: str = "",
        task_source: str = "",
    ) -> EngineeringRunState:
        """Create a new engineering run state."""
        state = EngineeringRunState(
            goal=goal,
            loop_type=loop_type,
            acceptance_criteria=acceptance_criteria or [],
            session_id=session_id,
            task_source=task_source,
            workspace_path=str(self._project_root),
        )
        self.save(state)
        self.append_event("run_created", {
            "run_id": state.run_id,
            "goal": state.goal,
            "loop_type": state.loop_type,
        })
        logger.info("Created engineering run %s: %s", state.run_id, state.goal)
        return state

    def save(self, state: EngineeringRunState) -> None:
        """Persist state atomically.  Safe for concurrent readers."""
        state.touch()
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(state.to_dict(), indent=2, default=str), "utf-8"
        )
        tmp.replace(self.state_path)

    def finalize(self, state: EngineeringRunState) -> None:
        """Mark a run as final and archive state."""
        state.active = False
        state.completed_at = time.time()
        self.save(state)
        self.append_event("run_finalized", {
            "run_id": state.run_id,
            "outcome": state.outcome,
        })

    # ── Event log (JSONL) ──────────────────────────────────────────────────

    def append_event(self, event_type: str, payload: Dict[str, Any]) -> None:
        """Append a structured event to the JSONL event log."""
        entry = {
            "ts": time.time(),
            "type": event_type,
            "payload": payload,
        }
        try:
            with open(self.events_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, default=str) + "\n")
        except OSError as exc:
            logger.warning("Failed to append event: %s", exc)

    def iter_events(self) -> Generator[Dict[str, Any], None, None]:
        """Yield all valid events from the JSONL log, skipping corrupt lines."""
        if not self.events_path.exists():
            return
        with open(self.events_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    # Recover from partial/corrupt last line
                    logger.debug(
                        "Skipping corrupt event line in %s",
                        self.events_path,
                    )

    # ── Gate result persistence ────────────────────────────────────────────

    def save_gate_results(self, results: List[GateResult]) -> None:
        """Persist gate results to verification.json."""
        data = [
            {
                "gate_name": r.gate_name,
                "command": r.command,
                "exit_code": r.exit_code,
                "passed": r.passed,
                "duration_seconds": r.duration_seconds,
                "stdout_snippet": r.stdout_snippet[:2000],
                "stderr_snippet": r.stderr_snippet[:2000],
                "log_path": r.log_path,
                "error": r.error,
                "attempts": r.attempts,
                "executed_at": r.executed_at,
            }
            for r in results
        ]
        tmp = self.verification_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, default=str), "utf-8")
        tmp.replace(self.verification_path)

    def load_gate_results(self) -> List[Dict[str, Any]]:
        """Load gate results from verification.json."""
        if not self.verification_path.exists():
            return []
        try:
            return json.loads(self.verification_path.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            return []

    # ── Reviewer feedback persistence ──────────────────────────────────────

    def save_reviewer_feedback(self, result: ReviewerResult) -> None:
        """Persist reviewer feedback."""
        data = {
            "status": result.status.value if hasattr(result.status, "value") else str(result.status),
            "reviewer_model": result.reviewer_model,
            "reviewer_agent": result.reviewer_agent,
            "feedback": result.feedback,
            "action_items": result.action_items,
            "reviewed_at": result.reviewed_at,
            "same_model_warning": result.same_model_warning,
        }
        tmp = self.reviewer_feedback_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, default=str), "utf-8")
        tmp.replace(self.reviewer_feedback_path)

    # ── Header generation ──────────────────────────────────────────────────

    def build_header(self, state: EngineeringRunState) -> EngineeringRunHeader:
        """Build a compact header for context injection."""
        criteria = "; ".join(state.acceptance_criteria[:3])
        if len(state.acceptance_criteria) > 3:
            criteria += "..."

        last_failure = ""
        if state.failures:
            latest = state.failures[-1]
            last_failure = f"{latest.failure_class}: {latest.message[:100]}"

        gate_status = "not run"
        if state.verification_gates:
            passed = sum(1 for g in state.verification_gates if g.passed)
            total = len(state.verification_gates)
            gate_status = f"{passed}/{total} passed"

        reviewer_status = ""
        if state.reviewer.status.value != ReviewerStatus.PENDING.value:
            reviewer_status = state.reviewer.status.value

        human_gate = ""
        if state.human_input_required:
            human_gate = f"BLOCKED: {state.human_input_question[:100]}"

        next_action = self._derive_next_action(state)

        return EngineeringRunHeader(
            goal=state.goal,
            acceptance_criteria=criteria,
            loop_type=state.loop_type,
            phase=state.phase,
            last_failure=last_failure,
            verification_status=gate_status,
            reviewer_status=reviewer_status,
            human_gate=human_gate,
            next_action=next_action,
            constraints="Run non-interactively. Use CI=true, --yes flags, and explicit timeouts.",
        )

    def _derive_next_action(self, state: EngineeringRunState) -> str:
        """Infer the recommended next action from state."""
        if state.human_input_required:
            return "Wait for human input before proceeding."
        if state.stuck_signals:
            return (
                "STUCK — try a different strategy or request human input. "
                "Do NOT repeat the same failing action."
            )
        if state.phase in (RunPhase.INIT.value, RunPhase.OBSERVE.value):
            return "Observe context: read files, inspect git, run existing tests."
        if state.reviewer.status == ReviewerStatus.CHANGES_REQUIRED:
            return "Apply reviewer feedback, then rerun gates."
        if state.reviewer.status == ReviewerStatus.BLOCKED:
            return "Review blocked. Record blocker and stop."
        if not state.verification_gates:
            return "Discover and run verification gates."
        if any(not g.passed for g in state.verification_gates if g.required):
            return "Fix failing required gates before proceeding."
        if state.reviewer.status == ReviewerStatus.PENDING:
            return "Gates pass. Route to adversarial review."
        if state.commit_status == CommitStatus.SKIPPED.value:
            return "Complete — no commit required."
        if state.commit_status == CommitStatus.PENDING.value:
            return "All gates + review pass. Commit changes."
        return "Run complete. Export traces."
