"""`hermes dox` CLI for Hermes-native DocOps."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Callable

from agent.dox import DoxError, check_project, init_project, status_project
from agent.dox.closeout import closeout_dry_run


def build_parser(
    parent_subparsers: argparse._SubParsersAction,
    *,
    cmd_dox: Callable[[argparse.Namespace], int],
) -> argparse.ArgumentParser:
    """Attach the ``dox`` subcommand tree. Returns the top parser."""
    parser = parent_subparsers.add_parser(
        "dox",
        help="Check and initialize Hermes DocOps project markers",
        description=(
            "Hermes-native DocOps (DOX): marker detection, AGENTS.md index "
            "checks, ledger size gates, and report-pack health."
        ),
    )
    sub = parser.add_subparsers(dest="dox_command")

    p_init = sub.add_parser("init", help="Scaffold docops.yml and DOX support files")
    p_init.add_argument("--root", default=".", help="Project root (default: current directory)")
    p_init.add_argument("--mode", choices=("code", "ops", "hybrid"), default=None)

    p_check = sub.add_parser("check", help="Run deterministic DOX checks")
    p_check.add_argument("--root", default=".", help="Project root (default: current directory)")
    p_check.add_argument("--write", action="store_true", help="Apply Tier-A mechanical fixes")
    p_check.add_argument("--json", action="store_true", help="Emit machine-readable JSON")

    p_status = sub.add_parser("status", help="Emit the stable DOX status JSON contract")
    p_status.add_argument("--root", default=".", help="Project root (default: current directory)")

    p_closeout = sub.add_parser("closeout", help="Dry-run the ordered DOX closeout cascade")
    p_closeout.add_argument("--root", default=".", help="Project root (default: current directory)")
    p_closeout.add_argument("--mode", choices=("code", "ops", "hybrid"), default=None)
    p_closeout.add_argument("--dry-run", action="store_true", help="Return the report-only cascade plan")

    parser.set_defaults(func=cmd_dox, _dox_parser=parser)
    return parser


def _print_json(payload: dict) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def _print_check_text(payload: dict) -> None:
    state = "active" if payload.get("active") else "inactive"
    mode = payload.get("mode") or "none"
    print(f"DOX {state} (mode: {mode})")
    drift = payload.get("drift") or []
    if not drift:
        print("drift: none")
        return
    print("drift:")
    for finding in drift:
        escaped = " escaped" if finding.get("escaped") else ""
        print(f"  [{finding['tier']}] {finding['path']}: {finding['kind']}{escaped}")


def dox_command(args: argparse.Namespace) -> int:
    """Entry point from ``hermes dox …`` argparse dispatch."""
    command = getattr(args, "dox_command", None)
    if not command:
        parser = getattr(args, "_dox_parser", None)
        if parser is not None:
            parser.print_help()
        return 0

    root = Path(getattr(args, "root", "."))
    try:
        if command == "init":
            result = init_project(root, mode=getattr(args, "mode", None))
            print(f"initialized DOX at {result['root']} (mode: {result['mode']})")
            return 0
        if command == "status":
            _print_json(status_project(root))
            return 0
        if command == "closeout":
            _print_json(closeout_dry_run(root, mode=getattr(args, "mode", None)))
            return 0
        if command == "check":
            report = check_project(root, write=getattr(args, "write", False))
            payload = report.to_dict()
            if getattr(args, "json", False):
                _print_json(payload)
            else:
                _print_check_text(payload)
            return report.exit_code
    except DoxError as exc:
        print(f"dox: {exc}", file=sys.stderr)
        return exc.exit_code

    print(f"Unknown dox command: {command}", file=sys.stderr)
    return 1
