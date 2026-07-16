from __future__ import annotations

import argparse
import json
from pathlib import Path

from hermes_cli import dox as dox_cli


def _run(argv):
    parser = argparse.ArgumentParser(prog="hermes")
    sub = parser.add_subparsers(dest="command")
    dox_cli.build_parser(sub, cmd_dox=dox_cli.dox_command)
    args = parser.parse_args(["dox", *argv])
    return dox_cli.dox_command(args)


def test_status_emits_json_contract_for_inactive_root(tmp_path, capsys):
    assert _run(["status", "--root", str(tmp_path)]) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["active"] is False
    assert payload["mode"] is None
    assert payload["layers"] == {"contract": False, "ledger": False, "publish": False}
    assert payload["markers"] == {
        "docops_yml": False,
        "agents_md_header": False,
        "structural": [],
    }
    assert payload["drift"] == []
    assert payload["pending_advisories"] == 0
    assert payload["last_publish"] is None


def test_init_then_check_fixture_root(tmp_path, capsys):
    assert _run(["init", "--root", str(tmp_path), "--mode", "code"]) == 0
    init_out = capsys.readouterr().out
    assert "initialized" in init_out

    assert _run(["check", "--root", str(tmp_path), "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["active"] is True
    assert payload["mode"] == "code"
    assert payload["drift"] == []


def test_check_returns_distinct_code_for_malformed_marker(tmp_path):
    (tmp_path / "docops.yml").write_text("version: 1\nmode: code\n", encoding="utf-8")
    (tmp_path / "AGENTS.md").write_text(
        "<!-- hermes-dox -->\n<!-- hermes-dox:index-start glob=\"*.py\" -->\n",
        encoding="utf-8",
    )

    assert _run(["check", "--root", str(tmp_path)]) == 3


def test_build_parser_wires_dispatch_func():
    parser = argparse.ArgumentParser(prog="hermes")
    sub = parser.add_subparsers(dest="command")

    def sentinel(args):  # pragma: no cover - identity only
        return "handled"

    dox_cli.build_parser(sub, cmd_dox=sentinel)
    ns = parser.parse_args(["dox", "status", "--root", str(Path.cwd())])

    assert ns.command == "dox"
    assert ns.dox_command == "status"
    assert ns.func is sentinel
