"""Integration tests for plugin loading, tool registration, and backward compat."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add hermes-agent root to path
HERMES_ROOT = Path(__file__).resolve().parents[3]
if str(HERMES_ROOT) not in sys.path:
    sys.path.insert(0, str(HERMES_ROOT))


class TestPluginRegistration:
    """Verify the plugin registers correctly with the plugin system."""

    def test_plugin_imports_cleanly(self):
        """All plugin modules import without errors."""
        from plugins.engineering_loop import schemas
        from plugins.engineering_loop import state
        from plugins.engineering_loop import feedback
        from plugins.engineering_loop import gates
        from plugins.engineering_loop import loop_classifier
        from plugins.engineering_loop import app_monitor
        from plugins.engineering_loop import reviewer
        from plugins.engineering_loop import git_commit
        from plugins.engineering_loop import traces
        from plugins.engineering_loop import tools
        assert True  # All imports succeeded

    def test_register_function_exists(self):
        """The register() entry point exists and is callable."""
        from plugins.engineering_loop import register
        assert callable(register)

    def test_plugin_yaml_exists(self):
        """plugin.yaml manifest exists and is valid."""
        plugin_yaml = HERMES_ROOT / "plugins" / "engineering_loop" / "plugin.yaml"
        assert plugin_yaml.exists()

    def test_tool_definitions_all_have_handlers(self):
        """Every tool definition has a handler callable."""
        from plugins.engineering_loop.tools import TOOL_DEFINITIONS
        assert len(TOOL_DEFINITIONS) == 10
        for tdef in TOOL_DEFINITIONS:
            assert callable(tdef["handler"]), f"{tdef['name']} handler is not callable"
            assert "parameters" in tdef, f"{tdef['name']} missing parameters schema"

    def test_tool_handlers_accept_correct_args(self):
        """Tool handlers work with required parameters only."""
        from plugins.engineering_loop.tools import _handle_status
        result = _handle_status()
        # When no state exists, should return error
        assert "error" in result or "ok" in result

    def test_schemas_dataclasses_instantiate(self):
        """All dataclasses can be instantiated with defaults."""
        from plugins.engineering_loop.schemas import (
            EngineeringRunState,
            GateDefinition,
            GateResult,
            FeedbackRecord,
            FailureRecord,
            AppMonitorResult,
            ReviewerResult,
            EngineeringRunHeader,
        )
        state = EngineeringRunState(goal="test")
        assert state.run_id != ""
        assert state.active is True

        gate = GateDefinition(name="test", command="echo hi")
        assert gate.name == "test"
        assert gate.env.get("CI") == "true"

        header = EngineeringRunHeader(goal="test goal", phase="act")
        rendered = header.render()
        assert "test goal" in rendered


class TestBackwardCompatibility:
    """Existing Hermes behavior is unaffected."""

    def test_no_import_side_effects(self):
        """Importing the plugin doesn't register anything globally."""
        # The register_tools function should not auto-execute on import
        from plugins.engineering_loop import tools as tools_module
        # TOOL_DEFINITIONS exists but tools shouldn't be registered yet
        assert hasattr(tools_module, "TOOL_DEFINITIONS")
        assert len(tools_module.TOOL_DEFINITIONS) == 10

    def test_hooks_are_non_blocking(self):
        """Hooks return None quickly and don't throw."""
        from plugins.engineering_loop import (
            _pre_llm_call,
            _pre_tool_call,
            _post_tool_call,
            _transform_tool_result,
            _subagent_stop,
        )
        # When no state exists, hooks should return None quickly
        result = _pre_llm_call(user_message="test", session_id="test")
        assert result is None  # No active run

        result = _pre_tool_call(tool_name="terminal", arguments={"command": "echo hi"})
        assert result is None  # Passes through

        # Post tool call should not raise
        _post_tool_call(tool_name="terminal", arguments={"command": "echo hi"}, result="hello")
        assert True  # No exception

        result = _transform_tool_result(tool_name="terminal", result="output")
        assert result is None

        _subagent_stop(subagent_id="sub1", task_id="task1")
        assert True  # No exception

    def test_hooks_catch_exceptions(self):
        """A hook that throws internally doesn't propagate."""
        from plugins.engineering_loop import _on_session_start
        # Call with unexpected kwarg — should not raise
        try:
            _on_session_start(session_id="test", unexpected_kwarg=object())
        except Exception as exc:
            assert False, f"Hook should catch exceptions: {exc}"

    def test_on_session_start_resets_state_globals(self, temp_project):
        """A new session discards any leftover state from a prior run."""
        import plugins.engineering_loop as eloop

        # Simulate leftover state from a prior run
        eloop._session_state = object()  # any non-None value
        eloop._session_manager = object()

        eloop._on_session_start(session_id="session-2")

        # Both must be None after a new session starts
        assert eloop._session_state is None, (
            "_session_state not reset by on_session_start"
        )
        assert eloop._session_manager is None, (
            "_session_manager not reset by on_session_start"
        )


class TestStateIsolation:
    """Engineering loop state is isolated from Hermes persistent memory."""

    def test_no_memory_references(self):
        """The harness does not import or reference MEMORY.md tool."""
        import plugins.engineering_loop as eloop
        # Check source of our own modules only (skip builtins)
        eloop_dir = HERMES_ROOT / "plugins" / "engineering_loop"
        memory_refs = []
        for py_file in eloop_dir.glob("*.py"):
            if py_file.name == "__init__.py":
                continue
            content = py_file.read_text("utf-8")
            if "memory_tool" in content or "MEMORY.md" in content:
                memory_refs.append(py_file.name)
        assert not memory_refs, (
            f"Files reference memory: {memory_refs}. "
            "Harness must not write to persistent memory."
        )

    def test_state_stored_on_disk_not_memory(self):
        """State is stored in .hermes/engineering-loop/, not MEMORY.md."""
        from plugins.engineering_loop.state import ELOOP_DIR
        assert ".hermes" in str(ELOOP_DIR)
        assert "MEMORY.md" not in str(ELOOP_DIR)
