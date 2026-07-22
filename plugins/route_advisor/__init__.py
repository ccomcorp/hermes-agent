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
    "lane_by_type": True,
    # Default OFF: independent verification is valuable, but it adds a second
    # model pass after delegation. Users can opt in when they prefer the
    # quality gate over token minimisation.
    "verify_nudge": False,
    "verify_min_level": "moderate",
}
_KILL_PLATFORMS = {"cron", "kanban"}


@dataclass
class AdvisorState:
    """Session-scoped cooldown state for advisor nudges."""

    last_nudge_turn_by_session: Dict[str, int] = field(default_factory=dict)
    last_verify_nudge_turn_by_session: Dict[str, int] = field(default_factory=dict)


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
    routes = routes if isinstance(routes, Mapping) else {}
    chosen_route = _select_route(analysis, routes, lane_by_type=cfg["lane_by_type"])
    work_shaped = (
        analysis.signals["code_complexity"] >= 10
        or analysis.signals["tool_calling"] >= 2
        or analysis.signals.get("debugging_intent", 0) > 0
        or analysis.signals.get("frontend_intent", 0) > 0
        or analysis.signals.get("research_intent", 0) > 0
        or analysis.signals.get("architecture_intent", 0) > 0
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
        and work_shaped
        and chosen_route is not None
        and cooldown_ok
        and not recent_delegation
    )
    verify_route = _select_verifier_route(routes, producer_route=chosen_route or "coding")
    verify_level_ok = _LEVEL_ORDER.get(analysis.level, -1) >= _LEVEL_ORDER.get(
        cfg["verify_min_level"], _LEVEL_ORDER["moderate"]
    )
    verify_cooldown_ok = _verify_cooldown_satisfied(
        state=state,
        session_id=session_key,
        current_turn=current_turn,
        cooldown_turns=cfg["cooldown_turns"],
    )
    would_verify_nudge = bool(
        cfg["mode"] in {"log", "nudge"}
        and cfg["verify_nudge"]
        and not killed
        and recent_delegation
        and verify_level_ok
        and verify_route is not None
        and verify_cooldown_ok
    )

    if cfg["mode"] == "log":
        if cfg["log_signals"]:
            _log_analysis(analysis, would_nudge=would_nudge or would_verify_nudge)
        return None
    if cfg["mode"] != "nudge":
        return None
    if would_verify_nudge:
        state.last_verify_nudge_turn_by_session[session_key] = current_turn
        return _render_verify_nudge(analysis, verify_route)
    if not would_nudge or chosen_route is None:
        return None

    state.last_nudge_turn_by_session[session_key] = current_turn
    return _render_nudge(analysis, chosen_route)


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
    verify_min_level = str(merged.get("verify_min_level", "moderate")).lower()
    if verify_min_level not in _LEVEL_ORDER:
        verify_min_level = "moderate"
    return {
        "mode": mode,
        "min_level": min_level,
        "cooldown_turns": cooldown_turns,
        "log_signals": bool(merged.get("log_signals", True)),
        "lane_by_type": bool(merged.get("lane_by_type", True)),
        "verify_nudge": bool(merged.get("verify_nudge", False)),
        "verify_min_level": verify_min_level,
    }




def _route_exists(routes: Mapping[str, Any], route: str) -> bool:
    return isinstance(routes, Mapping) and isinstance(routes.get(route), Mapping)


def _select_route(analysis: SpecificityAnalysis, routes: Mapping[str, Any], *, lane_by_type: bool) -> Optional[str]:
    if not lane_by_type:
        return "coding" if _route_exists(routes, "coding") else None
    candidates: list[str] = []
    signals = analysis.signals
    if signals.get("frontend_intent", 0) > 0:
        candidates.append("frontend")
    if signals.get("research_intent", 0) > 0:
        candidates.append("research")
    if signals.get("architecture_intent", 0) > 0:
        candidates.extend(["planning", "thinking"])
    if signals.get("debugging_intent", 0) > 0:
        candidates.append("debugging")
    if (
        signals.get("reasoning_depth", 0) >= 10
        and _LEVEL_ORDER.get(analysis.level, 0) >= _LEVEL_ORDER["complex"]
        and not any(
            signals.get(key, 0) > 0
            for key in ("frontend_intent", "research_intent", "debugging_intent")
        )
    ):
        candidates.extend(["planning", "thinking"])
    if signals.get("math_complexity", 0) >= 4:
        candidates.append("thinking")
    if signals.get("code_complexity", 0) >= 10 or signals.get("tool_calling", 0) >= 2:
        candidates.append("coding")
    candidates.append("coding")
    for route in candidates:
        if _route_exists(routes, route):
            return route
    return None


def _select_verifier_route(routes: Mapping[str, Any], *, producer_route: str) -> Optional[str]:
    # Prefer lanes intentionally pinned to different model families in the user's
    # routing matrix: critic (Moonshot), source-checker (Google), review (Kimi).
    for route in ("critic", "source-checker", "review"):
        if route != producer_route and _route_exists(routes, route):
            return route
    return None


def _verify_cooldown_satisfied(
    *,
    state: AdvisorState,
    session_id: str,
    current_turn: int,
    cooldown_turns: int,
) -> bool:
    last_turn = state.last_verify_nudge_turn_by_session.get(session_id)
    if last_turn is None or cooldown_turns <= 0:
        return True
    return current_turn - last_turn > cooldown_turns


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


def _render_nudge(analysis: SpecificityAnalysis, route: str) -> str:
    preferred = ["code-complexity", "tool-calling"]
    signals = [sig for sig in preferred if sig in analysis.triggered_signals]
    if not signals:
        signals = analysis.triggered_signals[:2]
    signal_text = ",".join(signals) or "none"
    nudge = (
        f"<route-advisor score={analysis.score} level={analysis.level} "
        f"signals={signal_text}>"
        f'This turn is work-heavy. Consider delegate_task(route="{route}"); '
        "keep planning here."
        "</route-advisor>"
    )
    if len(nudge) <= 220:
        return nudge
    return (
        f"<route-advisor score={analysis.score} level={analysis.level} signals={signal_text}>"
        f'Consider delegate_task(route="{route}") for execution.'
        "</route-advisor>"
    )[:220]


def _render_verify_nudge(analysis: SpecificityAnalysis, route: str) -> str:
    signal_text = ",".join(analysis.triggered_signals[:2]) or "none"
    nudge = (
        f"<route-advisor score={analysis.score} level={analysis.level} "
        f"signals={signal_text}>"
        f'Delegated work is present. Consider independent validation via delegate_task(route="{route}") before accepting it.'
        "</route-advisor>"
    )
    if len(nudge) <= 240:
        return nudge
    return (
        f"<route-advisor score={analysis.score} level={analysis.level} signals={signal_text}>"
        f'Consider delegate_task(route="{route}") to independently validate delegated work.'
        "</route-advisor>"
    )[:240]
