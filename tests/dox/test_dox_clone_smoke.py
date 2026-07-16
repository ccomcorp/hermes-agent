from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from hermes_cli import dox as dox_cli


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = REPO_ROOT / "tests" / "fixtures" / "dox-ops-project"
FORBIDDEN_FIXTURE_TOKENS = (
    "AIOS/",
    "dox-index.cjs",
    "dox-check.cjs",
    "dox-shape.cjs",
    "_envelope.cjs",
    "dox-advisories.cjs",
    "dox-inject.cjs",
    "packages/constraints",
    "packages/journal",
    "gbrain",
)


def _run_cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="hermes")
    sub = parser.add_subparsers(dest="command")
    dox_cli.build_parser(sub, cmd_dox=dox_cli.dox_command)
    args = parser.parse_args(["dox", *argv])
    return dox_cli.dox_command(args)


def _copy_fixture(tmp_path: Path) -> Path:
    target = tmp_path / "clone"
    shutil.copytree(FIXTURE_ROOT, target)
    return target


def _assert_fixture_has_no_forbidden_tokens() -> None:
    hits: list[tuple[str, str]] = []
    for path in sorted(FIXTURE_ROOT.rglob("*")):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for token in FORBIDDEN_FIXTURE_TOKENS:
            if token in text:
                hits.append((path.relative_to(FIXTURE_ROOT).as_posix(), token))
    assert hits == []


def _snapshot(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def test_ops_fixture_clone_smoke_init_check_is_zero_aios(tmp_path, capsys):
    """A generic non-Hermes project can opt into ops DOX and pass init/check."""

    assert FIXTURE_ROOT.is_dir()
    _assert_fixture_has_no_forbidden_tokens()
    clone = _copy_fixture(tmp_path)

    assert _run_cli(["status", "--root", str(clone)]) == 0
    assert json.loads(capsys.readouterr().out)["active"] is False

    assert _run_cli(["init", "--root", str(clone), "--mode", "ops"]) == 0
    init_out = capsys.readouterr().out
    assert "initialized DOX" in init_out

    assert (clone / "docops.yml").is_file()
    assert (clone / "AGENTS.md").is_file()
    assert (clone / "dox" / "CHANGELOG.md").is_file()
    assert (clone / "dox" / "session-log.md").is_file()
    assert (clone / "LIVE-STATUS.md").is_file()
    assert (clone / "docs" / "standards" / "DOCUMENT-MANAGEMENT.md").is_file()
    assert (clone / "reports" / "_canvas" / "index.html").is_file()
    assert not (clone / "reports" / "_canvas" / "package.json").exists()

    assert _run_cli(["check", "--root", str(clone), "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["active"] is True
    assert payload["mode"] == "ops"
    assert payload["layers"] == {"contract": True, "ledger": True, "publish": True}
    assert payload["drift"] == []

    before = _snapshot(clone)
    assert _run_cli(["init", "--root", str(clone), "--mode", "ops"]) == 0
    capsys.readouterr()
    assert _snapshot(clone) == before
