"""Engineering Loop Harness plugin.

Builds an additive Engineering Loop Harness as a Hermes Agent plugin that wraps,
observes, guides, and gates the existing AIAgent loop for software development
tasks: Observe → Decide → Act → Capture Feedback → Check Termination.

Architecture:
    - Plugin system (hooks + tools) — wraps existing loop without modifying it
    - State persistence — project-local .hermes/engineering-loop/
    - Tool handlers — 10 tools for explicit harness lifecycle control
    - Context injection — compact header via pre_llm_call hook
    - Non-interactive enforcement — CI=true, timeouts, stuck detection

See the spec at H:/WSpace-Hermes/hermes-projects/Hermes-ELoop/spec-engineering-loop-harness.md
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .state import StateManager
from .schemas import (
    EngineeringRunState, RunPhase, LoopType, FailureClass,
)
from .feedback import (
    classify_failure, fingerprint_failure, parse_command_feedback,
    detect_stuck_signal,
)
from .loop_classifier import classify_loop
from .tools import register_tools

logger = logging.getLogger(__name__)

# Session-scoped state (managed by hooks)
_session_state: Optional[EngineeringRunState] = None
_session_manager: Optional[StateManager] = None
_session_id: str = ""


def _get_manager() -> StateManager:
    """Get or create the state manager for the current workspace."""
    global _session_manager
    if _session_manager is None:
        cwd = Path.cwd()
        _session_manager = StateManager(cwd)
    return _session_manager


def _get_state() -> Optional[EngineeringRunState]:
    """Get the current run state."""
    global _session_state
    if _session_state is None:
        mgr = _get_manager()
        _session_state = mgr.load()
    return _session_state


def _save_state() -> None:
    """Persist the current run state."""
    global _session_state
    if _session_state is not None:
        mgr = _get_manager()
        mgr.save(_session_state)


# ── Hook callbacks ─────────────────────────────────────────────────────────


def _on_session_start(
    session_id: str = "",
    model: str = "",
    platform: str = "",
    **kwargs: Any,
) -> None:
    """Initialize harness state when a new session starts.

    Resets session-scoped globals so a fresh session never inherits stale
    state from a prior run in the same process.
    """
    global _session_id, _session_state, _session_manager
    _session_id = session_id
    _session_state = None
    _session_manager = None
    logger.debug(
        "engineering_loop: on_session_start session=%s model=%s state_reset=True",
        session_id, model,
    )


def _pre_llm_call(
    user_message: str = "",
    session_id: str = "",
    **kwargs: Any,
) -> Optional[str]:
    """Inject the Engineering Run Header before each LLM call.

    Returns a string to append to the user message, or None if no run is active.
    """
    try:
        state = _get_state()
        if state is None or not state.active:
            return None

        mgr = _get_manager()
        header = mgr.build_header(state)
        rendered = header.render()

        # Keep it compact — inject only if helpful
        if len(rendered) > 50:
            return "\n<engineering-loop-context>\n" + rendered + "\n</engineering-loop-context>"

        return None
    except Exception:
        logger.debug("engineering_loop pre_llm_call hook failed", exc_info=True)
        return None


def _pre_tool_call(
    tool_name: str = "",
    arguments: Optional[Dict[str, Any]] = None,
    **kwargs: Any,
) -> Optional[Dict[str, Any]]:
    """Observe and potentially modify tool calls before execution.

    - Enforces non-interactive mode for terminal commands
    - Injects CI=true environment variables
    - Detects interactive commands and blocks them
    """
    try:
        state = _get_state()
        if state is None or not state.active:
            return None

        # Track tool call
        state.tool_calls_observed += 1

        # For terminal commands: enforce non-interactive mode
        if tool_name == "terminal" and arguments:
            command = arguments.get("command", "")

            # Check for interactive commands
            _interactive_commands = [
                "vim ", "nano ", "emacs ", "less ", "more ",
                "htop", "top", "ssh ", "telnet ",
            ]
            for ic in _interactive_commands:
                if command.strip().startswith(ic):
                    logger.warning(
                        "engineering_loop: blocked interactive command: %s",
                        command,
                    )
                    return {
                        "error": (
                            f"Interactive command '{ic.strip()}' blocked by "
                            "Engineering Loop Harness. Use non-interactive "
                            "alternatives (redirect output to file, use --yes, etc.)"
                        ),
                    }

        return None  # Allow the tool to proceed
    except Exception:
        logger.debug("engineering_loop pre_tool_call hook failed", exc_info=True)
        return None


def _post_tool_call(
    tool_name: str = "",
    arguments: Optional[Dict[str, Any]] = None,
    result: Any = None,
    **kwargs: Any,
) -> None:
    """Observe tool results, classify failures, update state."""
    try:
        state = _get_state()
        if state is None or not state.active:
            return

        # For terminal commands: capture feedback
        if tool_name == "terminal" and arguments:
            command = arguments.get("command", "")

            # Parse exit code from result if available
            # (terminal tool returns string, not structured)
            result_str = str(result) if result else ""

            # Check for error indicators in output
            is_error = any(
                marker in result_str[:500].lower()
                for marker in [
                    "error:", "traceback", "failed", "fatal:",
                    "exception", "command not found",
                ]
            )

            if is_error:
                failure_class = classify_failure(result_str, "", 1)
                fp = fingerprint_failure(
                    failure_class, command, result_str[:300],
                )

                from .schemas import FailureRecord
                failure = FailureRecord(
                    failure_class=failure_class.value,
                    command=command,
                    message=result_str[:300],
                    fingerprint=fp,
                    occurred_at=time.time(),
                )
                state.failures.append(failure)

                # Check stuck signals
                stuck = detect_stuck_signal(
                    state.failures, state.changed_files,
                )
                if stuck:
                    state.stuck_signals.append(stuck)

            # Track command
            if command not in state.commands_run:
                state.commands_run.append(command)

            _save_state()

    except Exception:
        logger.debug("engineering_loop post_tool_call hook failed", exc_info=True)


def _transform_tool_result(
    tool_name: str = "",
    result: Any = None,
    **kwargs: Any,
) -> Optional[str]:
    """Optionally annotate tool results with engineering context.

    Only transforms when useful — most tool results pass through unchanged.
    """
    try:
        state = _get_state()
        if state is None or not state.active:
            return None

        # For terminal results: append compact engineering note
        if tool_name == "terminal" and state.failures:
            latest = state.failures[-1]
            if latest.occurred_at > time.time() - 60:  # within last minute
                return None  # Already handled by post_tool_call

        return None
    except Exception:
        return None


def _on_session_end(
    session_id: str = "",
    **kwargs: Any,
) -> None:
    """Finalize the engineering run when session ends."""
    try:
        state = _get_state()
        mgr = _get_manager()

        if state is not None and state.active:
            state.phase = RunPhase.COMPLETE.value
            mgr.finalize(state)
            mgr.append_event("session_ended", {
                "session_id": session_id,
                "run_id": state.run_id,
                "iterations": state.iteration_count,
                "failures": len(state.failures),
            })

        # Clean up app monitor
        from .app_monitor import AppMonitor
        global _app_monitor_ref
        # (AppMonitor instances are ephemeral — no global cleanup needed)

    except Exception:
        logger.debug("engineering_loop on_session_end hook failed", exc_info=True)


def _subagent_stop(
    subagent_id: str = "",
    task_id: str = "",
    result: Any = None,
    **kwargs: Any,
) -> None:
    """Collect subagent feedback for reviewer context."""
    try:
        state = _get_state()
        if state is None or not state.active:
            return

        mgr = _get_manager()
        mgr.append_event("subagent_stopped", {
            "subagent_id": str(subagent_id),
            "task_id": str(task_id),
        })
    except Exception:
        pass


# ── Plugin entry point ─────────────────────────────────────────────────────


def _check_plugin_enabled() -> bool:
    """Return True only when the plugin is explicitly enabled."""
    try:
        from hermes_cli.config import load_config, cfg_get
        config = load_config()
        enabled = cfg_get(config, "plugins", "enabled", default=[])
        if isinstance(enabled, list):
            return "engineering_loop" in enabled
        return False
    except Exception:
        return False


def register(ctx) -> None:
    """Register hooks, tools, and CLI commands with the Hermes plugin system.

    Called by the plugin manager when the plugin is loaded.
    """
    manifest = ctx.manifest
    logger.info(
        "Engineering Loop Harness v%s loading (key=%s)",
        manifest.version, manifest.key,
    )

    # Register hooks
    hooks = {
        "on_session_start": _on_session_start,
        "pre_llm_call": _pre_llm_call,
        "pre_tool_call": _pre_tool_call,
        "post_tool_call": _post_tool_call,
        "transform_tool_result": _transform_tool_result,
        "on_session_end": _on_session_end,
        "subagent_stop": _subagent_stop,
    }

    for hook_name, callback in hooks.items():
        try:
            ctx.register_hook(hook_name, callback)
            logger.debug("Registered hook: %s", hook_name)
        except Exception as exc:
            logger.warning(
                "Failed to register hook '%s': %s", hook_name, exc
            )

    # Register tools
    try:
        register_tools()
    except Exception as exc:
        logger.error("Failed to register engineering loop tools: %s", exc)

    logger.info(
        "Engineering Loop Harness loaded — %d hooks, %d tools",
        len(hooks), 10,
    )
