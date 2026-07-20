"""Route Advisor plugin.

Adds a cache-safe, deterministic nudge when the current user turn looks like
implementation work that could use the configured ``coding`` delegation route.
The plugin only returns ephemeral ``pre_llm_call`` context; it never changes the
system prompt, swaps models, or dispatches delegation itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
from typing import Any, Dict, Iterable, Mapping, Optional

from .signals import SpecificityAnalysis, analyze_text

logger = logging.getLogger(__name__)

_LEVEL_ORDER = {
    "trivial": 0,
    "simple": 1,
    "moderate": 2,
    "complex": 3,
    "expert": 4,
}
_DEFAULT_ROUTE_ADVISOR_CONFIG = {
    "mode": "off",
    "min_level": "complex",
    "cooldown_turns": 5,
    "log_signals": True,
}
_KILL_PLATFORMS = {"cron", "kanban"}


@dataclass
class AdvisorState:
    """Session-scoped cooldown state for advisor nudges."""

    last_nudge_turn_by_session: Dict[str, int] = field(default_factory=dict)


_STATE = AdvisorState()


def register(ctx: Any) -> None:
    """Register the single lifecycle hook exposed by this plugin."""

    ctx.register_hook("pre_llm_call", pre_llm_call)


def _load_config() -> Dict[str, Any]:
    from hermes_cli.config import load_config_readonly

    return load_config_readonly()


def pre_llm_call(
    user_message: str = "",
    session_id: str = "",
    platform: str = "",
    conversation_history: Optional[list[dict[str, Any]]] = None,
    **_: Any,
) -> Optional[str]:
    """Return a route-advisor nudge string or ``None``.

    Belt-and-suspenders failure isolation: although the plugin manager also
    isolates hooks, any failure inside the hook is a silent no-op.
    """

    try:
        cfg = _load_config()
        route_advisor_cfg = cfg.get("route_advisor") if isinstance(cfg, dict) else {}
        delegation_cfg = cfg.get("delegation") if isinstance(cfg, dict) else {}
        return build_nudge(
            user_message=user_message,
            route_advisor_cfg=route_advisor_cfg if isinstance(route_advisor_cfg, dict) else {},
            delegation_cfg=delegation_cfg if isinstance(delegation_cfg, dict) else {},
            session_id=session_id,
            platform=platform,
            conversation_history=conversation_history or [],
            state=_STATE,
        )
    except Exception:
        logger.debug("route_advisor pre_llm_call hook failed", exc_info=True)
        return None


def build_nudge(
    *,
    user_message: str,
    route_advisor_cfg: Mapping[str, Any],
    delegation_cfg: Mapping[str, Any],
    session_id: str,
    platform: str,
    conversation_history: Iterable[Mapping[str, Any]],
    state: AdvisorState,
) -> Optional[str]:
    """Evaluate Part B decision rules and return the nudge text if all pass."""

    text = user_message if isinstance(user_message, str) else ""
    history = list(conversation_history or [])
    cfg = _normalise_config(route_advisor_cfg)
    analysis = analyze_text(text, message_count=_message_count(history))
    routes = delegation_cfg.get("routes") if isinstance(delegation_cfg, Mapping) else {}
    coding_route_exists = isinstance(routes, Mapping) and isinstance(routes.get("coding"), Mapping)
    implementation_shaped = (
        analysis.signals["code_complexity"] >= 10
        or analysis.signals["tool_calling"] >= 2
    )
    current_turn = _current_turn_index(history)
    session_key = session_id or "<unknown>"
    cooldown_ok = _cooldown_satisfied(
        state=state,
        session_id=session_key,
        current_turn=current_turn,
        cooldown_turns=cfg["cooldown_turns"],
    )
    recent_delegation = _recent_delegate_task(history, current_turn, cfg["cooldown_turns"])
    level_ok = _LEVEL_ORDER.get(analysis.level, -1) >= _LEVEL_ORDER.get(cfg["min_level"], _LEVEL_ORDER["complex"])
    killed = _is_killed(text=text, platform=platform)
    would_nudge = bool(
        cfg["mode"] in {"log", "nudge"}
        and not killed
        and level_ok
        and implementation_shaped
        and coding_route_exists
        and cooldown_ok
        and not recent_delegation
    )

    if cfg["mode"] == "log":
        if cfg["log_signals"]:
            _log_analysis(analysis, would_nudge=would_nudge)
        return None
    if cfg["mode"] != "nudge" or not would_nudge:
        return None

    state.last_nudge_turn_by_session[session_key] = current_turn
    return _render_nudge(analysis)


def _normalise_config(config: Mapping[str, Any]) -> Dict[str, Any]:
    merged = dict(_DEFAULT_ROUTE_ADVISOR_CONFIG)
    if isinstance(config, Mapping):
        merged.update(config)
    mode = str(merged.get("mode", "off")).lower()
    if mode not in {"off", "log", "nudge"}:
        mode = "off"
    min_level = str(merged.get("min_level", "complex")).lower()
    if min_level not in _LEVEL_ORDER:
        min_level = "complex"
    try:
        cooldown_turns = max(0, int(merged.get("cooldown_turns", 5)))
    except (TypeError, ValueError):
        cooldown_turns = 5
    return {
        "mode": mode,
        "min_level": min_level,
        "cooldown_turns": cooldown_turns,
        "log_signals": bool(merged.get("log_signals", True)),
    }


def _is_killed(*, text: str, platform: str) -> bool:
    stripped = text.lstrip()
    return (
        not stripped
        or stripped.startswith("/")
        or "<route-advisor" in stripped.lower()
        or str(platform or "").lower() in _KILL_PLATFORMS
    )


def _message_count(history: Iterable[Mapping[str, Any]]) -> int:
    count = sum(1 for msg in history if msg.get("role") in {"user", "assistant"})
    return max(1, count)


def _current_turn_index(history: Iterable[Mapping[str, Any]]) -> int:
    count = sum(1 for msg in history if msg.get("role") == "user")
    return max(1, count)


def _cooldown_satisfied(
    *,
    state: AdvisorState,
    session_id: str,
    current_turn: int,
    cooldown_turns: int,
) -> bool:
    last_turn = state.last_nudge_turn_by_session.get(session_id)
    if last_turn is None or cooldown_turns <= 0:
        return True
    return current_turn - last_turn > cooldown_turns


def _recent_delegate_task(
    history: Iterable[Mapping[str, Any]],
    current_turn: int,
    cooldown_turns: int,
) -> bool:
    if cooldown_turns <= 0:
        return False
    user_turn = 0
    for msg in history:
        if msg.get("role") == "user":
            user_turn += 1
        if not _message_mentions_delegate_task(msg):
            continue
        delegate_turn = max(1, user_turn)
        if current_turn - delegate_turn <= cooldown_turns:
            return True
    return False


def _message_mentions_delegate_task(msg: Mapping[str, Any]) -> bool:
    if msg.get("name") == "delegate_task":
        return True
    tool_calls = msg.get("tool_calls")
    if isinstance(tool_calls, list):
        for call in tool_calls:
            if not isinstance(call, Mapping):
                continue
            function = call.get("function")
            if isinstance(function, Mapping) and function.get("name") == "delegate_task":
                return True
            if call.get("name") == "delegate_task":
                return True
    return False


def _log_analysis(analysis: SpecificityAnalysis, *, would_nudge: bool) -> None:
    logger.info(
        "route_advisor: score=%s level=%s signals=%s would_nudge=%s",
        analysis.score,
        analysis.level,
        analysis.signals,
        would_nudge,
    )


def _render_nudge(analysis: SpecificityAnalysis) -> str:
    preferred = ["code-complexity", "tool-calling"]
    signals = [sig for sig in preferred if sig in analysis.triggered_signals]
    if not signals:
        signals = analysis.triggered_signals[:2]
    signal_text = ",".join(signals) or "none"
    nudge = (
        f"<route-advisor score={analysis.score} level={analysis.level} "
        f"signals={signal_text}>"
        'This turn is implementation-heavy. Consider delegate_task(route="coding"); '
        "keep planning here."
        "</route-advisor>"
    )
    if len(nudge) <= 220:
        return nudge
    return (
        f"<route-advisor score={analysis.score} level={analysis.level} signals={signal_text}>"
        'Consider delegate_task(route="coding") for execution.'
        "</route-advisor>"
    )[:220]
