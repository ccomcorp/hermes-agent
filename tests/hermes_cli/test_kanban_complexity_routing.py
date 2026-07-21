from __future__ import annotations

import builtins
from types import SimpleNamespace

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli.config import DEFAULT_CONFIG, validate_config_structure


def test_default_config_declares_complexity_routing_disabled():
    routing = DEFAULT_CONFIG["kanban"]["complexity_routing"]
    assert routing["enabled"] is False
    assert routing["trigger_assignee"] == "auto"
    assert routing["fallback"] == "advisor"
    assert routing["map"]["complex"] == "advisor"


def test_config_validation_accepts_and_rejects_complexity_routing_shapes():
    valid_issues = validate_config_structure({
        "kanban": {
            "complexity_routing": {
                "enabled": True,
                "trigger_assignee": "auto",
                "min_signal_floor": 0.2,
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
                "trigger_assignee": "",
                "min_signal_floor": -1,
                "map": {"impossible": ""},
                "fallback": "",
            }
        }
    })
    messages = "\n".join(issue.message for issue in invalid_issues)
    assert "enabled" in messages
    assert "trigger_assignee" in messages
    assert "min_signal_floor" in messages
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
    def _apply(*, enabled: bool = True, fallback: str = "advisor", route_map: dict[str, str] | None = None, floor: float = 0.2):
        block = {
            "enabled": enabled,
            "trigger_assignee": "auto",
            "min_signal_floor": floor,
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


def _set_scorer(monkeypatch: pytest.MonkeyPatch, *, level: str, signals: dict[str, float] | None = None):
    import plugins.route_advisor.signals as signals_mod

    calls: list[str] = []

    def analyze_text(text: str, message_count: int = 1):
        calls.append(text)
        return SimpleNamespace(level=level, signals=signals or {"code_complexity": 1.0})

    monkeypatch.setattr(signals_mod, "analyze_text", analyze_text, raising=False)
    return calls


def _capture_spawn(captured: list[str]):
    def spawn(task, _workspace):
        captured.append(task.assignee or "")
        return 12345

    return spawn


def test_enabled_false_leaves_auto_unrouted_and_does_not_import_scorer(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg(enabled=False)
    profile_set({"dev-agent", "advisor"})
    conn = kb.connect()
    original_import = builtins.__import__
    imported: list[str] = []

    def guard_import(name, *args, **kwargs):
        if name == "plugins.route_advisor.signals":
            imported.append(name)
            raise AssertionError("scorer import must be gated behind enabled=true")
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


def test_auto_card_routes_to_profile_and_rewrites_assignee_before_spawn_gate(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    scorer_calls = _set_scorer(monkeypatch, level="complex", signals={"code_complexity": 3.0})
    spawned_profiles: list[str] = []
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
        assert spawned_profiles == ["advisor"]
        assert kb.get_task(conn, tid).assignee == "advisor"
        assert scorer_calls and "distributed tracing" in scorer_calls[0]
        assert "Touch backend dispatcher code" in scorer_calls[0]
    finally:
        conn.close()


def test_sparse_all_axes_below_floor_routes_to_fallback_not_trivial(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    _set_scorer(
        monkeypatch,
        level="trivial",
        signals={
            "code_complexity": 0.1,
            "math_complexity": 0.0,
            "reasoning_depth": 0.0,
            "context_size": 0.0,
            "tool_calling": 0.0,
            "domain_specificity": 0.0,
        },
    )
    spawned_profiles: list[str] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Fix login", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == ["advisor"]
        assert kb.get_task(conn, tid).assignee == "advisor"
    finally:
        conn.close()


def test_real_assignee_card_is_untouched_and_scorer_not_called(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    scorer_calls = _set_scorer(monkeypatch, level="expert", signals={"code_complexity": 5.0})
    spawned_profiles: list[str] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Implement complex work", assignee="dev-agent")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == ["dev-agent"]
        assert kb.get_task(conn, tid).assignee == "dev-agent"
        assert scorer_calls == []
    finally:
        conn.close()


def test_scorer_exception_routes_to_fallback(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    import plugins.route_advisor.signals as signals_mod

    def boom(_text: str, message_count: int = 1):
        raise RuntimeError("scorer down")

    monkeypatch.setattr(signals_mod, "analyze_text", boom, raising=False)
    spawned_profiles: list[str] = []
    conn = kb.connect()
    try:
        tid = kb.create_task(conn, title="Ambiguous card", assignee="auto")
        result = kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))

        assert result.spawned and result.spawned[0][0] == tid
        assert spawned_profiles == ["advisor"]
        assert kb.get_task(conn, tid).assignee == "advisor"
    finally:
        conn.close()


def test_auto_never_survives_to_spawn(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg(route_map={"trivial": "ponytail", "simple": "dev-agent", "moderate": "dev-agent", "complex": "dev-agent", "expert": "advisor"})
    profile_set({"dev-agent", "advisor", "ponytail"})
    _set_scorer(monkeypatch, level="simple", signals={"tool_calling": 1.0})
    spawned_profiles: list[str] = []
    conn = kb.connect()
    try:
        kb.create_task(conn, title="Modify config", assignee="auto")
        kb.dispatch_once(conn, spawn_fn=_capture_spawn(spawned_profiles))
        assert spawned_profiles == ["dev-agent"]
        assert "auto" not in spawned_profiles
    finally:
        conn.close()


def test_same_text_and_snapshot_route_deterministically_for_20_iterations(
    kanban_home, routing_cfg, profile_set, monkeypatch
):
    routing_cfg()
    profile_set({"dev-agent", "advisor", "ponytail"})
    _set_scorer(monkeypatch, level="moderate", signals={"reasoning_depth": 2.0})
    conn = kb.connect()
    try:
        kb.create_task(conn, title="Plan the migration and implement tests", assignee="auto")
        profiles = [kb.dispatch_once(conn, dry_run=True).spawned[0][1] for _ in range(20)]
        assert profiles == ["dev-agent"] * 20
        assert {row["assignee"] for row in conn.execute("SELECT assignee FROM tasks")} == {"auto"}
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
