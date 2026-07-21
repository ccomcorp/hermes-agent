"""Config coverage for classifier-backed Kanban complexity routing."""

from __future__ import annotations

from hermes_cli.config import (
    DEFAULT_CONFIG,
    load_config,
    save_config,
    validate_config_structure,
)


EXPECTED_CLASSIFIER_ROUTING_DEFAULTS = {
    "mode": "classifier",
    "min_confidence": 0.5,
    "classifier_timeout_s": 10,
    "classifier_tick_budget_s": 30,
    "classifier_consecutive_failure_limit": 3,
}


def test_classifier_routing_keys_present_in_defaults():
    routing = DEFAULT_CONFIG["kanban"]["complexity_routing"]

    for key, expected in EXPECTED_CLASSIFIER_ROUTING_DEFAULTS.items():
        assert routing[key] == expected


def test_classifier_routing_defaults_round_trip_through_load_save(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    cfg = load_config()
    save_config(cfg)
    reloaded = load_config()

    routing = reloaded["kanban"]["complexity_routing"]
    for key, expected in EXPECTED_CLASSIFIER_ROUTING_DEFAULTS.items():
        assert routing[key] == expected


def test_dispatch_classifier_auxiliary_task_resolves(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    from agent.auxiliary_client import _get_auxiliary_task_config

    task_cfg = _get_auxiliary_task_config("dispatch_classifier")
    decomposer_cfg = DEFAULT_CONFIG["auxiliary"]["kanban_decomposer"]

    assert task_cfg == DEFAULT_CONFIG["auxiliary"]["dispatch_classifier"]
    assert task_cfg == decomposer_cfg


def test_classifier_routing_validation_rejects_bad_mode():
    issues = validate_config_structure({
        "kanban": {
            "complexity_routing": {
                "mode": "unsupported",
            },
        },
    })

    assert any(
        issue.severity == "error"
        and "kanban.complexity_routing.mode" in issue.message
        for issue in issues
    )


def test_classifier_routing_validation_rejects_out_of_range_min_confidence():
    for value in (-0.1, 1.1):
        issues = validate_config_structure({
            "kanban": {
                "complexity_routing": {
                    "min_confidence": value,
                },
            },
        })

        assert any(
            issue.severity == "error"
            and "kanban.complexity_routing.min_confidence" in issue.message
            for issue in issues
        ), f"expected validation error for min_confidence={value!r}"
