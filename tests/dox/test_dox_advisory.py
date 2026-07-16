from __future__ import annotations

import json
from pathlib import Path

from hermes_constants import reset_hermes_home_override, set_hermes_home_override


def _with_hermes_home(path: Path):
    return set_hermes_home_override(path)


def test_meaningful_write_file_records_pending_advisory_under_hermes_home(tmp_path):
    from run_agent import AIAgent

    token = _with_hermes_home(tmp_path / "home")
    try:
        agent = AIAgent.__new__(AIAgent)
        agent.session_id = "sess-1"
        agent._turn_failed_file_mutations = {}
        agent._turn_file_mutation_paths = set()
        project = tmp_path / "project"
        project.mkdir()
        (project / "AGENTS.md").write_text("# Project\n<!-- hermes-dox -->\n", encoding="utf-8")

        agent._record_file_mutation_result(
            "write_file",
            {"path": str(tmp_path / "project" / "app.py"), "content": "print('hi')\n"},
            json.dumps({"bytes_written": 12}),
            is_error=False,
        )

        advisory_path = tmp_path / "home" / "dox" / "pending_advisories.jsonl"
        assert advisory_path.is_file()
        records = [json.loads(line) for line in advisory_path.read_text(encoding="utf-8").splitlines()]
        assert len(records) == 1
        assert records[0]["session_id"] == "sess-1"
        assert records[0]["reason"] == "meaningful_file_edit"
        assert records[0]["paths"] == [str(tmp_path / "project" / "app.py")]
    finally:
        reset_hermes_home_override(token)


def test_pending_advisory_injects_context_once_then_drains(tmp_path):
    from agent.conversation_loop import inject_turn_context
    from agent.dox import drain_pending_advisory_context, pending_advisory_count, record_pending_advisory

    token = _with_hermes_home(tmp_path / "home")
    try:
        changed = tmp_path / "project" / "src" / "worker.py"
        record_pending_advisory([changed], session_id="sess-1")
        assert pending_advisory_count() == 1

        first = drain_pending_advisory_context(session_id="sess-1")
        assert "DOX pending advisory" in first
        assert "src" in first
        assert "worker.py" in first
        assert "hermes dox status" in first
        assert pending_advisory_count() == 0

        second = drain_pending_advisory_context(session_id="sess-1")
        assert second == ""

        api_msg = {"role": "user", "content": "continue"}
        agent = type("Agent", (), {"_memory_manager": None, "session_id": "sess-1"})()
        inject_turn_context(api_msg, "", first, agent)
        assert "continue" in api_msg["content"]
        assert "DOX pending advisory" in api_msg["content"]
    finally:
        reset_hermes_home_override(token)
