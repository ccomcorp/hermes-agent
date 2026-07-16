from __future__ import annotations

import argparse
import json

from agent.dox.closeout import closeout_dry_run
from hermes_cli import dox as dox_cli


def _write(path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _step_names(payload: dict) -> list[str]:
    return [step["step"] for step in payload["steps"]]


def _run_cli(argv):
    parser = argparse.ArgumentParser(prog="hermes")
    sub = parser.add_subparsers(dest="command")
    dox_cli.build_parser(sub, cmd_dox=dox_cli.dox_command)
    args = parser.parse_args(["dox", *argv])
    return dox_cli.dox_command(args)


def test_code_mode_closeout_steps_match_schema_section_4_1(tmp_path):
    _write(tmp_path / "docops.yml", "version: 1\nmode: code\n")

    payload = closeout_dry_run(tmp_path)

    assert payload["dry_run"] is True
    assert payload["mode"] == "code"
    assert _step_names(payload) == [
        "read_contract",
        "update_nearest_agents_md",
        "reconcile_child_index",
        "append_ledger",
        "size_gate",
    ]
    assert [step["auto"] for step in payload["steps"]] == [None, False, True, False, True]


def test_ops_mode_closeout_steps_match_schema_section_4_2(tmp_path):
    _write(tmp_path / "docops.yml", "version: 1\nmode: ops\n")

    payload = closeout_dry_run(tmp_path)

    assert payload["mode"] == "ops"
    assert _step_names(payload) == [
        "read_contract",
        "update_live_status",
        "update_checklist",
        "append_session_log",
        "append_ledger",
        "render_html",
        "refresh_manifest",
        "update_canvas_pointer",
        "size_gate",
    ]
    assert [step["auto"] for step in payload["steps"]] == [
        None,
        False,
        False,
        False,
        False,
        True,
        True,
        True,
        True,
    ]


def test_closeout_dry_run_is_report_only_and_does_not_create_changelog(tmp_path):
    _write(tmp_path / "docops.yml", "version: 1\nmode: code\n")

    payload = closeout_dry_run(tmp_path)

    assert _step_names(payload)
    assert not (tmp_path / "dox" / "CHANGELOG.md").exists()


def test_closeout_uses_docops_cascade_steps_override(tmp_path):
    _write(
        tmp_path / "docops.yml",
        "version: 1\n"
        "mode: code\n"
        "cascade:\n"
        "  steps:\n"
        "    - step: read_contract\n"
        "      auto: false\n"
        "    - step: custom_review\n"
        "      auto: true\n",
    )

    payload = closeout_dry_run(tmp_path)

    assert _step_names(payload) == ["read_contract", "custom_review"]
    assert [step["auto"] for step in payload["steps"]] == [False, True]


def test_cli_closeout_dry_run_emits_ordered_json_steps(tmp_path, capsys):
    _write(tmp_path / "docops.yml", "version: 1\nmode: ops\n")

    assert _run_cli(["closeout", "--root", str(tmp_path), "--dry-run"]) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["dry_run"] is True
    assert payload["mode"] == "ops"
    assert _step_names(payload)[:3] == ["read_contract", "update_live_status", "update_checklist"]
    assert not (tmp_path / "dox" / "CHANGELOG.md").exists()
