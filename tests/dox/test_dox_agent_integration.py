from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent.prompt_builder import build_context_files_prompt
from agent.subdirectory_hints import SubdirectoryHintTracker


REPO_ROOT = Path(__file__).resolve().parents[2]
DOX_SKILL_PATH = REPO_ROOT / "skills" / "devops" / "hermes-dox" / "SKILL.md"


def test_dox_skill_is_bundled_and_loadable(monkeypatch, tmp_path):
    assert DOX_SKILL_PATH.is_file()

    import tools.skills_tool as skills_tool

    monkeypatch.setattr(skills_tool, "SKILLS_DIR", REPO_ROOT / "skills")
    monkeypatch.setattr(skills_tool, "HERMES_HOME", tmp_path / "hermes_home")

    payload = json.loads(skills_tool.skill_view("devops/hermes-dox"))

    assert payload["success"] is True
    assert payload["name"] == "hermes-dox"
    assert Path(payload["path"]).as_posix() == "devops/hermes-dox/SKILL.md"
    assert len(payload["description"]) <= 60
    content = payload["content"]
    assert "terminal" in content
    assert "hermes dox" in content
    assert "read_file" in content
    assert "patch" in content


def test_dox_headed_agents_md_injects_skill_and_closeout_guidance(tmp_path):
    (tmp_path / "AGENTS.md").write_text(
        "# Project contract\n\n<!-- hermes-dox -->\n\nUse Ruff.\n",
        encoding="utf-8",
    )

    prompt = build_context_files_prompt(cwd=str(tmp_path), skip_soul=True)

    assert "Use Ruff" in prompt
    assert "Hermes DOX protocol" in prompt
    assert "skill_view(name='devops/hermes-dox')" in prompt
    assert "closeout cascade" in prompt
    assert "hermes dox status" in prompt


def test_non_dox_agents_md_does_not_inject_dox_guidance(tmp_path):
    (tmp_path / "AGENTS.md").write_text("# Project contract\n\nUse Ruff.\n", encoding="utf-8")

    prompt = build_context_files_prompt(cwd=str(tmp_path), skip_soul=True)

    assert "Use Ruff" in prompt
    assert "Hermes DOX protocol" not in prompt
    assert "hermes-dox" not in prompt


def test_subdirectory_dox_headed_agents_md_injects_protocol_once(tmp_path):
    (tmp_path / "AGENTS.md").write_text("Root instructions\n", encoding="utf-8")
    sub = tmp_path / "package"
    sub.mkdir()
    (sub / "AGENTS.md").write_text(
        "# Package contract\n\nDOX: enabled\n\nPackage rules.\n",
        encoding="utf-8",
    )
    (sub / "module.py").write_text("VALUE = 1\n", encoding="utf-8")

    tracker = SubdirectoryHintTracker(working_dir=str(tmp_path))
    first = tracker.check_tool_call("read_file", {"path": str(sub / "module.py")})
    second = tracker.check_tool_call("read_file", {"path": str(sub / "module.py")})

    assert first is not None
    assert "Package rules" in first
    assert "Hermes DOX protocol" in first
    assert "closeout cascade" in first
    assert second is None
