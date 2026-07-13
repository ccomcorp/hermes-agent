"""Workflow safety spine (WF0) — spec 12b §0.0.

The three primitives every workflow run is built on:

- **WorkflowGuard** — the SOLE gated entry to every side-effecting executor.
  Executors are *registered* here and can ONLY be invoked via ``dispatch()``,
  which charges the budget and enforces the per-kind policy BEFORE the executor
  runs. Inescapability is the point (fix R1): the engine has no path to an
  executor that bypasses the guard, and an unknown / unregistered side-effecting
  node kind is DENIED — a new node kind cannot ship ungated by omission.
- **RunContext** — created at ``workflow.run`` and threaded to every executor:
  identity, workspace/profile, model, approval sink, origin, and the shared
  budget (fix R3 — bounds tool-invoked re-entry).
- **ApprovalSink** — where a guarded node sends an approval request. For
  non-interactive origins (cron/webhook/hook) with no client, the default is
  **fail-closed** (fix R2 / KU-4).

This module is pure Python (no gateway/delegate imports) so it is fully unit
testable. The gateway approval-queue binding and the delegated-child threading
are the *integration* slices (WF2/WF3) that CONSUME these primitives.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, Callable, Optional
from urllib.parse import urlparse


class WorkflowHalted(Exception):
    """A run exceeded its step/time budget — halt forward-only, log, stop."""


class WorkflowGuardDenied(Exception):
    """The guard refused to dispatch a node (policy denial or unknown kind)."""

    def __init__(self, kind: str, reason: str) -> None:
        self.kind = kind
        self.reason = reason
        super().__init__(f"workflow node '{kind}' denied: {reason}")


# --------------------------------------------------------------------------- budget

@dataclass
class Budget:
    """Shared step/time bound for a whole run, including tool-invoked re-entry
    (a nested ``workflow.run`` threads the SAME Budget instance — fix R3)."""

    max_steps: int = 50
    max_seconds: float = 300.0
    _steps: int = field(default=0, init=False)
    _start: float = field(default_factory=time.monotonic, init=False)

    def charge(self, steps: int = 1) -> None:
        self._steps += steps
        if self._steps > self.max_steps:
            raise WorkflowHalted(f"step budget exceeded ({self._steps}/{self.max_steps})")
        if (time.monotonic() - self._start) > self.max_seconds:
            raise WorkflowHalted(f"time budget exceeded (> {self.max_seconds}s)")

    @property
    def steps(self) -> int:
        return self._steps


# --------------------------------------------------------------------------- approval

class ApprovalDecision(Enum):
    ALLOW = "allow"
    DENY = "deny"


class ApprovalSink:
    """Abstract: where a guarded node's approval request goes.

    ``request()`` is synchronous by contract (the guard blocks on the decision).
    The two in-process sinks below are trivially sync. The INTERACTIVE
    ``GatewaySink`` is a WF2 deliverable, NOT built here: it must register a
    pending approval keyed by ``run_ctx.run_channel`` (the synthetic ``run:<id>``
    sid), push ``approval.request`` over the gateway, and block this worker thread
    on an ``Event``/future until the async, session-keyed gateway loop resolves
    it — i.e. it internally bridges async→sync so THIS interface stays sync. That
    marshalling is the WF2 integration's job; WF0 only guarantees the run is
    addressable (``run_channel``) and the fail-closed default is safe."""

    def request(self, run_ctx: "RunContext", node_kind: str, detail: str) -> ApprovalDecision:
        raise NotImplementedError


class FailClosedSink(ApprovalSink):
    """Non-interactive origins (cron/webhook/hook) with no client: DENY + notify
    (fix R2 / KU-4). Default for unattended runs."""

    def __init__(self, notify: Optional[Callable[[str], None]] = None) -> None:
        self._notify = notify

    def request(self, run_ctx: "RunContext", node_kind: str, detail: str) -> ApprovalDecision:
        if self._notify:
            try:
                self._notify(
                    f"workflow {run_ctx.run_id}: '{node_kind}' needs approval but no "
                    f"interactive client is present — auto-denied ({detail})."
                )
            except Exception:
                pass
        return ApprovalDecision.DENY


class AllowlistSink(ApprovalSink):
    """Opt-in for an explicitly ``unattended: true`` workflow: only the listed
    node kinds auto-approve; everything else defers to ``fallback`` (fail-closed)."""

    def __init__(self, allowed_kinds: set[str], fallback: ApprovalSink) -> None:
        self._allowed = set(allowed_kinds)
        self._fallback = fallback

    def request(self, run_ctx: "RunContext", node_kind: str, detail: str) -> ApprovalDecision:
        if node_kind in self._allowed:
            return ApprovalDecision.ALLOW
        return self._fallback.request(run_ctx, node_kind, detail)


# --------------------------------------------------------------------------- run context

@dataclass
class RunContext:
    run_id: str
    workflow_id: str
    workspace_root: str
    origin: str                       # "manual" | "cron" | "webhook" | "hook"
    approval_sink: ApprovalSink
    budget: Budget
    profile_home: Optional[str] = None
    model: Optional[str] = None
    http_allowlist: tuple[str, ...] = ()
    allow_code_node: bool = False
    # Synthetic sid ("run:<id>") so the runId-addressable gateway approval/event
    # queue can address a run with no desktop session (R2 / §2). Set by workflow.run.
    run_channel: Optional[str] = None
    # A constructed headless AIAgent for cron/webhook `ai-agent` nodes that have no
    # session agent to borrow (R1 / Open Q1). Opaque here; supplied by the engine.
    headless_agent: Any = None

    def derive_child(self) -> "RunContext":
        """Context for a delegated sub-agent (an `ai-agent` node's child). Shares
        the SAME budget, approval sink, and egress allowlist so the child's tools
        charge the same budget and pass the same policy — the seam WF3's
        child-tool wrapper consumes to close R1 (the child cannot bypass the guard)."""
        return replace(self)  # shallow copy: budget/approval_sink are shared references


# --------------------------------------------------------------------------- guard

@dataclass
class GuardResult:
    allowed: bool
    reason: str = ""


Executor = Callable[[dict, RunContext], Any]  # (node, run_ctx) -> node output payload


def _host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except (ValueError, TypeError):
        return ""


class WorkflowGuard:
    """The dispatcher. Executors are ONLY reachable through ``dispatch``."""

    # In-engine, no side effect — never touch a registered executor or an approval.
    PURE_KINDS = frozenset({
        "manual-trigger", "condition", "switch", "filter", "merge", "loop",
        "set-fields", "template", "json", "sort", "limit", "aggregate", "output",
    })

    # Side-effecting / agent-invoking — always approval-gated unless a narrower
    # policy (http allowlist, code config) applies below.
    _APPROVAL_KINDS = frozenset({
        "ai-agent", "generate-image", "send_message", "subworkflow",
        "schedule-trigger", "webhook-trigger", "human-approval",
        "parameter-extractor", "question-classifier", "delay",
    })

    def __init__(self) -> None:
        self.__executors: dict[str, Executor] = {}

    def register(self, kind: str, executor: Executor) -> None:
        self.__executors[kind] = executor

    # --- policy ---------------------------------------------------------------
    def _approve(self, ctx: RunContext, kind: str, detail: str) -> GuardResult:
        decision = ctx.approval_sink.request(ctx, kind, detail)
        if decision == ApprovalDecision.ALLOW:
            return GuardResult(True, "approved")
        return GuardResult(False, f"denied: {detail}")

    def policy(self, node: dict, ctx: RunContext) -> GuardResult:
        kind = node.get("kind", "")
        if kind in self.PURE_KINDS:
            return GuardResult(True)
        if kind == "http-request":
            host = _host_of((node.get("config") or {}).get("url", ""))
            if host and host in ctx.http_allowlist:
                return GuardResult(True)
            return self._approve(ctx, kind, f"HTTP to {host or '<no host>'} (not allowlisted)")
        if kind == "code":
            if ctx.allow_code_node:
                return GuardResult(True)  # allowed by config; executor still sandboxes
            return self._approve(ctx, kind, "code execution")
        if kind in self._APPROVAL_KINDS:
            return self._approve(ctx, kind, kind)
        # Unknown kind → DENY. A new node kind cannot ship ungated by omission.
        return GuardResult(False, f"unknown node kind '{kind}'")

    # --- child-tool gate (R1 second half) -------------------------------------
    # An `ai-agent` node delegates to a child agent whose inherited web/file/
    # terminal tools run their OWN loop. WF3's child-tool wrapper MUST call
    # tool_policy() before EVERY child tool call, so that loop cannot bypass the
    # guard: it charges the shared budget (bounding the child loop) and applies
    # the same per-capability policy (egress allowlist, no unapproved writes/shell).
    # Name-hint matching is a first-cut; WF3 refines it against the real tool
    # registry. Default is ALLOW only for read-only/benign tools.
    _CHILD_EGRESS_HINT = ("http", "web", "fetch", "url", "request", "curl")
    _CHILD_WRITE_HINT = ("write", "edit", "create", "delete", "move", "rename", "save")
    _CHILD_SHELL_HINT = ("terminal", "shell", "command", "exec", "bash", "run_")

    def tool_policy(self, tool_name: str, args: dict, ctx: RunContext) -> GuardResult:
        name = (tool_name or "").lower()
        ctx.budget.charge()                       # a child tool call costs budget too
        args = args or {}
        if any(h in name for h in self._CHILD_EGRESS_HINT):
            host = _host_of(args.get("url") or args.get("host") or "")
            if host and host in ctx.http_allowlist:
                return GuardResult(True)
            return self._approve(ctx, name, f"child egress to {host or '<unknown host>'} (not allowlisted)")
        if any(h in name for h in self._CHILD_WRITE_HINT):
            return self._approve(ctx, name, f"child file mutation via '{name}'")
        if any(h in name for h in self._CHILD_SHELL_HINT):
            return self._approve(ctx, name, f"child shell via '{name}'")
        return GuardResult(True)                  # read-only / benign child tool

    # --- dispatch (the only path to an executor) ------------------------------
    def dispatch(self, node: dict, ctx: RunContext) -> Any:
        ctx.budget.charge()                       # every node costs budget (R3)
        result = self.policy(node, ctx)           # gate BEFORE any side effect (R1)
        if not result.allowed:
            raise WorkflowGuardDenied(node.get("kind", ""), result.reason)
        kind = node.get("kind", "")
        executor = self.__executors.get(kind)
        if executor is None:
            if kind in self.PURE_KINDS:
                return None                        # engine handles pure nodes itself
            # A side-effecting kind that passed policy but has no executor cannot run.
            raise WorkflowGuardDenied(kind, f"no executor registered for '{kind}'")
        return executor(node, ctx)
