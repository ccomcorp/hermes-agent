"""WF2 — workflow execution engine (spec 13).

Drives ``WorkflowGuard.dispatch`` over a graph, threads each node's output payload
along its edges, emits ``{type, runId, workflowId, nodeId, seq}`` events, and
writes an AUTHORITATIVE append-only JSONL run log. Invariants (elicitation fixes):
- EVERY node is routed through ``guard.dispatch`` (charges budget + policy) — the
  engine NEVER calls ``run_pure_node`` without dispatching first (B1/B2).
- ``seq`` assignment + JSONL append happen under one lock (C2).
- dryRun sets ``ctx.dry_run`` + registers no side-effecting executors; dispatch
  returns a ``__dry__`` marker and the engine records+continues across the whole
  graph, never halting on the first side-effecting node (D1).
"""

from __future__ import annotations

import itertools
import json
import threading
from collections import deque
from pathlib import Path
from typing import Any, Callable, Optional

from tui_gateway.workflow_guard import (
    RunContext,
    WorkflowGuard,
    WorkflowGuardDenied,
    WorkflowHalted,
)
from tui_gateway.workflow_nodes import evaluate_condition, run_pure_node, switch_target

_FLOW_KINDS = frozenset({"condition", "switch", "loop"})


def _index(graph: dict) -> tuple[dict, dict]:
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    out_edges: dict[str, list] = {}
    for e in graph.get("edges", []):
        out_edges.setdefault(e["from"], []).append(e)
    return nodes, out_edges


def _run_log_path(workspace_root: str, run_id: str) -> Optional[Path]:
    if not workspace_root:
        return None
    p = Path(workspace_root) / ".hermes" / "workbench" / "workflows" / "runs"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{run_id}.jsonl"


def run_graph(
    graph: dict,
    ctx: RunContext,
    guard: WorkflowGuard,
    emit: Optional[Callable[[dict], None]] = None,
    max_loop: int = 1000,
) -> dict:
    """Execute a workflow graph. Returns {runId, status, steps, outputs, events, error}."""
    nodes, out_edges = _index(graph)
    seq = itertools.count()
    events: list[dict] = []
    log_path = _run_log_path(ctx.workspace_root, ctx.run_id)
    log_lock = threading.Lock()

    def _emit(etype: str, node_id: Optional[str] = None, **extra: Any) -> None:
        with log_lock:                             # seq + append atomic (C2)
            ev = {"type": etype, "runId": ctx.run_id, "workflowId": ctx.workflow_id,
                  "nodeId": node_id, "seq": next(seq), **extra}
            events.append(ev)
            if log_path:
                with open(log_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        if emit:
            emit(ev)

    # Entry nodes = manual-trigger nodes, else any node with no in-edge.
    triggers = [nid for nid, n in nodes.items() if n.get("kind") == "manual-trigger"]
    if not triggers:
        targeted = {e["to"] for es in out_edges.values() for e in es}
        triggers = [nid for nid in nodes if nid not in targeted]

    outputs: dict[str, Any] = {}
    loop_counts: dict[str, int] = {}
    status, error = "completed", None

    _emit("workflow.run.started", None, origin=ctx.origin)
    queue: deque[tuple[str, Any]] = deque((t, None) for t in triggers)
    try:
        while queue:
            node_id, payload = queue.popleft()
            node = nodes.get(node_id)
            if node is None:
                continue
            kind = node.get("kind", "")
            config = node.get("config") or {}

            try:
                result = guard.dispatch(node, ctx)   # charges budget + policy (B1/B2)
            except WorkflowGuardDenied as e:
                _emit("workflow.run.step", node_id, kind=kind, status="denied", reason=e.reason)
                if config.get("continueOnError"):
                    continue
                raise

            # Resolve this node's output payload.
            if isinstance(result, dict) and result.get("__dry__"):
                output = result                       # dry-run marker (D1)
            elif kind in _FLOW_KINDS:
                output = payload                      # flow nodes route; pass payload through
            elif result is None and kind in guard.PURE_KINDS:
                output = run_pure_node(kind, config, payload, inputs=[payload])
            else:
                output = result                       # executor result
            outputs[node_id] = output
            _emit("workflow.run.step", node_id, kind=kind, status="ok")

            # Select outgoing edges.
            edges = out_edges.get(node_id, [])
            if kind == "condition":
                truth = evaluate_condition(config, payload)
                labeled = [e for e in edges if e.get("label") in ("true", "false")]
                if labeled:
                    follow = [e for e in labeled if e.get("label") == ("true" if truth else "false")]
                else:
                    follow = edges if truth else []
            elif kind == "switch":
                target = switch_target(config, payload)
                follow = [e for e in edges if e.get("label") == target]
            elif kind == "loop":
                loop_counts[node_id] = loop_counts.get(node_id, 0) + 1
                cap = min(int(config.get("maxIterations", max_loop)), max_loop)
                if loop_counts[node_id] < cap:
                    follow = [e for e in edges if e.get("label") != "done"] or edges
                else:
                    follow = [e for e in edges if e.get("label") == "done"]
            else:
                follow = edges

            for e in follow:
                queue.append((e["to"], output))

        _emit("workflow.run.completed", None, status=status, steps=ctx.budget.steps)
    except WorkflowHalted as e:
        status, error = "halted", str(e)
        _emit("workflow.run.failed", None, status="halted", error=error)
    except WorkflowGuardDenied as e:
        status, error = "failed", str(e)
        _emit("workflow.run.failed", None, status="denied", error=error)
    except Exception as e:  # engine must never leak an unhandled exception
        status, error = "failed", f"{type(e).__name__}: {e}"
        _emit("workflow.run.failed", None, status="error", error=error)

    return {"runId": ctx.run_id, "status": status, "steps": ctx.budget.steps,
            "outputs": outputs, "events": events, "error": error}


def dry_run_graph(graph: dict, ctx: RunContext, guard: WorkflowGuard) -> dict:
    """Trace the whole graph without side effects or approvals (D1). Registers no
    side-effecting executors; ``ctx.dry_run`` makes dispatch emit ``__dry__`` markers."""
    ctx.dry_run = True
    return run_graph(graph, ctx, guard)
