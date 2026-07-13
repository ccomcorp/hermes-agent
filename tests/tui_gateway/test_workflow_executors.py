"""WF3 — executor tests (spec 13). Focus: R1 closure by toolset restriction,
fail-closed on non-interactive origin, injectable backends, engine integration."""

import pytest

import inspect

from tui_gateway.workflow_executors import (
    AI_NODE_ALLOWED_TOOLSETS,
    ExecutorError,
    ai_agent_executor,
    code_executor,
    http_executor,
    register_executors,
)
from tui_gateway.workflow_guard import (
    ApprovalDecision,
    ApprovalSink,
    Budget,
    FailClosedSink,
    RunContext,
    WorkflowGuard,
)
from tui_gateway.workflow_runtime import run_graph


class _AllowSink(ApprovalSink):
    def request(self, run_ctx, node_kind, detail):
        return ApprovalDecision.ALLOW


def _ctx(origin="manual", headless_agent=None, allow=True, http_allowlist=(), allow_code_node=False):
    return RunContext(
        run_id="r1", workflow_id="wf1", workspace_root="", origin=origin,
        approval_sink=_AllowSink() if allow else FailClosedSink(), budget=Budget(max_steps=100),
        http_allowlist=http_allowlist, allow_code_node=allow_code_node, headless_agent=headless_agent,
    )


# --- ai-agent: R1 closure by RESTRICTION -----------------------------------------

def test_ai_agent_child_gets_restricted_toolset_R1():
    seen = {}

    def fake_delegate(*, prompt, agent, allowed_toolsets, run_ctx):
        seen["allowed"] = allowed_toolsets
        seen["prompt"] = prompt
        return "child reply"

    out = ai_agent_executor({"config": {"prompt": "summarize"}}, _ctx(), delegate_fn=fake_delegate)
    assert out == {"text": "child reply"}
    # R1 by allowlist: the child may ONLY have the 'safe' (empty) toolset — no
    # side-effecting toolset is granted, so it cannot egress/write/shell/run code.
    assert seen["allowed"] == ["safe"]
    assert list(AI_NODE_ALLOWED_TOOLSETS) == ["safe"]
    for dangerous in ("web", "file", "terminal", "code_execution"):
        assert dangerous not in seen["allowed"]


def test_default_adapters_match_live_chassis_signatures():
    """Signature-lock: fails if delegate_task / web_extract_tool / execute_code drift
    from what the default adapters call (the live-verification this task performed)."""
    from tools.code_execution_tool import execute_code
    from tools.delegate_tool import delegate_task
    from tools.web_tools import web_extract_tool

    dp = inspect.signature(delegate_task).parameters
    assert "tasks" in dp and "parent_agent" in dp   # batch form + parent required
    assert "task" not in dp and "blocked_toolsets" not in dp  # the old wrong guess

    wp = inspect.signature(web_extract_tool).parameters
    assert "urls" in wp
    assert inspect.iscoroutinefunction(web_extract_tool)  # adapter awaits it

    cp = inspect.signature(execute_code).parameters
    assert "code" in cp

    # The 'safe' allowlist really is an empty (zero-tool) toolset.
    from toolsets import TOOLSETS
    safe = TOOLSETS.get("safe")
    safe_tools = safe.get("tools") if isinstance(safe, dict) else getattr(safe, "tools", safe)
    assert safe_tools == []


def test_ai_agent_fail_closed_when_no_agent_for_noninteractive_origin_F5():
    # cron/webhook origin with NO headless_agent -> denied, never crashes.
    out = ai_agent_executor({"config": {"prompt": "x"}}, _ctx(origin="cron", headless_agent=None),
                            delegate_fn=lambda **k: "should not run")
    assert out.get("__denied__") is True and "cron" in out["reason"]


def test_ai_agent_uses_headless_agent_for_cron_origin():
    called = {}

    def fake_delegate(*, prompt, agent, allowed_toolsets, run_ctx):
        called["agent"] = agent
        return "ok"

    sentinel = object()
    out = ai_agent_executor({"config": {"prompt": "x"}},
                            _ctx(origin="cron", headless_agent=sentinel), delegate_fn=fake_delegate)
    assert out == {"text": "ok"} and called["agent"] is sentinel


def test_ai_agent_requires_prompt():
    with pytest.raises(ExecutorError):
        ai_agent_executor({"config": {}}, _ctx(), delegate_fn=lambda **k: "x")


# --- http / code: injectable backends --------------------------------------------

def test_http_executor_calls_injected_fetch():
    def fake_fetch(*, url, method, headers, body):
        return {"url": url, "method": method}

    out = http_executor({"config": {"url": "https://x/y", "method": "post"}}, _ctx(), fetch_fn=fake_fetch)
    assert out == {"url": "https://x/y", "method": "POST"}


def test_http_executor_requires_url():
    with pytest.raises(ExecutorError):
        http_executor({"config": {}}, _ctx(), fetch_fn=lambda **k: {})


def test_code_executor_calls_injected_exec():
    out = code_executor({"config": {"code": "print(1)"}}, _ctx(), exec_fn=lambda **k: {"result": "1"})
    assert out == {"result": "1"}


def test_code_executor_requires_code():
    with pytest.raises(ExecutorError):
        code_executor({"config": {}}, _ctx(), exec_fn=lambda **k: {})


# --- integration: register + run through the WF2 engine, gated by the guard -------

def test_register_and_run_ai_agent_node_end_to_end():
    g = WorkflowGuard()
    register_executors(g, delegate_fn=lambda **k: "delegated-result")
    ctx = _ctx()  # manual origin, allow sink
    graph = {
        "nodes": [
            {"id": "t", "kind": "manual-trigger", "config": {}},
            {"id": "a", "kind": "ai-agent", "config": {"prompt": "do it"}},
        ],
        "edges": [{"from": "t", "to": "a"}],
    }
    res = run_graph(graph, ctx, g)
    assert res["status"] == "completed"
    assert res["outputs"]["a"] == {"text": "delegated-result"}


def test_http_node_denied_by_guard_before_executor_runs():
    # http-request node is policy-gated at dispatch: non-allowlisted host + fail-closed
    # => the executor's fetch_fn must NEVER be called.
    g = WorkflowGuard()
    hit = []
    register_executors(g, fetch_fn=lambda **k: hit.append(1) or {"x": 1})
    ctx = RunContext(
        run_id="r1", workflow_id="wf1", workspace_root="", origin="manual",
        approval_sink=FailClosedSink(), budget=Budget(max_steps=100), http_allowlist=(),
    )
    graph = {
        "nodes": [
            {"id": "t", "kind": "manual-trigger", "config": {}},
            {"id": "h", "kind": "http-request", "config": {"url": "https://evil/y"}},
        ],
        "edges": [{"from": "t", "to": "h"}],
    }
    res = run_graph(graph, ctx, g)
    assert res["status"] == "failed" and hit == []  # inescapability: fetch never ran
