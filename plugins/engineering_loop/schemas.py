"""Engineering Loop Harness — data schemas and enums.

All state structs used by the harness: run state, gate definitions,
feedback records, failure fingerprints, and event log entries.
"""

from __future__ import annotations

import enum
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional


# ── Enums ──────────────────────────────────────────────────────────────────


class LoopType(enum.Enum):
    """Classification of engineering work determinism."""

    DETERMINISTIC = "deterministic"          # Tests, build, lint — objective
    NON_DETERMINISTIC = "non_deterministic"  # UI, design, copy — subjective
    HYBRID = "hybrid"                        # Both objective + subjective gates


class RunPhase(enum.Enum):
    """Current phase of the engineering run."""

    INIT = "init"                  # Run created, not yet started
    OBSERVE = "observe"            # Gathering context
    DECIDE = "decide"              # Choosing next action
    ACT = "act"                    # Executing
    CAPTURE_FEEDBACK = "capture_feedback"  # Processing results
    CHECK_TERMINATION = "check_termination"
    COMPLETE = "complete"
    BLOCKED = "blocked"            # Needs human input
    STUCK = "stuck"                # Thrashing detected
    REVIEW = "review"              # Waiting for adversarial review


class ReviewerStatus(enum.Enum):
    """Adversarial review result."""

    PENDING = "pending"
    PASS = "PASS"
    CHANGES_REQUIRED = "CHANGES_REQUIRED"
    BLOCKED = "BLOCKED"


class CommitStatus(enum.Enum):
    """Commit workflow state."""

    PENDING = "pending"
    VERIFIED = "verified"          # Gates pass, review pass
    COMMITTED = "committed"        # git commit succeeded
    FAILED = "failed"              # commit attempt failed
    SKIPPED = "skipped"            # No commit required


class FailureClass(enum.Enum):
    """Taxonomy of failure types for classification and retry logic."""

    TRANSIENT = "transient"
    SETUP_ENVIRONMENT = "setup/environment"
    DEPENDENCY = "dependency"
    PERMISSION = "permission"
    COMPILE_SYNTAX = "compile/syntax"
    TYPECHECK = "typecheck"
    LINT = "lint"
    UNIT_TEST = "unit_test"
    INTEGRATION_TEST = "integration_test"
    E2E_TEST = "e2e_test"
    RUNTIME = "runtime"
    APP_MONITOR = "app_monitor"
    VISUAL_UX = "visual/ux"
    SECURITY = "security"
    TOOL_LIMITATION = "tool_limitation"
    MISSING_INFORMATION = "missing_information"
    EXTERNAL_SERVICE = "external_service"
    REVIEWER_BLOCKED = "reviewer_blocked"
    HUMAN_INPUT_REQUIRED = "human_input_required"
    UNKNOWN = "unknown"


# ── State Dataclasses ──────────────────────────────────────────────────────


@dataclass
class GateDefinition:
    """A single verification gate discovered from project conventions."""

    name: str
    command: str
    cwd: str = "."
    timeout: int = 300
    env: Dict[str, str] = field(default_factory=lambda: {"CI": "true"})
    pass_pattern: Optional[str] = None
    fail_pattern: Optional[str] = None
    retry_policy: str = "none"    # "none", "once", "twice"
    required: bool = True
    output_log_path: Optional[str] = None


@dataclass
class GateResult:
    """Result of executing a single gate."""

    gate_name: str
    command: str
    exit_code: int
    passed: bool
    duration_seconds: float
    stdout_snippet: str = ""
    stderr_snippet: str = ""
    log_path: str = ""
    error: str = ""
    attempts: int = 1
    executed_at: float = 0.0


@dataclass
class FeedbackRecord:
    """Structured feedback from a single action (command, test, app check)."""

    action_type: str                # "command", "test", "app_monitor", "browser"
    command: str
    cwd: str
    start_time: float
    end_time: float
    exit_code: int
    timeout: bool = False
    stdout_excerpt: str = ""
    stderr_excerpt: str = ""
    full_log_path: str = ""
    failure_class: Optional[str] = None  # FailureClass value
    root_cause: str = ""
    affected_files: List[str] = field(default_factory=list)
    recommendation: str = ""


@dataclass
class FailureRecord:
    """A classified failure with fingerprint for stuck detection."""

    failure_class: str
    command: str
    message: str
    fingerprint: str            # Normalized hash for dedup
    occurred_at: float
    count: int = 1


@dataclass
class AppMonitorResult:
    """Result of an app monitoring check."""

    start_command: str
    pid: int = 0
    running: bool = False
    ready: bool = False
    port: int = 0
    health_endpoint: str = ""
    health_status: int = 0
    screenshot_path: str = ""
    console_errors: List[str] = field(default_factory=list)
    server_logs_path: str = ""
    error_summary: str = ""
    started_at: float = 0.0
    checked_at: float = 0.0


@dataclass
class ReviewerResult:
    """Adversarial review outcome."""

    status: ReviewerStatus = ReviewerStatus.PENDING
    reviewer_model: str = ""
    reviewer_agent: str = ""
    feedback: str = ""
    action_items: List[str] = field(default_factory=list)
    reviewed_at: float = 0.0
    same_model_warning: bool = False


@dataclass
class EngineeringRunState:
    """Complete state of one engineering run.  Persisted to disk."""

    run_id: str = ""
    session_id: str = ""
    workspace_path: str = ""
    task_source: str = ""
    goal: str = ""
    acceptance_criteria: List[str] = field(default_factory=list)
    loop_type: str = LoopType.HYBRID.value

    phase: str = RunPhase.INIT.value
    hypothesis: str = ""
    active_skills: List[str] = field(default_factory=list)

    iteration_count: int = 0
    budget_remaining: int = 0

    changed_files: List[str] = field(default_factory=list)
    commands_run: List[str] = field(default_factory=list)
    tool_calls_observed: int = 0

    verification_gates: List[GateResult] = field(default_factory=list)
    app_monitor_status: str = "not_started"

    failures: List[FailureRecord] = field(default_factory=list)
    stuck_signals: List[str] = field(default_factory=list)

    reviewer: ReviewerResult = field(default_factory=ReviewerResult)

    human_input_required: bool = False
    human_input_question: str = ""

    commit_status: str = CommitStatus.PENDING.value
    commit_hash: str = ""

    outcome: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0
    completed_at: float = 0.0
    active: bool = True

    def __post_init__(self) -> None:
        if not self.run_id:
            self.run_id = f"erun-{uuid.uuid4().hex[:12]}"
        if not self.created_at:
            self.created_at = time.time()
        if not self.updated_at:
            self.updated_at = self.created_at

    def touch(self) -> None:
        """Update the last-modified timestamp."""
        self.updated_at = time.time()

    def to_dict(self) -> Dict[str, Any]:
        """Serialize for JSON persistence, handling nested dataclasses."""
        result: Dict[str, Any] = {}
        for k, v in asdict(self).items():
            if isinstance(v, enum.Enum):
                result[k] = v.value
            else:
                result[k] = v
        return result


@dataclass
class EngineeringRunHeader:
    """Compact summary for injection into the LLM context.  Keep under ~500 chars."""

    goal: str = ""
    acceptance_criteria: str = ""
    loop_type: str = ""
    phase: str = ""
    last_failure: str = ""
    verification_status: str = ""
    reviewer_status: str = ""
    human_gate: str = ""
    next_action: str = ""
    constraints: str = ""

    def render(self) -> str:
        """Render as a compact markdown block for context injection."""
        lines = ["## Engineering Run Status"]
        if self.goal:
            lines.append(f"- **Goal**: {self.goal[:200]}")
        if self.acceptance_criteria:
            lines.append(f"- **Criteria**: {self.acceptance_criteria[:200]}")
        if self.loop_type:
            lines.append(f"- **Loop**: {self.loop_type}")
        if self.phase:
            lines.append(f"- **Phase**: {self.phase}")
        if self.last_failure:
            lines.append(f"- **Last Failure**: {self.last_failure[:150]}")
        if self.verification_status:
            lines.append(f"- **Gates**: {self.verification_status}")
        if self.reviewer_status:
            lines.append(f"- **Review**: {self.reviewer_status}")
        if self.human_gate:
            lines.append(f"- **Human Gate**: {self.human_gate}")
        if self.next_action:
            lines.append(f"- **Next**: {self.next_action}")
        if self.constraints:
            lines.append(f"- ⚠ {self.constraints}")
        return "\n".join(lines)
