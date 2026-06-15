"""Tests for engineering loop state persistence (state.py)."""

from __future__ import annotations

import json

from plugins.engineering_loop.schemas import (
    EngineeringRunState,
    GateResult,
    FailureRecord,
    LoopType,
    RunPhase,
    FailureClass,
    ReviewerResult,
    ReviewerStatus,
)
from plugins.engineering_loop.state import StateManager


class TestStateCRUD:
    """Create, load, update, and finalize run state."""

    def test_create_new_state(self, state_manager, temp_project):
        """Creating a new state initializes defaults and persists."""
        state = state_manager.create(
            goal="Implement feature X",
            loop_type="deterministic",
            acceptance_criteria=["AC1: Tests pass"],
        )
        assert state.run_id.startswith("erun-")
        assert state.goal == "Implement feature X"
        assert state.loop_type == "deterministic"
        assert state.acceptance_criteria == ["AC1: Tests pass"]
        assert state.active is True
        assert state.created_at > 0

        # Verify it's on disk
        loaded = state_manager.load()
        assert loaded is not None
        assert loaded.run_id == state.run_id

    def test_load_nonexistent(self, state_manager):
        """Loading when no state exists returns None."""
        assert state_manager.load() is None

    def test_save_and_reload_roundtrip(self, state_manager, sample_state):
        """State survives a full save/load cycle with all fields."""
        sample_state.phase = RunPhase.ACT.value
        sample_state.iteration_count = 42
        sample_state.changed_files = ["src/main.py", "tests/test_main.py"]

        state_manager.save(sample_state)
        loaded = state_manager.load()

        assert loaded is not None
        assert loaded.run_id == sample_state.run_id
        assert loaded.phase == "act"
        assert loaded.iteration_count == 42
        assert loaded.changed_files == sample_state.changed_files

    def test_finalize_marks_inactive(self, state_manager, sample_state):
        """Finalize sets active=False and completed_at."""
        state_manager.save(sample_state)
        state_manager.finalize(sample_state)

        assert sample_state.active is False
        assert sample_state.completed_at > 0

        # Reload and verify
        loaded = state_manager.load()
        assert loaded is not None
        assert loaded.active is False


class TestEventLog:
    """JSONL event append and recovery."""

    def test_append_and_read_events(self, state_manager):
        """Events append correctly and can be read back."""
        state_manager.append_event("test_event", {"ok": True, "value": 42})
        state_manager.append_event("another_event", {"x": 1})

        events = list(state_manager.iter_events())
        assert len(events) >= 2
        event_types = [e["type"] for e in events]
        assert "test_event" in event_types
        assert "another_event" in event_types

    def test_recovery_from_corrupt_last_line(self, state_manager):
        """JSONL reader skips corrupt last lines instead of crashing."""
        state_manager.append_event("good_event", {"ok": True})

        # Append garbage to the file
        with open(state_manager.events_path, "a", encoding="utf-8") as f:
            f.write("this is not valid json at all\n")

        events = list(state_manager.iter_events())
        # Should still read the good event
        assert len(events) >= 1
        assert events[0]["type"] == "good_event"

    def test_recovery_from_empty_file(self, state_manager):
        """Empty or new event files are handled gracefully."""
        # No events written — iter should be empty
        events = list(state_manager.iter_events())
        assert events == []


class TestGateResults:
    """Gate result persistence."""

    def test_save_and_load_gate_results(self, state_manager, sample_gate_result):
        """Gate results persist to verification.json."""
        results = [sample_gate_result]
        state_manager.save_gate_results(results)

        loaded = state_manager.load_gate_results()
        assert len(loaded) == 1
        assert loaded[0]["gate_name"] == "unit"
        assert loaded[0]["passed"] is True

    def test_load_empty_gate_results(self, state_manager):
        """Loading when no gate results exist returns empty list."""
        assert state_manager.load_gate_results() == []


class TestHeaderGeneration:
    """Compact header generation for context injection."""

    def test_header_with_active_run(self, state_manager, sample_state):
        """Header includes goal, criteria, phase, and next actions."""
        sample_state.phase = RunPhase.OBSERVE.value
        state_manager.save(sample_state)

        header = state_manager.build_header(sample_state)
        rendered = header.render()

        assert "Engineering Run Status" in rendered
        assert sample_state.goal in rendered
        assert "observe" in rendered.lower()

    def test_header_shows_failures(self, state_manager, sample_state):
        """Header reflects recent failures."""
        sample_state.failures = [
            FailureRecord(
                failure_class="unit_test",
                command="pytest tests/",
                message="AssertionError: expected 5, got 6",
                fingerprint="abc123",
                occurred_at=1.0,
            )
        ]
        state_manager.save(sample_state)

        header = state_manager.build_header(sample_state)
        assert "unit_test" in header.last_failure

    def test_header_shows_stuck_warning(self, state_manager, sample_state):
        """Header's next_action warns about stuck state."""
        sample_state.stuck_signals = ["STUCK: Same failure repeated 3 times"]
        state_manager.save(sample_state)

        header = state_manager.build_header(sample_state)
        assert "STUCK" in header.next_action
