from __future__ import annotations

from pathlib import Path

from agent.dox import check_project, init_project, status_project


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_status_inactive_without_marker(tmp_path):
    status = status_project(tmp_path)

    assert status["active"] is False
    assert status["mode"] is None
    assert status["layers"] == {"contract": False, "ledger": False, "publish": False}
    assert status["markers"] == {
        "docops_yml": False,
        "agents_md_header": False,
        "structural": [],
    }
    assert status["drift"] == []
    assert status["pending_advisories"] == 0
    assert status["last_publish"] is None


def test_docops_yml_mode_takes_precedence_over_structural_markers(tmp_path):
    _write(tmp_path / "docops.yml", "version: 1\nmode: ops\n")
    _write(tmp_path / "AGENTS.md", "# Project\n<!-- hermes-dox -->\n")
    _write(tmp_path / "dox" / "CHANGELOG.md", "# Changelog\n")

    status = status_project(tmp_path)

    assert status["active"] is True
    assert status["mode"] == "ops"
    assert status["layers"] == {"contract": True, "ledger": True, "publish": True}
    assert status["markers"]["docops_yml"] is True
    assert status["markers"]["agents_md_header"] is True


def test_check_write_reconciles_child_index_preserving_descriptions(tmp_path):
    _write(
        tmp_path / "docops.yml",
        "version: 1\n"
        "mode: code\n"
        "contract:\n"
        "  index:\n"
        "    - dir: agent\n"
        "      glob: '*.py'\n",
    )
    _write(tmp_path / "agent" / "keep.py", "KEEP = True\n")
    _write(tmp_path / "agent" / "new.py", "NEW = True\n")
    _write(
        tmp_path / "agent" / "AGENTS.md",
        "# Agent contract\n\n"
        "<!-- hermes-dox:index-start glob=\"*.py\" -->\n"
        "| Path | Description |\n"
        "| --- | --- |\n"
        "| keep.py | keep this human description |\n"
        "| stale.py | vanished |\n"
        "<!-- hermes-dox:index-end -->\n",
    )

    first = check_project(tmp_path, write=False)
    assert first.exit_code == 0
    assert {finding.kind for finding in first.findings} == {"child_index_stale"}

    written = check_project(tmp_path, write=True)
    assert written.exit_code == 0
    assert {finding.kind for finding in written.findings} == {"child_index_stale"}

    agents = (tmp_path / "agent" / "AGENTS.md").read_text(encoding="utf-8")
    assert "| keep.py | keep this human description |" in agents
    assert "| new.py | TODO: describe |" in agents
    assert "stale.py" not in agents

    clean = check_project(tmp_path, write=False)
    assert clean.exit_code == 0
    assert clean.findings == []


def test_size_gate_soft_blocks_unescaped_and_passes_with_pragma(tmp_path):
    _write(
        tmp_path / "docops.yml",
        "version: 1\nmode: code\nledger:\n  size_limit_words: 3\n",
    )
    changelog = _write(tmp_path / "dox" / "CHANGELOG.md", "one two three four\n")

    blocked = check_project(tmp_path)
    assert blocked.exit_code == 2
    assert [(finding.tier, finding.kind, finding.escaped) for finding in blocked.findings] == [
        ("B", "size_over_limit", False)
    ]

    changelog.write_text(
        "<!-- dox-allow-oversize: fixture needs long ledger -->\none two three four\n",
        encoding="utf-8",
    )
    escaped = check_project(tmp_path)
    assert escaped.exit_code == 0
    assert [(finding.tier, finding.kind, finding.escaped) for finding in escaped.findings] == [
        ("B", "size_over_limit", True)
    ]


def test_init_is_idempotent_and_seeds_contract_and_ledger(tmp_path):
    first = init_project(tmp_path, mode="code")
    before = {p.relative_to(tmp_path): p.read_bytes() for p in sorted(tmp_path.rglob("*")) if p.is_file()}

    second = init_project(tmp_path, mode="code")
    after = {p.relative_to(tmp_path): p.read_bytes() for p in sorted(tmp_path.rglob("*")) if p.is_file()}

    assert first["mode"] == "code"
    assert second["mode"] == "code"
    assert before == after
    assert (tmp_path / "docops.yml").exists()
    assert "<!-- hermes-dox -->" in (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
    assert (tmp_path / "dox" / "CHANGELOG.md").exists()


def test_status_default_does_not_walk_parents(tmp_path):
    init_project(tmp_path, mode="ops")
    subdir = tmp_path / "plans" / "workstream"
    subdir.mkdir(parents=True)

    status = status_project(subdir)
    assert status["active"] is False
    assert status["mode"] is None


def test_status_search_parents_resolves_initialized_ancestor(tmp_path):
    init_project(tmp_path, mode="ops")
    subdir = tmp_path / "plans" / "azure-alpha-remediation" / "reports"
    subdir.mkdir(parents=True)

    status = status_project(subdir, search_parents=True)

    assert status["active"] is True
    assert status["mode"] == "ops"
    assert Path(status["root"]) == tmp_path.resolve()


def test_status_search_parents_returns_start_when_no_ancestor(tmp_path):
    subdir = tmp_path / "nested" / "leaf"
    subdir.mkdir(parents=True)

    status = status_project(subdir, search_parents=True)

    assert status["active"] is False
    assert Path(status["root"]) == subdir.resolve()


def test_check_search_parents_runs_against_initialized_ancestor(tmp_path):
    init_project(tmp_path, mode="ops")
    subdir = tmp_path / "plans" / "workstream"
    subdir.mkdir(parents=True)

    report = check_project(subdir, search_parents=True)

    assert report.status["active"] is True
    assert report.status["mode"] == "ops"
    assert report.exit_code == 0
