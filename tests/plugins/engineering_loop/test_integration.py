"""Integration tests for plugin loading, tool registration, and backward compat."""

from __future__ import annotations

import json
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

    def test_hooks_are_non_blocking(self, tmp_path, monkeypatch):
        """Hooks return None quickly and don't throw."""
        monkeypatch.chdir(tmp_path)
        from plugins.engineering_loop import (
            _on_session_start,
            _pre_llm_call,
            _pre_tool_call,
            _post_tool_call,
            _transform_tool_result,
            _subagent_stop,
        )
        _on_session_start(session_id="isolated-hook-test")
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



class TestStateReloadRepair:
    """Regression tests for persisted state shapes from older/live runs."""

    def test_reviewer_status_string_reloads_as_enum(self, state_manager, sample_state):
        """Persisted reviewer strings must not crash status/header rendering."""
        import json

        from plugins.engineering_loop.schemas import ReviewerStatus

        state_manager.save(sample_state)
        raw = json.loads(state_manager.state_path.read_text("utf-8"))
        raw["reviewer"]["status"] = "PASS"
        state_manager.state_path.write_text(json.dumps(raw), "utf-8")

        loaded = state_manager.load()

        assert loaded is not None
        assert loaded.reviewer.status == ReviewerStatus.PASS
        header = state_manager.build_header(loaded)
        assert header.reviewer_status == "PASS"

    def test_reviewer_status_stringified_enum_reloads_as_enum(self, state_manager, sample_state):
        """Persisted default=str enum strings must reload as ReviewerStatus."""
        import json

        from plugins.engineering_loop.schemas import ReviewerStatus

        state_manager.save(sample_state)
        raw = json.loads(state_manager.state_path.read_text("utf-8"))
        raw["reviewer"]["status"] = "ReviewerStatus.PASS"
        state_manager.state_path.write_text(json.dumps(raw), "utf-8")

        loaded = state_manager.load()

        assert loaded is not None
        assert loaded.reviewer.status == ReviewerStatus.PASS
        header = state_manager.build_header(loaded)
        assert header.reviewer_status == "PASS"


class TestRegistryDispatchContract:
    """Regression: handlers must tolerate the registry's (args, **kwargs) call
    contract, including framework-injected kwargs like ``task_id``.

    Previously the handlers declared explicit named parameters and crashed with
    ``_handle_start() got an unexpected keyword argument 'task_id'`` because the
    central registry dispatches every tool as ``handler(args_dict, **kwargs)``.
    The ``_adapt_handler`` wrapper in ``register_tools`` bridges the two.
    """

    def test_dispatch_start_with_task_id(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)
        from tools.registry import registry
        from plugins.engineering_loop.tools import register_tools
        from plugins.engineering_loop import tools as eloop_tools

        eloop_tools.reset_session_state()
        register_tools()
        result = registry.dispatch(
            "engineering_loop_start",
            {
                "goal": "regression: task_id must not crash dispatch",
                "acceptance_criteria": ["ok"],
                "loop_type": "deterministic",
                "task_source": "test",
            },
            task_id="task-xyz",      # framework-injected; previously crashed
            session_id="sess-1",
        )
        # Registry tool-result contract: handlers must return JSON strings
        # (not raw dicts). _adapt_handler serializes dict returns.
        assert isinstance(result, str)
        assert "unexpected keyword" not in result
        assert "unsupported result type" not in result
        assert "tool_result_contract" not in result
        payload = json.loads(result)
        assert payload.get("ok") is True

    def test_dispatch_noarg_handler_with_task_id(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)
        from tools.registry import registry
        from plugins.engineering_loop.tools import register_tools
        from plugins.engineering_loop import tools as eloop_tools

        eloop_tools.reset_session_state()
        register_tools()
        # status takes no declared params; task_id must be silently dropped.
        result = registry.dispatch("engineering_loop_status", {}, task_id="t")
        assert isinstance(result, str)
        assert "unexpected keyword" not in result
        assert "unsupported result type" not in result
        payload = json.loads(result)
        assert isinstance(payload, dict)

    def test_no_discovered_gates_records_optional_evidence_for_termination(
        self,
        tmp_path,
        monkeypatch,
    ):
        """No discovered gates should not leave termination permanently blocked."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)

        from tools.registry import registry
        from plugins.engineering_loop.tools import register_tools
        from plugins.engineering_loop import tools as eloop_tools

        eloop_tools.reset_session_state()
        register_tools()

        started = json.loads(registry.dispatch(
            "engineering_loop_start",
            {
                "goal": "diagnostic no-code run",
                "acceptance_criteria": ["diagnosis recorded"],
                "loop_type": "deterministic",
                "task_source": "test",
            },
        ))
        assert started.get("ok") is True

        gates = json.loads(registry.dispatch("engineering_loop_run_gate", {"all_gates": True}))
        assert gates.get("ok") is True
        assert gates["results"][0]["name"] == "gate-discovery"
        assert gates["results"][0]["required"] is False

        termination = json.loads(registry.dispatch(
            "engineering_loop_check_termination",
            {
                "reviewer_response": '{"verdict":"PASS","feedback":"ok","action_items":[]}',
                "reviewer_model": "independent-reviewer",
                "main_model": "main-agent",
            },
        ))

        assert termination.get("ok") is True
        assert termination.get("can_complete") is True
        assert termination.get("issues") == []

    def test_double_no_discovered_gates_preserves_optional_evidence(
        self,
        tmp_path,
        monkeypatch,
    ):
        """Repeated all_gates on no-gate projects must not erase evidence."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)

        from tools.registry import registry
        from plugins.engineering_loop.tools import register_tools
        from plugins.engineering_loop import tools as eloop_tools

        eloop_tools.reset_session_state()
        register_tools()
        registry.dispatch(
            "engineering_loop_start",
            {
                "goal": "diagnostic no-code run",
                "acceptance_criteria": ["diagnosis recorded"],
                "loop_type": "deterministic",
                "task_source": "test",
            },
        )

        first = json.loads(registry.dispatch("engineering_loop_run_gate", {"all_gates": True}))
        second = json.loads(registry.dispatch("engineering_loop_run_gate", {"all_gates": True}))

        assert first.get("results", [{}])[0].get("name") == "gate-discovery"
        assert second.get("results", [{}])[0].get("name") == "gate-discovery"
        assert second.get("results", [{}])[0].get("required") is False

        termination = json.loads(registry.dispatch(
            "engineering_loop_check_termination",
            {
                "reviewer_response": '{"verdict":"PASS","feedback":"ok","action_items":[]}',
                "reviewer_model": "independent-reviewer",
                "main_model": "main-agent",
            },
        ))
        assert termination.get("can_complete") is True
        assert termination.get("issues") == []

    def test_hook_and_tool_state_share_single_cache(self, tmp_path, monkeypatch):
        """Hook saves must not overwrite newer tool-handler updates."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)

        import plugins.engineering_loop as eloop
        from plugins.engineering_loop import tools as eloop_tools
        from plugins.engineering_loop.schemas import RunPhase

        eloop._on_session_start(session_id="cache-regression")
        started = eloop_tools._handle_start(
            goal="cache coherence regression",
            acceptance_criteria=["phase survives hook feedback"],
            loop_type="deterministic",
            task_source="test",
            session_id="cache-regression",
        )
        assert started.get("ok") is True

        # Force the hook side to load its state object, then update through the
        # tool handler.  Older code had two independent state objects and the
        # hook-side post_tool_call save would overwrite this phase update.
        assert eloop._pre_llm_call(user_message="observe") is not None
        updated = eloop_tools._handle_update(phase=RunPhase.ACT.value)
        assert updated.get("phase") == RunPhase.ACT.value

        eloop._post_tool_call(
            tool_name="terminal",
            arguments={"command": "echo ok"},
            result="ok",
        )

        reloaded = eloop_tools._get_manager().load()
        assert reloaded is not None
        assert reloaded.phase == RunPhase.ACT.value
        assert "echo ok" in reloaded.commands_run

    def test_commit_refuses_without_passed_review_and_gates(self, tmp_path, monkeypatch):
        """Commit tool must enforce gates and independent review before commit."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)

        from plugins.engineering_loop import tools as eloop_tools

        eloop_tools.reset_session_state()
        started = eloop_tools._handle_start(
            goal="commit gating regression",
            acceptance_criteria=["commit is gated"],
            loop_type="deterministic",
            task_source="test",
        )
        assert started.get("ok") is True

        result = eloop_tools._handle_commit(message="test: should not commit")

        assert result.get("ok") is False
        assert "review" in result.get("error", "").lower()
        assert "gate" in result.get("error", "").lower()

    def test_commit_refuses_same_model_review_for_deterministic_work(self, tmp_path, monkeypatch):
        """Commit tool must mirror termination's deterministic same-model block."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)

        from plugins.engineering_loop import tools as eloop_tools
        from plugins.engineering_loop.schemas import GateResult, ReviewerResult, ReviewerStatus

        eloop_tools.reset_session_state()
        started = eloop_tools._handle_start(
            goal="same-model commit gate regression",
            acceptance_criteria=["independent review is enforced at commit"],
            loop_type="deterministic",
            task_source="test",
        )
        assert started.get("ok") is True

        state = eloop_tools._get_state()
        assert state is not None
        state.verification_gates = [
            GateResult(
                gate_name="unit",
                command="pytest",
                exit_code=0,
                passed=True,
                duration_seconds=0.1,
            )
        ]
        state.reviewer = ReviewerResult(
            status=ReviewerStatus.PASS,
            feedback="ok",
            same_model_warning=True,
        )
        eloop_tools._save_state()

        result = eloop_tools._handle_commit(message="test: should not commit")

        assert result.get("ok") is False
        assert "same model" in result.get("error", "").lower()

    def test_commit_auto_stages_changed_files_after_review_and_gates(self, tmp_path, monkeypatch):
        """Commit tool stages the run's changed_files once gates and review pass."""
        import subprocess

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)
        subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=tmp_path, check=True)
        subprocess.run(["git", "config", "user.name", "Hermes Test"], cwd=tmp_path, check=True)

        from plugins.engineering_loop import tools as eloop_tools
        from plugins.engineering_loop.schemas import GateResult, ReviewerResult, ReviewerStatus

        eloop_tools.reset_session_state()
        started = eloop_tools._handle_start(
            goal="commit auto-stage regression",
            acceptance_criteria=["commit is gated"],
            loop_type="deterministic",
            task_source="test",
        )
        assert started.get("ok") is True

        (tmp_path / "tracked.txt").write_text("committed by harness\n", "utf-8")
        state = eloop_tools._get_state()
        assert state is not None
        state.changed_files = ["tracked.txt"]
        state.verification_gates = [
            GateResult(
                gate_name="unit",
                command="pytest",
                exit_code=0,
                passed=True,
                duration_seconds=0.1,
            )
        ]
        state.reviewer = ReviewerResult(status=ReviewerStatus.PASS, feedback="ok")
        eloop_tools._save_state()

        result = eloop_tools._handle_commit(message="test: auto-stage harness changes")

        assert result.get("ok") is True
        assert result.get("commit_hash")
        show = subprocess.run(
            ["git", "show", "--name-only", "--format=%s", "HEAD"],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        )
        assert "test: auto-stage harness changes" in show.stdout
        assert "tracked.txt" in show.stdout

    def test_same_model_review_blocks_deterministic_runs(self, tmp_path, monkeypatch):
        """Deterministic work must not terminate with same-model review."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)

        from plugins.engineering_loop import tools as eloop_tools
        from plugins.engineering_loop.schemas import GateResult

        eloop_tools.reset_session_state()
        eloop_tools._handle_start(
            goal="same-model regression",
            acceptance_criteria=["independent review enforced"],
            loop_type="deterministic",
            task_source="test",
        )
        state = eloop_tools._get_state()
        assert state is not None
        state.verification_gates = [
            GateResult(
                gate_name="unit",
                command="pytest",
                exit_code=0,
                passed=True,
                duration_seconds=0.1,
            )
        ]
        eloop_tools._save_state()

        result = eloop_tools._handle_check_termination(
            reviewer_response='{"verdict":"PASS","feedback":"ok","action_items":[]}',
            reviewer_model="main-model",
            main_model="main-model",
        )

        assert result.get("can_complete") is False
        assert any("same model" in issue.lower() for issue in result.get("issues", []))

    def test_same_model_review_allowed_for_non_deterministic_runs(self, tmp_path, monkeypatch):
        """Subjective work may complete with same-model review warning only."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)

        from plugins.engineering_loop import tools as eloop_tools
        from plugins.engineering_loop.schemas import GateResult

        eloop_tools.reset_session_state()
        eloop_tools._handle_start(
            goal="same-model subjective review",
            acceptance_criteria=["review recorded"],
            loop_type="non_deterministic",
            task_source="test",
        )
        state = eloop_tools._get_state()
        assert state is not None
        state.verification_gates = [
            GateResult(
                gate_name="visual-review",
                command="manual-review",
                exit_code=0,
                passed=True,
                duration_seconds=0.1,
            )
        ]
        eloop_tools._save_state()

        result = eloop_tools._handle_check_termination(
            reviewer_response='{"verdict":"PASS","feedback":"ok","action_items":[]}',
            reviewer_model="main-model",
            main_model="main-model",
        )

        assert result.get("can_complete") is True
        assert result.get("warnings")
        assert any("same model" in warning.lower() for warning in result["warnings"])
        assert not any("same model" in issue.lower() for issue in result.get("issues", []))

    def test_start_force_finalizes_stale_active_run(self, tmp_path, monkeypatch):
        """Force start should archive/finalize a stale active run."""
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.chdir(tmp_path)

        from plugins.engineering_loop import tools as eloop_tools

        eloop_tools.reset_session_state()
        first = eloop_tools._handle_start(
            goal="stale run",
            acceptance_criteria=["exists"],
            loop_type="deterministic",
            task_source="test",
        )
        assert first.get("ok") is True

        second = eloop_tools._handle_start(
            goal="replacement run",
            acceptance_criteria=["created"],
            loop_type="deterministic",
            task_source="test",
            force=True,
        )

        assert second.get("ok") is True
        assert second.get("run_id") != first.get("run_id")
