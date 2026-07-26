from __future__ import annotations

import builtins
import json
from types import SimpleNamespace

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli.config import DEFAULT_CONFIG, validate_config_structure

VALID_MODEL = "anthropic/claude-sonnet-4.5"


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
        explicit_model_profile: str = "advisor",
        default_to_trigger: bool = False,
    ):
        block = {
            "enabled": enabled,
            "mode": mode,
            "trigger_assignee": "auto",
            "explicit_model_profile": explicit_model_profile,
            "default_to_trigger": default_to_trigger,
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


def _install_model_catalog(monkeypatch: pytest.MonkeyPatch, *, valid: set[str] | None = None):
    from hermes_cli import models

    valid = valid or {VALID_MODEL}
    monkeypatch.setattr(models, "model_ids", lambda *, force_refresh=False: sorted(valid))

    def validate_requested_model(model_name, provider, **_kwargs):
        requested = f"{provider}:{model_name}" if provider != "openrouter" else model_name
        if requested in valid or model_name in valid:
            return {"accepted": True, "persist": True, "recognized": True, "message": None}
        return {
            "accepted": False,
            "persist": False,
            "recognized": False,
            "message": f"Model `{requested}` was not found in the test catalog.",
        }

    monkeypatch.setattr(models, "validate_requested_model", validate_requested_model)


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


def test_explicit_complexity_override_routes_without_classifier(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(monkeypatch)
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Expert override", assignee="auto")
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET complexity_override = ? WHERE id = ?",
                ("expert", tid),
            )
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", None)]
        assert kb.get_task(conn, tid).assignee == "advisor"
        assert client.calls == []
        event = conn.execute(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'assigned' "
            "ORDER BY id DESC LIMIT 1",
            (tid,),
        ).fetchone()
        payload = json.loads(event["payload"])
        assert payload["route_reason"] == "explicit_complexity:expert"
    finally:
        conn.close()


def test_invalid_complexity_override_falls_back_without_classifier(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(monkeypatch)
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Bad override", assignee="auto")
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET complexity_override = ? WHERE id = ?",
                ("impossible", tid),
            )
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", None)]
        assert client.calls == []
        event = conn.execute(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'assigned' "
            "ORDER BY id DESC LIMIT 1",
            (tid,),
        ).fetchone()
        payload = json.loads(event["payload"])
        assert payload["route_reason"] == "explicit_complexity_invalid_fallback"
        assert payload["complexity_override"] == "impossible"
    finally:
        conn.close()


def test_explicit_model_override_routes_without_classifier(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg(explicit_model_profile="advisor")
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(monkeypatch)
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Pinned model auto card", assignee="auto")
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET model_override = ? WHERE id = ?",
                (VALID_MODEL, tid),
            )
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", VALID_MODEL)]
        task = kb.get_task(conn, tid)
        assert task.assignee == "advisor"
        assert task.model_override == VALID_MODEL
        assert client.calls == []
        event = conn.execute(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'assigned' "
            "ORDER BY id DESC LIMIT 1",
            (tid,),
        ).fetchone()
        payload = json.loads(event["payload"])
        assert payload["route_reason"] == "explicit_model"
        assert payload["model"] == VALID_MODEL
    finally:
        conn.close()


def test_default_to_trigger_routes_unassigned_before_default_assignee(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg(default_to_trigger=True)
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(
        monkeypatch,
        {
            "tier": "trivial",
            "profile": "ponytail",
            "confidence": 0.95,
            "rationale": "small card",
        },
    )
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Unassigned routed card", assignee=None)
        result = kb.dispatch_once(
            conn,
            spawn_fn=_capture_spawn(spawned_profiles),
            default_assignee="dev-agent",
        )

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("ponytail", None)]
        assert result.auto_assigned_default == []
        assert kb.get_task(conn, tid).assignee == "ponytail"
        assert len(client.calls) == 1
        event = conn.execute(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'assigned' "
            "ORDER BY id DESC LIMIT 1",
            (tid,),
        ).fetchone()
        payload = json.loads(event["payload"])
        assert payload["route_reason"] == "classifier:trivial"
        assert payload["assignee"] == "ponytail"
        assert payload["source"] == "kanban.complexity_routing"
    finally:
        conn.close()


def test_default_to_trigger_false_falls_through_to_default_assignee_without_classifier(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    """Backwards-compatible branch: routing enabled, default_to_trigger=False,
    unassigned card -> kanban.default_assignee without classifier call."""
    routing_cfg(default_to_trigger=False)
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(monkeypatch)
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Unassigned fallthrough card", assignee=None)
        result = kb.dispatch_once(
            conn,
            spawn_fn=_capture_spawn(spawned_profiles),
            default_assignee="dev-agent",
        )

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("dev-agent", None)]
        assert tid in result.auto_assigned_default
        assert kb.get_task(conn, tid).assignee == "dev-agent"
        assert client.calls == []
        event = conn.execute(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'assigned' "
            "ORDER BY id DESC LIMIT 1",
            (tid,),
        ).fetchone()
        payload = json.loads(event["payload"])
        assert payload["source"] == "kanban.default_assignee"
        assert payload["assignee"] == "dev-agent"
    finally:
        conn.close()


def test_default_to_trigger_does_not_reroute_explicit_assignee(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg(default_to_trigger=True)
    profile_set({"dev-agent", "advisor", "ponytail"})
    client = _install_aux(monkeypatch)
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Explicit dev card", assignee="dev-agent")
        result = kb.dispatch_once(
            conn,
            spawn_fn=_capture_spawn(spawned_profiles),
            default_assignee="advisor",
        )

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("dev-agent", None)]
        assert kb.get_task(conn, tid).assignee == "dev-agent"
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
    times = iter([100.0, 102.0, 102.0])
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
    _install_model_catalog(monkeypatch, valid={VALID_MODEL})
    _install_aux(
        monkeypatch,
        {
            "tier": "expert",
            "profile": "advisor",
            "confidence": 0.95,
            "rationale": "needs stronger model",
            "model": VALID_MODEL,
        },
    )
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Hard card", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", VALID_MODEL)]
        assert kb.get_task(conn, tid).model_override == VALID_MODEL
    finally:
        conn.close()


def test_classifier_invalid_model_is_rejected_without_blocking_profile_route(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    _install_model_catalog(monkeypatch, valid={VALID_MODEL})
    _install_aux(
        monkeypatch,
        {
            "tier": "expert",
            "profile": "advisor",
            "confidence": 0.95,
            "rationale": "tries a typo model",
            "model": "gtp-5-super",
        },
    )
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Hard card with typo model", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", None)]
        assert kb.get_task(conn, tid).model_override is None
        event = conn.execute(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'assigned' "
            "ORDER BY id DESC LIMIT 1",
            (tid,),
        ).fetchone()
        payload = json.loads(event["payload"])
        assert payload["route_reason"] == "classifier:expert"
        assert payload["model_rejected"] == "gtp-5-super"
        assert "not found" in payload["model_reject_reason"]
    finally:
        conn.close()


def test_classifier_provider_scoped_model_field_is_validated_and_preserved(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    custom_model = "custom:local:qwen-local"
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    _install_model_catalog(monkeypatch, valid={custom_model})
    _install_aux(
        monkeypatch,
        {
            "tier": "expert",
            "profile": "advisor",
            "confidence": 0.95,
            "rationale": "local model preferred",
            "model": custom_model,
        },
    )
    spawned_profiles: list[tuple[str, str | None]] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Hard local card", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == [("advisor", custom_model)]
        assert kb.get_task(conn, tid).model_override == custom_model
        event = conn.execute(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'assigned' "
            "ORDER BY id DESC LIMIT 1",
            (tid,),
        ).fetchone()
        payload = json.loads(event["payload"])
        assert payload["model"] == custom_model
        assert "model_rejected" not in payload
    finally:
        conn.close()


def test_existing_task_model_override_wins_over_classifier_model(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    _install_model_catalog(monkeypatch, valid={VALID_MODEL})
    _install_aux(
        monkeypatch,
        {
            "tier": "expert",
            "profile": "advisor",
            "confidence": 0.95,
            "rationale": "classifier suggests a stronger model",
            "model": VALID_MODEL,
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
