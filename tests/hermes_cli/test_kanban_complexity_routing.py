from __future__ import annotations

import builtins
import json
from types import SimpleNamespace

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli.config import DEFAULT_CONFIG, validate_config_structure


def test_default_config_declares_complexity_routing_disabled():
    routing = DEFAULT_CONFIG["kanban"]["complexity_routing"]
    assert routing["enabled"] is False
    assert routing["mode"] == "classifier"
    assert routing["trigger_assignee"] == "auto"
    assert routing["fallback"] == "advisor"
    assert routing["map"]["complex"] == "advisor"


def test_config_validation_accepts_and_rejects_complexity_routing_shapes():
    valid_issues = validate_config_structure({
        "kanban": {
            "complexity_routing": {
                "enabled": True,
                "mode": "classifier",
                "trigger_assignee": "auto",
                "min_confidence": 0.5,
                "min_signal_floor": 0.2,
                "classifier_timeout_s": 10,
                "classifier_tick_budget_s": 30,
                "classifier_consecutive_failure_limit": 3,
                "map": {"simple": "dev-agent", "complex": "advisor"},
                "fallback": "advisor",
            }
        }
    })
    assert not [issue for issue in valid_issues if issue.severity == "error"]

    invalid_issues = validate_config_structure({
        "kanban": {
            "complexity_routing": {
                "enabled": "yes",
                "mode": "unsupported",
                "trigger_assignee": "",
                "min_confidence": 1.1,
                "min_signal_floor": -1,
                "classifier_timeout_s": 0,
                "classifier_tick_budget_s": 0,
                "classifier_consecutive_failure_limit": -1,
                "map": {"impossible": ""},
                "fallback": "",
            }
        }
    })
    messages = "\n".join(issue.message for issue in invalid_issues)
    assert "enabled" in messages
    assert "mode" in messages
    assert "trigger_assignee" in messages
    assert "min_confidence" in messages
    assert "min_signal_floor" in messages
    assert "classifier_timeout_s" in messages
    assert "classifier_tick_budget_s" in messages
    assert "classifier_consecutive_failure_limit" in messages
    assert "unknown level" in messages
    assert "fallback" in messages


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_CRASH_GRACE_SECONDS", "0")
    monkeypatch.setattr(kb.Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


@pytest.fixture
def routing_cfg(monkeypatch):
    def _apply(
        *,
        enabled: bool = True,
        mode: str = "classifier",
        fallback: str = "advisor",
        route_map: dict[str, str] | None = None,
        min_confidence: float = 0.5,
        timeout_s: float = 10,
        tick_budget_s: float = 30,
        failure_limit: int = 3,
        floor: float = 0.2,
    ):
        block = {
            "enabled": enabled,
            "mode": mode,
            "trigger_assignee": "auto",
            "min_confidence": min_confidence,
            "min_signal_floor": floor,
            "classifier_timeout_s": timeout_s,
            "classifier_tick_budget_s": tick_budget_s,
            "classifier_consecutive_failure_limit": failure_limit,
            "map": route_map or {
                "trivial": "ponytail",
                "simple": "dev-agent",
                "moderate": "dev-agent",
                "complex": "advisor",
                "expert": "advisor",
            },
            "fallback": fallback,
        }
        import hermes_cli.config as config_mod

        monkeypatch.setattr(config_mod, "load_config", lambda: {"kanban": {"complexity_routing": block}})
        return block

    return _apply


@pytest.fixture
def profile_set(monkeypatch):
    def _apply(names: set[str]):
        from hermes_cli import profiles

        monkeypatch.setattr(profiles, "profile_exists", lambda name: str(name) in names)

    return _apply


class _FakeAuxClient:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls: list[dict] = []
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self._create)
        )

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("unexpected classifier call")
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        if isinstance(response, dict):
            response = json.dumps(response)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=response))]
        )


def _install_aux(monkeypatch: pytest.MonkeyPatch, *responses, model: str = "classifier-model") -> _FakeAuxClient:
    import agent.auxiliary_client as aux

    client = _FakeAuxClient(*responses)
    monkeypatch.setattr(aux, "get_text_auxiliary_client", lambda task: (client, model))
    monkeypatch.setattr(aux, "get_auxiliary_extra_body", lambda: None, raising=False)
    return client


def _capture_spawn(captured: list[tuple[str, str | None]]):
    def spawn(task, _workspace):
        captured.append((task.assignee or "", task.model_override))
        return 12345

    return spawn


def test_enabled_false_leaves_auto_unrouted_and_does_not_import_classifier(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg(enabled=False)
    profile_set({"dev-agent", "advisor"})
    conn = kb.connect()
    original_import = builtins.__import__
    imported: list[str] = []

    def guard_import(name, *args, **kwargs):
        if name == "agent.auxiliary_client" or name == "plugins.route_advisor.signals":
            imported.append(name)
            raise AssertionError("classifier imports must be gated behind enabled=true")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guard_import)
    try:
        tid = kb.create_task(conn, title="Implement router", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=lambda *_: 12345)
        assert result.spawned == []
        assert tid in result.skipped_nonspawnable
        assert kb.get_task(conn, tid).assignee == "auto"
        assert imported == []
    finally:
        conn.close()


def test_classifier_json_routes_to_profile_and_rewrites_assignee_before_spawn_gate(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(
        monkeypatch,
        {"tier": "complex", "profile": "advisor", "confidence": 0.92, "rationale": "cross-system work"},
    )
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(
            conn,
            title="Implement the distributed tracing integration",
            body="Touch backend dispatcher code and tests.",
            assignee="auto",
        )
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.skipped_nonspawnable == []
        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", None)]
        assert kb.get_task(conn, tid).assignee == "advisor"
        assert len(client.calls) == 1
        request = client.calls[0]
        assert request["model"] == "classifier-model"
        assert request["temperature"] == 0
        assert request["timeout"] == 10
        prompt = request["messages"][1]["content"]
        assert "distributed tracing" in prompt
        assert "Touch backend dispatcher code" in prompt
        assert "advisor" in prompt
    finally:
        conn.close()


def test_low_confidence_routes_to_fallback_not_trivial(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    _install_aux(
        monkeypatch,
        {"tier": "trivial", "profile": "ponytail", "confidence": 0.1, "rationale": "too unsure"},
    )
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Fix login", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", None)]
        assert kb.get_task(conn, tid).assignee == "advisor"
    finally:
        conn.close()


def test_real_assignee_card_is_untouched_and_classifier_not_called(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(monkeypatch)
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Implement complex work", assignee="dev-agent")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("dev-agent", None)]
        assert kb.get_task(conn, tid).assignee == "dev-agent"
        assert client.calls == []
    finally:
        conn.close()


def test_malformed_classifier_json_routes_to_fallback(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(monkeypatch, "not json")
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Ambiguous card", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", None)]
        assert kb.get_task(conn, tid).assignee == "advisor"
        assert len(client.calls) == 1
    finally:
        conn.close()


def test_auto_never_survives_to_spawn(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg(route_map={"trivial": "ponytail", "simple": "dev-agent", "moderate": "dev-agent", "complex": "dev-agent", "expert": "advisor"})
    profile_set({"dev-agent", "advisor", "ponytail"})
    _install_aux(
        monkeypatch,
        {"tier": "simple", "profile": "auto", "confidence": 0.9, "rationale": "invalid profile sentinel"},
    )
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        kb.create_task(conn, title="Modify config", assignee="auto")
        kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))
        assert spawned_profiles == [("dev-agent", None)]
        assert all(profile != "auto" for profile, _model in spawned_profiles)
    finally:
        conn.close()


def test_tier_only_mode_does_not_call_auxiliary_classifier(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg(mode="tier-only")
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(monkeypatch)
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Any auto card", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", None)]
        assert client.calls == []
    finally:
        conn.close()


def test_classifier_cache_hits_for_matching_title_and_body_in_same_tick(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(
        monkeypatch,
        {"tier": "complex", "profile": "advisor", "confidence": 0.9, "rationale": "same card"},
    )
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        kb.create_task(conn, title="Same work", body="Same body", assignee="auto")
        kb.create_task(conn, title="Same work", body="Same body", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert len(result.spawned) == 2
        assert spawned_profiles == [("advisor", None), ("advisor", None)]
        assert len(client.calls) == 1
        cache_rows = conn.execute("SELECT result FROM classifier_cache").fetchall()
        assert len(cache_rows) == 1
    finally:
        conn.close()


def test_classifier_failure_breaker_falls_back_without_more_aux_calls(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg(failure_limit=1)
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(monkeypatch, RuntimeError("classifier down"))
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        kb.create_task(conn, title="First card", assignee="auto")
        kb.create_task(conn, title="Second card", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert len(result.spawned) == 2
        assert spawned_profiles == [("advisor", None), ("advisor", None)]
        assert len(client.calls) == 1
    finally:
        conn.close()


def test_classifier_tick_budget_falls_back_without_aux_call(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg(tick_budget_s=1)
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(monkeypatch)
    times = iter([100.0, 102.0])
    monkeypatch.setattr(kb.time, "monotonic", lambda: next(times))
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Budget exhausted", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", None)]
        assert client.calls == []
    finally:
        conn.close()


def test_classifier_model_field_sets_task_model_override_for_spawn(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    _install_aux(
        monkeypatch,
        {
            "tier": "expert",
            "profile": "advisor",
            "confidence": 0.95,
            "rationale": "needs stronger model",
            "model": "openai/gpt-5.5",
        },
    )
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Hard card", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", "openai/gpt-5.5")]
        assert kb.get_task(conn, tid).model_override == "openai/gpt-5.5"
    finally:
        conn.close()


def test_existing_task_model_override_wins_over_classifier_model(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    _install_aux(
        monkeypatch,
        {
            "tier": "expert",
            "profile": "advisor",
            "confidence": 0.95,
            "rationale": "classifier suggests a stronger model",
            "model": "openai/gpt-5.5",
        },
    )
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Pinned hard card", assignee="auto")
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET model_override = ? WHERE id = ?",
                ("profile/pinned-model", tid),
            )
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", "profile/pinned-model")]
        assert kb.get_task(conn, tid).model_override == "profile/pinned-model"
    finally:
        conn.close()


def test_enabled_complexity_routing_preflights_missing_profiles(
    kanban_home, routing_cfg, profile_set
):
    routing_cfg(route_map={"trivial": "missing", "simple": "dev-agent"})
    profile_set({"dev-agent", "advisor"})
    conn = kb.connect()
    try:
        with pytest.raises(RuntimeError, match="kanban.complexity_routing.*missing"):
            kb.dispatch_once(conn, spawn_fn=lambda *_: 12345)
    finally:
        conn.close()
