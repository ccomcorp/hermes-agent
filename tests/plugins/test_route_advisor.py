from __future__ import annotations

import logging
from pathlib import Path

import pytest
import yaml


def _implementation_prompt() -> str:
    code_block = """
```python
import os

class Runner:
    async def build(self):
        def inner(value):
            return value + 1
        return inner(41)
```
```sql
SELECT id FROM jobs WHERE status = 'failed'
```
```ts
function route(value: number) {
    const next = value + 1
    return next
}
```
"""
    return (
        "Please implement the fix in src/app.py and tests/test_app.py. "
        "First inspect the failure, step 1 reproduce it, step 2 patch it, "
        "therefore run the test and build commands when done. "
        "We need to verify the approach; if the test still fails then debug the failing path. "
        + code_block
    )


def test_default_config_ships_route_advisor_off() -> None:
    from hermes_cli.config import DEFAULT_CONFIG

    assert DEFAULT_CONFIG["route_advisor"] == {
        "mode": "off",
        "min_level": "complex",
        "cooldown_turns": 5,
        "log_signals": True,
    }


def test_plugin_manifest_registers_only_pre_llm_call_hook() -> None:
    manifest = yaml.safe_load(Path("plugins/route_advisor/plugin.yaml").read_text())
    assert manifest["provides_hooks"] == ["pre_llm_call"]

    import plugins.route_advisor as route_advisor

    class FakeContext:
        def __init__(self) -> None:
            self.hooks: list[tuple[str, object]] = []

        def register_hook(self, name: str, callback: object) -> None:
            self.hooks.append((name, callback))

    ctx = FakeContext()
    route_advisor.register(ctx)

    assert [(name, getattr(cb, "__name__", "")) for name, cb in ctx.hooks] == [
        ("pre_llm_call", "pre_llm_call"),
    ]


def test_scorer_thresholds_and_tool_calling_cap_are_rescaled() -> None:
    from plugins.route_advisor.signals import analyze_text, specificity_level

    trivial = analyze_text("hey, can you summarize this sentence?", message_count=1)
    code_heavy = analyze_text(_implementation_prompt(), message_count=8)
    tool_intent = analyze_text(
        "Open files, inspect paths, run tests, patch the code, and build the package.",
        message_count=1,
    )

    assert trivial.level == "trivial"
    assert trivial.score <= 5
    assert code_heavy.level in {"complex", "expert"}
    assert code_heavy.signals["code_complexity"] >= 10
    assert tool_intent.signals["tool_calling"] == 3
    assert tool_intent.signals["tool_calling"] <= 3
    assert specificity_level(5) == "trivial"
    assert specificity_level(20) == "simple"
    assert specificity_level(40) == "moderate"
    assert specificity_level(65) == "complex"
    assert specificity_level(66) == "expert"


def test_nudge_fires_only_in_nudge_mode_with_coding_route_and_implementation_shape() -> None:
    from plugins.route_advisor import AdvisorState, build_nudge

    cfg = {"mode": "nudge", "min_level": "complex", "cooldown_turns": 5, "log_signals": True}
    delegation_cfg = {"routes": {"coding": {"provider": "deepseek", "model": "deepseek-v4-pro"}}}

    nudge = build_nudge(
        user_message=_implementation_prompt(),
        route_advisor_cfg=cfg,
        delegation_cfg=delegation_cfg,
        session_id="s1",
        platform="cli",
        conversation_history=[{"role": "user", "content": _implementation_prompt()}],
        state=AdvisorState(),
    )

    assert nudge is not None
    assert len(nudge) <= 220
    assert "<route-advisor " in nudge
    assert 'delegate_task(route="coding")' in nudge

    assert build_nudge(
        user_message=_implementation_prompt(),
        route_advisor_cfg={**cfg, "mode": "off"},
        delegation_cfg=delegation_cfg,
        session_id="s2",
        platform="cli",
        conversation_history=[],
        state=AdvisorState(),
    ) is None
    assert build_nudge(
        user_message=_implementation_prompt(),
        route_advisor_cfg={**cfg, "mode": "log"},
        delegation_cfg=delegation_cfg,
        session_id="s3",
        platform="cli",
        conversation_history=[],
        state=AdvisorState(),
    ) is None
    assert build_nudge(
        user_message=_implementation_prompt(),
        route_advisor_cfg=cfg,
        delegation_cfg={"routes": {}},
        session_id="s4",
        platform="cli",
        conversation_history=[],
        state=AdvisorState(),
    ) is None


def test_kill_conditions_and_failure_isolation(monkeypatch: pytest.MonkeyPatch) -> None:
    import plugins.route_advisor as route_advisor
    from plugins.route_advisor import AdvisorState, build_nudge

    cfg = {"mode": "nudge", "min_level": "complex", "cooldown_turns": 5, "log_signals": True}
    delegation_cfg = {"routes": {"coding": {"provider": "deepseek", "model": "deepseek-v4-pro"}}}
    kwargs = dict(
        route_advisor_cfg=cfg,
        delegation_cfg=delegation_cfg,
        session_id="s1",
        conversation_history=[],
        state=AdvisorState(),
    )

    assert build_nudge(user_message="/status", platform="cli", **kwargs) is None
    assert build_nudge(user_message="<route-advisor>echo</route-advisor>", platform="cli", **kwargs) is None
    assert build_nudge(user_message=_implementation_prompt(), platform="kanban", **kwargs) is None
    assert build_nudge(user_message=_implementation_prompt(), platform="cron", **kwargs) is None

    monkeypatch.setattr(route_advisor, "_load_config", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    assert route_advisor.pre_llm_call(user_message=_implementation_prompt(), platform="cli") is None


def test_cooldown_and_recent_delegation_suppress_repeated_nudges() -> None:
    from plugins.route_advisor import AdvisorState, build_nudge

    cfg = {"mode": "nudge", "min_level": "complex", "cooldown_turns": 5, "log_signals": True}
    delegation_cfg = {"routes": {"coding": {"provider": "deepseek", "model": "deepseek-v4-pro"}}}
    state = AdvisorState()

    first = build_nudge(
        user_message=_implementation_prompt(),
        route_advisor_cfg=cfg,
        delegation_cfg=delegation_cfg,
        session_id="s1",
        platform="cli",
        conversation_history=[{"role": "user", "content": _implementation_prompt()}],
        state=state,
    )
    second = build_nudge(
        user_message=_implementation_prompt(),
        route_advisor_cfg=cfg,
        delegation_cfg=delegation_cfg,
        session_id="s1",
        platform="cli",
        conversation_history=[
            {"role": "user", "content": "1"},
            {"role": "assistant", "content": "ok"},
            {"role": "user", "content": "2"},
            {"role": "user", "content": _implementation_prompt()},
        ],
        state=state,
    )
    after_cooldown = build_nudge(
        user_message=_implementation_prompt(),
        route_advisor_cfg=cfg,
        delegation_cfg=delegation_cfg,
        session_id="s1",
        platform="cli",
        conversation_history=[{"role": "user", "content": str(i)} for i in range(8)],
        state=state,
    )

    assert first is not None
    assert second is None
    assert after_cooldown is not None

    assert build_nudge(
        user_message=_implementation_prompt(),
        route_advisor_cfg=cfg,
        delegation_cfg=delegation_cfg,
        session_id="s2",
        platform="cli",
        conversation_history=[
            {"role": "user", "content": "please implement"},
            {"role": "assistant", "tool_calls": [{"function": {"name": "delegate_task"}}]},
            {"role": "tool", "name": "delegate_task", "content": "done"},
            {"role": "user", "content": _implementation_prompt()},
        ],
        state=AdvisorState(),
    ) is None


def test_log_mode_logs_signal_summary_without_injection(caplog: pytest.LogCaptureFixture) -> None:
    from plugins.route_advisor import AdvisorState, build_nudge

    caplog.set_level(logging.INFO, logger="plugins.route_advisor")

    result = build_nudge(
        user_message=_implementation_prompt(),
        route_advisor_cfg={"mode": "log", "min_level": "complex", "cooldown_turns": 5, "log_signals": True},
        delegation_cfg={"routes": {"coding": {"provider": "deepseek", "model": "deepseek-v4-pro"}}},
        session_id="s1",
        platform="cli",
        conversation_history=[{"role": "user", "content": _implementation_prompt()}],
        state=AdvisorState(),
    )

    assert result is None
    assert "route_advisor:" in caplog.text
    assert "would_nudge=True" in caplog.text
