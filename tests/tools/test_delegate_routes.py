"""Behavior tests for named delegate_task routes."""

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# tools.delegate_tool imports environment modules that call get_hermes_home()
# during collection. Under scripts/run_tests.sh's clean env on Windows,
# Path.home() can be unavailable until fixtures run, so seed an isolated home
# before importing the tool module.
os.environ.setdefault(
    "HERMES_HOME",
    str(Path(tempfile.gettempdir()) / "hermes-test-delegate-routes"),
)

import tools.delegate_tool as dt


class _Parent:
    base_url = "https://openrouter.ai/api/v1"
    api_key = "parent-key"
    provider = "openrouter"
    api_mode = "chat_completions"
    model = "parent-model"
    platform = "cli"
    providers_allowed = None
    providers_ignored = None
    providers_order = None
    provider_sort = None
    provider_require_parameters = False
    provider_data_collection = None
    openrouter_min_coding_score = None
    max_tokens = None
    prefill_messages = None
    fallback_model = None
    enabled_toolsets = ["terminal"]
    valid_tool_names = []
    _session_db = None
    _delegate_depth = 0
    _active_children = []
    _active_children_lock = None
    _print_fn = None
    tool_progress_callback = None
    thinking_callback = None
    session_id = "parent-session"
    reasoning_config = {"effort": "parent"}
    request_overrides = {}


def _parent():
    return _Parent()


def test_resolve_route_merges_sparse_block_and_strips_metadata(monkeypatch):
    captured = {}

    def fake_base_resolver(cfg, parent_agent):
        captured.update(cfg)
        return {"model": cfg.get("model"), "provider": cfg.get("provider"), "base_url": None, "api_key": None, "api_mode": None}

    monkeypatch.setattr(dt, "_resolve_delegation_credentials", fake_base_resolver)
    cfg = {
        "provider": "openrouter",
        "model": "base-model",
        "reasoning_effort": "medium",
        "routes": {
            "coding": {
                "model": "route-model",
                "description": "implementation work",
                "unknown_setting": "ignored",
            }
        },
    }

    creds = dt._resolve_route_credentials(cfg, "coding", _parent())

    assert creds["model"] == "route-model"
    assert creds["provider"] == "openrouter"
    assert creds["route"] == "coding"
    assert creds["reasoning_effort"] == "medium"
    assert "routes" not in captured
    assert "description" not in captured
    assert "unknown_setting" not in captured


def test_route_provider_without_base_url_drops_inherited_direct_endpoint_credentials(monkeypatch):
    """R1-B1: provider-only routes must not leak base endpoint credentials."""
    calls = []

    def fake_runtime_provider(*, requested, target_model):
        calls.append((requested, target_model))
        return {
            "provider": "custom",
            "model": target_model,
            "base_url": "https://api.kimi.com/coding/v1",
            "api_key": "kimi-key",
            "api_mode": "anthropic_messages",
        }

    monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider", fake_runtime_provider)
    cfg = {
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "${DEEPSEEK_API_KEY}",
        "api_mode": "chat_completions",
        "provider": "deepseek",
        "model": "deepseek-v4-pro",
        "routes": {
            "review": {
                "provider": "kimi-coding",
                "model": "kimi-k3",
            }
        },
    }

    creds = dt._resolve_route_credentials(cfg, "review", _parent())

    assert calls == [("kimi-coding", "kimi-k3")]
    assert creds["provider"] == "kimi-coding"
    assert creds["base_url"] == "https://api.kimi.com/coding/v1"
    assert creds["api_key"] == "kimi-key"
    assert creds["api_mode"] == "anthropic_messages"
    assert creds["route"] == "review"


def test_unknown_route_fails_open_with_base_credentials_and_warning(caplog):
    parent = _parent()
    cfg = {
        "model": "base-model",
        "provider": "",
        "routes": {"coding": {"model": "route-model"}},
    }

    base = dt._resolve_route_credentials(cfg, None, parent)
    unknown = dt._resolve_route_credentials(cfg, "missing", parent)

    assert unknown == base
    assert unknown["route"] is None
    assert "unknown route 'missing'" in caplog.text


def test_known_route_with_bad_credentials_surfaces_valueerror(monkeypatch):
    def fake_runtime_provider(*, requested, target_model):
        return {
            "provider": requested,
            "model": target_model,
            "base_url": "https://bad.example/v1",
            "api_key": "",
            "api_mode": "chat_completions",
        }

    monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider", fake_runtime_provider)
    cfg = {"routes": {"bad": {"provider": "openrouter", "model": "broken-model"}}}
    monkeypatch.setattr(dt, "_load_config", lambda: cfg)

    result = json.loads(dt.delegate_task(goal="x", route="bad", parent_agent=_parent()))

    assert "error" in result
    assert "no API key" in result["error"]


def test_empty_routes_schema_has_no_route_property(monkeypatch):
    monkeypatch.setattr(dt, "_load_config", lambda: {"routes": {}})

    params = dt._build_dynamic_schema_overrides()["parameters"]

    assert "route" not in params["properties"]
    assert "route" not in params["properties"]["tasks"]["items"]["properties"]


def test_nonempty_routes_schema_adds_top_level_and_per_task_route_enum(monkeypatch):
    monkeypatch.setattr(dt, "_load_config", lambda: {
        "routes": {
            "coding": {"provider": "deepseek", "model": "deepseek-v4-pro", "description": "implementation"},
            "review": {"provider": "kimi-coding", "model": "kimi-k3", "description": "adversarial review"},
        }
    })

    params = dt._build_dynamic_schema_overrides()["parameters"]
    top_route = params["properties"]["route"]
    task_route = params["properties"]["tasks"]["items"]["properties"]["route"]

    assert top_route["enum"] == ["coding", "review"]
    assert task_route["enum"] == ["coding", "review"]
    assert "coding" in top_route["description"]
    assert "deepseek-v4-pro" in top_route["description"]
    assert "review" in top_route["description"]


def test_per_task_route_overrides_top_level_and_reasoning_effort_reaches_child(monkeypatch):
    calls = []
    children = [MagicMock(_delegate_role="leaf"), MagicMock(_delegate_role="leaf")]

    monkeypatch.setattr(dt, "_load_config", lambda: {
        "max_iterations": 50,
        "max_concurrent_children": 3,
        "routes": {
            "coding": {"model": "coding-model", "provider": ""},
            "review": {"model": "review-model", "provider": "", "reasoning_effort": "max"},
        },
    })

    def fake_build_child_agent(**kwargs):
        calls.append(kwargs)
        return children[len(calls) - 1]

    monkeypatch.setattr(dt, "_build_child_agent", fake_build_child_agent)
    monkeypatch.setattr(dt, "_run_single_child", lambda task_index, goal, child, parent_agent: {
        "task_index": task_index,
        "status": "completed",
        "summary": goal,
        "api_calls": 0,
        "duration_seconds": 0,
    })

    result = json.loads(dt.delegate_task(
        route="coding",
        tasks=[{"goal": "impl"}, {"goal": "review", "route": "review"}],
        parent_agent=_parent(),
    ))

    assert [call["model"] for call in calls] == ["coding-model", "review-model"]
    assert calls[0]["override_reasoning_effort"] is None
    assert calls[1]["override_reasoning_effort"] == "max"
    assert [entry["route"] for entry in result["results"]] == ["coding", "review"]


def test_background_dispatch_builds_children_with_same_route_credentials_as_sync(monkeypatch):
    cfg = {
        "max_iterations": 50,
        "max_concurrent_children": 3,
        "routes": {"coding": {"model": "coding-model", "provider": "", "reasoning_effort": "high"}},
    }
    monkeypatch.setattr(dt, "_load_config", lambda: cfg)
    monkeypatch.setattr("gateway.session_context.async_delivery_supported", lambda: True)

    sync_calls = []
    async_calls = []

    def fake_build_sync(**kwargs):
        sync_calls.append(kwargs)
        return MagicMock(_delegate_role="leaf")

    def fake_build_async(**kwargs):
        async_calls.append(kwargs)
        return MagicMock(_delegate_role="leaf")

    monkeypatch.setattr(dt, "_run_single_child", lambda task_index, goal, child, parent_agent: {
        "task_index": task_index,
        "status": "completed",
        "summary": goal,
        "api_calls": 0,
        "duration_seconds": 0,
    })

    monkeypatch.setattr(dt, "_build_child_agent", fake_build_sync)
    dt.delegate_task(goal="impl", route="coding", parent_agent=_parent())

    dispatch_kwargs = {}
    def fake_dispatch_async_delegation_batch(**kwargs):
        dispatch_kwargs.update(kwargs)
        return {"status": "dispatched", "delegation_id": "deleg_test"}

    monkeypatch.setattr(dt, "_build_child_agent", fake_build_async)
    monkeypatch.setattr("tools.async_delegation.dispatch_async_delegation_batch", fake_dispatch_async_delegation_batch)
    dt.delegate_task(goal="impl", route="coding", background=True, parent_agent=_parent())

    keys = ["model", "override_provider", "override_base_url", "override_api_key", "override_api_mode", "override_reasoning_effort"]
    assert [{k: c[k] for k in keys} for c in async_calls] == [{k: c[k] for k in keys} for c in sync_calls]
    assert dispatch_kwargs["route"] == "coding"


def test_config_validation_rejects_reserved_route_names():
    from hermes_cli.config import validate_config_structure

    issues = validate_config_structure({
        "delegation": {
            "routes": {
                "default": {"model": "x"},
                "coding": {"model": "y"},
            }
        }
    })

    messages = "\n".join(issue.message for issue in issues)
    assert "delegation.routes.default" in messages
    assert "reserved" in messages


def test_config_validation_rejects_invalid_route_names():
    from hermes_cli.config import validate_config_structure

    issues = validate_config_structure({
        "delegation": {
            "routes": {
                "Bad Name": {"model": "x"},
                "review": {"model": "y"},
            }
        }
    })

    messages = "\n".join(issue.message for issue in issues)
    assert "delegation.routes.Bad Name" in messages
    assert "invalid route name" in messages
