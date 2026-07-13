"""WF0 safety-spine tests (spec 12b §0.0): guard-as-dispatcher, budget, approval."""

import pytest

from tui_gateway.workflow_guard import (
    AllowlistSink,
    ApprovalDecision,
    ApprovalSink,
    Budget,
    FailClosedSink,
    RunContext,
    WorkflowGuard,
    WorkflowGuardDenied,
    WorkflowHalted,
)


class _AllowSink(ApprovalSink):
    def request(self, run_ctx, node_kind, detail):
        return ApprovalDecision.ALLOW


def _ctx(sink=None, budget=None, http_allowlist=(), allow_code_node=False, origin="cron"):
    return RunContext(
        run_id="r1", workflow_id="wf1", workspace_root="/ws", origin=origin,
        approval_sink=sink or FailClosedSink(), budget=budget or Budget(),
        http_allowlist=http_allowlist, allow_code_node=allow_code_node,
    )


# --- Budget ---------------------------------------------------------------------

def test_budget_halts_past_max_steps():
    b = Budget(max_steps=3)
    for _ in range(3):
        b.charge()
    with pytest.raises(WorkflowHalted):
        b.charge()
    assert b.steps == 4


# --- Approval sinks -------------------------------------------------------------

def test_fail_closed_sink_denies_and_notifies():
    seen = []
    sink = FailClosedSink(notify=seen.append)
    assert sink.request(_ctx(), "http-request", "x") == ApprovalDecision.DENY
    assert seen and "needs approval" in seen[0]


def test_allowlist_sink_allows_listed_defers_rest():
    sink = AllowlistSink({"http-request"}, fallback=FailClosedSink())
    assert sink.request(_ctx(), "http-request", "x") == ApprovalDecision.ALLOW
    assert sink.request(_ctx(), "code", "x") == ApprovalDecision.DENY


# --- Guard policy + dispatch ----------------------------------------------------

def test_pure_node_allowed_charges_budget_no_executor():
    g = WorkflowGuard()
    ctx = _ctx()
    assert g.dispatch({"kind": "set-fields"}, ctx) is None
    assert ctx.budget.steps == 1


def test_http_allowlisted_host_passes_without_approval():
    g = WorkflowGuard()
    # fail-closed sink would deny; allowlist must let it through without asking.
    ctx = _ctx(sink=FailClosedSink(), http_allowlist=("api.example.com",))
    hits = []
    g.register("http-request", lambda node, c: hits.append(node) or {"ok": True})
    out = g.dispatch({"kind": "http-request", "config": {"url": "https://api.example.com/x"}}, ctx)
    assert out == {"ok": True} and len(hits) == 1


def test_http_non_allowlisted_host_denied_under_fail_closed():
    g = WorkflowGuard()
    ctx = _ctx(sink=FailClosedSink())  # empty allowlist
    called = []
    g.register("http-request", lambda node, c: called.append(1))
    with pytest.raises(WorkflowGuardDenied):
        g.dispatch({"kind": "http-request", "config": {"url": "https://evil.test/x"}}, ctx)
    assert called == []  # inescapability: executor NEVER ran on a denied node


def test_code_node_gated_by_config():
    g = WorkflowGuard()
    g.register("code", lambda node, c: "ran")
    with pytest.raises(WorkflowGuardDenied):
        g.dispatch({"kind": "code"}, _ctx(sink=FailClosedSink(), allow_code_node=False))
    assert g.dispatch({"kind": "code"}, _ctx(sink=FailClosedSink(), allow_code_node=True)) == "ran"


def test_ai_agent_node_is_approval_gated():
    g = WorkflowGuard()
    g.register("ai-agent", lambda node, c: "delegated")
    # fail-closed → denied; allow-sink → runs
    with pytest.raises(WorkflowGuardDenied):
        g.dispatch({"kind": "ai-agent"}, _ctx(sink=FailClosedSink()))
    assert g.dispatch({"kind": "ai-agent"}, _ctx(sink=_AllowSink())) == "delegated"


def test_unknown_kind_denied():
    g = WorkflowGuard()
    with pytest.raises(WorkflowGuardDenied) as ei:
        g.dispatch({"kind": "totally-new-node"}, _ctx(sink=_AllowSink()))
    assert "unknown node kind" in ei.value.reason


def test_side_effecting_kind_with_no_executor_cannot_run():
    g = WorkflowGuard()  # approved by policy but nothing registered
    with pytest.raises(WorkflowGuardDenied) as ei:
        g.dispatch({"kind": "generate-image"}, _ctx(sink=_AllowSink()))
    assert "no executor registered" in ei.value.reason


def test_budget_shared_across_dispatches_bounds_reentry():
    g = WorkflowGuard()
    b = Budget(max_steps=2)
    ctx = _ctx(sink=_AllowSink(), budget=b)
    g.dispatch({"kind": "output"}, ctx)
    g.dispatch({"kind": "output"}, ctx)
    with pytest.raises(WorkflowHalted):
        g.dispatch({"kind": "output"}, ctx)  # 3rd node trips the shared budget


# --- WF0-r2: R1 child-threading seam + structural inescapability -----------------

def test_executors_registry_is_private_inescapability():
    g = WorkflowGuard()
    g.register("code", lambda n, c: "x")
    # Name-mangled: no public `_executors` handle to invoke an executor directly.
    assert not hasattr(g, "_executors")


def test_tool_policy_charges_budget_and_gates_child_egress():
    g = WorkflowGuard()
    b = Budget(max_steps=10)
    ctx = _ctx(sink=FailClosedSink(), budget=b, http_allowlist=("api.example.com",))
    assert g.tool_policy("web_extract_tool", {"url": "https://api.example.com/x"}, ctx).allowed
    assert b.steps == 1  # a child tool call costs budget
    assert not g.tool_policy("web_extract_tool", {"url": "https://evil.test/x"}, ctx).allowed


def test_tool_policy_gates_child_write_and_shell():
    g = WorkflowGuard()
    denied = _ctx(sink=FailClosedSink())
    assert not g.tool_policy("write_file", {"path": "x"}, denied).allowed
    assert not g.tool_policy("terminal", {"command": "ls"}, denied).allowed
    ok = _ctx(sink=_AllowSink())
    assert g.tool_policy("write_file", {"path": "x"}, ok).allowed
    assert g.tool_policy("terminal", {"command": "ls"}, ok).allowed


def test_tool_policy_allows_readonly_child_tool():
    g = WorkflowGuard()
    assert g.tool_policy("read_file", {"path": "x"}, _ctx(sink=FailClosedSink())).allowed


def test_derive_child_shares_budget_and_sink():
    parent = _ctx(sink=FailClosedSink(), budget=Budget(max_steps=5))
    child = parent.derive_child()
    assert child.budget is parent.budget            # same instance → shared bound (R1/R3)
    assert child.approval_sink is parent.approval_sink
    assert child.http_allowlist == parent.http_allowlist
