"""config.set support for named delegation routes and route advisor settings."""

from __future__ import annotations

import yaml

import tui_gateway.server as server


def _reset_config_cache(monkeypatch) -> None:
    monkeypatch.setattr(server, "_cfg_cache", None)
    monkeypatch.setattr(server, "_cfg_mtime", None)
    monkeypatch.setattr(server, "_cfg_path", None)


def _isolated_hermes_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(server, "_hermes_home", home)
    _reset_config_cache(monkeypatch)
    return home


def _config_set(key: str, value):
    return server.handle_request(
        {
            "id": "cfg-1",
            "method": "config.set",
            "params": {"key": key, "value": value},
        }
    )


def _saved_config(home):
    return yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}


def test_config_set_delegation_routes_round_trips_nested_map_with_env_string(
    tmp_path, monkeypatch
):
    home = _isolated_hermes_home(tmp_path, monkeypatch)
    routes = {
        "coding": {
            "provider": "deepseek",
            "model": "deepseek-v4-pro",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "${DEEPSEEK_API_KEY}",
            "reasoning_effort": "max",
            "description": "implementation, refactors, tests",
            "metadata": {"nested": {"safe": True}},
        }
    }

    resp = _config_set("delegation.routes", routes)

    assert "error" not in resp
    assert resp["result"]["value"] == routes
    assert _saved_config(home)["delegation"]["routes"] == routes


def test_config_set_route_advisor_scalar_keys_round_trip(tmp_path, monkeypatch):
    home = _isolated_hermes_home(tmp_path, monkeypatch)

    for key, value in {
        "route_advisor.mode": "nudge",
        "route_advisor.min_level": "complex",
        "route_advisor.cooldown_turns": 7,
        "route_advisor.log_signals": False,
    }.items():
        resp = _config_set(key, value)
        assert "error" not in resp
        assert resp["result"] == {"key": key, "value": value}

    assert _saved_config(home)["route_advisor"] == {
        "mode": "nudge",
        "min_level": "complex",
        "cooldown_turns": 7,
        "log_signals": False,
    }


def test_config_set_route_advisor_rejects_non_scalar_values(tmp_path, monkeypatch):
    _isolated_hermes_home(tmp_path, monkeypatch)

    resp = _config_set("route_advisor.mode", {"bad": "shape"})

    assert resp["error"]["code"] == 4002
    assert "must be a scalar" in resp["error"]["message"]
