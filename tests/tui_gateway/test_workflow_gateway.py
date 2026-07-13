"""WF2 gateway-seam tests: workflow.run / workflow.dryRun registered on the real
JSON-RPC method registry (spec 13). Drives the handlers exactly as handle_request
would, without a live session or agent."""

import pytest

server = pytest.importorskip("tui_gateway.server")


_PURE = {
    "nodes": [
        {"id": "t", "kind": "manual-trigger", "config": {"payload": {"a": 1}}},
        {"id": "o", "kind": "output"},
    ],
    "edges": [{"from": "t", "to": "o"}],
}

_WITH_HTTP = {
    "nodes": [
        {"id": "t", "kind": "manual-trigger", "config": {"payload": {"a": 1}}},
        {"id": "h", "kind": "http-request", "config": {"url": "https://x/y"}},
    ],
    "edges": [{"from": "t", "to": "h"}],
}


def test_methods_are_registered():
    assert "workflow.run" in server._methods
    assert "workflow.dryRun" in server._methods


def test_dry_run_traces_side_effecting_without_executing():
    r = server._methods["workflow.dryRun"]("rid", {"graph": _WITH_HTTP})
    res = r["result"]
    assert res["status"] == "completed"
    assert res["outputs"]["h"].get("wouldRun") is True


def test_run_pure_graph_completes():
    r = server._methods["workflow.run"]("rid", {"graph": _PURE})
    res = r["result"]
    assert res["status"] == "completed" and res["outputs"]["o"] == {"a": 1}


def test_run_unapproved_side_effecting_node_fails_closed():
    r = server._methods["workflow.run"]("rid", {"graph": _WITH_HTTP})
    assert r["result"]["status"] == "failed"  # http not in approved_kinds, no allowlist


def test_run_missing_graph_returns_error():
    r = server._methods["workflow.run"]("rid", {})
    assert r["error"]["code"] == 4041


def test_dry_run_missing_graph_returns_error():
    r = server._methods["workflow.dryRun"]("rid", {})
    assert r["error"]["code"] == 4040
