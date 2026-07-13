"""WF2 — engine tests (spec 13 acceptance)."""

from tui_gateway.workflow_guard import (
    ApprovalDecision,
    ApprovalSink,
    Budget,
    FailClosedSink,
    RunContext,
    WorkflowGuard,
)
from tui_gateway.workflow_runtime import dry_run_graph, run_graph


class _AllowSink(ApprovalSink):
    def request(self, run_ctx, node_kind, detail):
        return ApprovalDecision.ALLOW


def _ctx(tmp_path, budget=None, allow=False, http_allowlist=(), run_id="r1"):
    return RunContext(
        run_id=run_id, workflow_id="wf1", workspace_root=str(tmp_path), origin="manual",
        approval_sink=_AllowSink() if allow else FailClosedSink(),
        budget=budget or Budget(max_steps=100), http_allowlist=http_allowlist,
    )


def test_linear_pure_chain_threads_payload_charges_budget_writes_jsonl(tmp_path):
    g = WorkflowGuard()
    ctx = _ctx(tmp_path)
    graph = {
        "nodes": [
            {"id": "t", "kind": "manual-trigger", "config": {"payload": {"a": 1}}},
            {"id": "s", "kind": "set-fields", "config": {"fields": {"b": 2}}},
            {"id": "o", "kind": "output"},
        ],
        "edges": [{"from": "t", "to": "s"}, {"from": "s", "to": "o"}],
    }
    res = run_graph(graph, ctx, g)
    assert res["status"] == "completed"
    assert res["outputs"]["s"] == {"a": 1, "b": 2}
    assert res["outputs"]["o"] == {"a": 1, "b": 2}
    assert ctx.budget.steps == 3                      # EVERY node dispatched → charged
    seqs = [e["seq"] for e in res["events"]]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)  # monotonic + unique
    log = tmp_path / ".hermes" / "workbench" / "workflows" / "runs" / "r1.jsonl"
    assert log.exists() and log.read_text(encoding="utf-8").strip()


def test_condition_routes_true_branch_only(tmp_path):
    g = WorkflowGuard()
    ctx = _ctx(tmp_path)
    graph = {
        "nodes": [
            {"id": "t", "kind": "manual-trigger", "config": {"payload": {"n": 5}}},
            {"id": "c", "kind": "condition", "config": {"leftExpr": "$n", "operator": "greater_than", "rightValue": 3}},
            {"id": "yes", "kind": "set-fields", "config": {"fields": {"branch": "yes"}}},
            {"id": "no", "kind": "set-fields", "config": {"fields": {"branch": "no"}}},
        ],
        "edges": [
            {"from": "t", "to": "c"},
            {"from": "c", "to": "yes", "label": "true"},
            {"from": "c", "to": "no", "label": "false"},
        ],
    }
    res = run_graph(graph, ctx, g)
    assert "yes" in res["outputs"] and "no" not in res["outputs"]


def test_loop_terminates_on_max_iterations(tmp_path):
    g = WorkflowGuard()
    ctx = _ctx(tmp_path, budget=Budget(max_steps=1000))
    graph = {
        "nodes": [
            {"id": "t", "kind": "manual-trigger", "config": {}},
            {"id": "l", "kind": "loop", "config": {"maxIterations": 3}},
            {"id": "b", "kind": "set-fields", "config": {"fields": {"x": 1}}},
            {"id": "d", "kind": "output"},
        ],
        "edges": [
            {"from": "t", "to": "l"},
            {"from": "l", "to": "b"},
            {"from": "b", "to": "l"},
            {"from": "l", "to": "d", "label": "done"},
        ],
    }
    res = run_graph(graph, ctx, g)
    assert res["status"] == "completed"
    assert "d" in res["outputs"]                       # reached the done branch


def test_loop_halts_on_budget_not_maxiterations(tmp_path):
    g = WorkflowGuard()
    ctx = _ctx(tmp_path, budget=Budget(max_steps=6))
    graph = {
        "nodes": [
            {"id": "t", "kind": "manual-trigger", "config": {}},
            {"id": "l", "kind": "loop", "config": {"maxIterations": 100000}},
            {"id": "b", "kind": "set-fields", "config": {"fields": {"x": 1}}},
        ],
        "edges": [{"from": "t", "to": "l"}, {"from": "l", "to": "b"}, {"from": "b", "to": "l"}],
    }
    res = run_graph(graph, ctx, g)
    assert res["status"] == "halted"                   # Budget tripped, not maxIterations


def test_dry_run_traces_whole_graph_without_executing(tmp_path):
    g = WorkflowGuard()                                # NO http-request executor registered
    ctx = _ctx(tmp_path)
    graph = {
        "nodes": [
            {"id": "t", "kind": "manual-trigger", "config": {}},
            {"id": "h", "kind": "http-request", "config": {"url": "https://x/y"}},
            {"id": "o", "kind": "output"},
        ],
        "edges": [{"from": "t", "to": "h"}, {"from": "h", "to": "o"}],
    }
    res = dry_run_graph(graph, ctx, g)
    assert res["status"] == "completed"                # did NOT halt on the side-effecting node
    assert res["outputs"]["h"].get("__dry__") and res["outputs"]["h"]["wouldRun"] is True
    assert "o" in res["outputs"]                        # traced PAST the side-effecting node


def test_side_effecting_executor_runs_when_allowed(tmp_path):
    g = WorkflowGuard()
    g.register("http-request", lambda n, c: {"fetched": True})
    ctx = _ctx(tmp_path, allow=True, http_allowlist=("x",))
    graph = {
        "nodes": [
            {"id": "t", "kind": "manual-trigger", "config": {}},
            {"id": "h", "kind": "http-request", "config": {"url": "https://x/y"}},
        ],
        "edges": [{"from": "t", "to": "h"}],
    }
    res = run_graph(graph, ctx, g)
    assert res["outputs"]["h"] == {"fetched": True}


def test_denied_side_effecting_node_halts_run(tmp_path):
    g = WorkflowGuard()
    g.register("http-request", lambda n, c: {"fetched": True})
    ctx = _ctx(tmp_path)                                # fail-closed, empty allowlist → denied
    graph = {
        "nodes": [
            {"id": "t", "kind": "manual-trigger", "config": {}},
            {"id": "h", "kind": "http-request", "config": {"url": "https://evil/y"}},
        ],
        "edges": [{"from": "t", "to": "h"}],
    }
    res = run_graph(graph, ctx, g)
    assert res["status"] == "failed"


def test_continue_on_error_skips_denied_node(tmp_path):
    g = WorkflowGuard()
    ctx = _ctx(tmp_path)
    graph = {
        "nodes": [
            {"id": "t", "kind": "manual-trigger", "config": {}},
            {"id": "h", "kind": "http-request", "config": {"url": "https://evil/y", "continueOnError": True}},
            {"id": "o", "kind": "output"},
        ],
        "edges": [{"from": "t", "to": "h"}, {"from": "h", "to": "o"}],
    }
    res = run_graph(graph, ctx, g)
    # denied http node is skipped (continueOnError) — run does not fail on it
    assert res["status"] == "completed"


def test_unknown_node_kind_halts(tmp_path):
    g = WorkflowGuard()
    ctx = _ctx(tmp_path, allow=True)
    graph = {
        "nodes": [{"id": "t", "kind": "manual-trigger", "config": {}}, {"id": "x", "kind": "mystery", "config": {}}],
        "edges": [{"from": "t", "to": "x"}],
    }
    res = run_graph(graph, ctx, g)
    assert res["status"] == "failed"
