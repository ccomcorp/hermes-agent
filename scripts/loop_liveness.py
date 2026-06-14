#!/usr/bin/env python3
"""Loop-liveness gate (AC-PX6) — the post-upstream-merge tripwire.

Thin wrapper that runs the canonical loop-liveness regression
``synthetic_week_ac1.py --fingerprint``: it re-proves the real fork->store->recall->consume
loop circulates (circulation>0) AND that the AC-PX5 #1 seam sentinels still resolve. A non-zero
exit means the loop seams MOVED (a chassis refactor / mis-applied merge) or circulation broke —
fix before proceeding.

Run after EVERY upstream merge (the local-is-truth update flow, docs/Update-Instructions/):

    python scripts/loop_liveness.py

Exit 0 = loop live + seams intact; non-zero = the loop regressed.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))


def main() -> int:
    # Reuse synthetic_week_ac1's main() in --fingerprint mode (single-sourced; no duplicate
    # replay logic). Force the flag on regardless of argv so this entrypoint always gates both.
    # scripts/ is not a package, so load the sibling module by path.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "synthetic_week_ac1", str(Path(__file__).resolve().parent / "synthetic_week_ac1.py")
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)

    if "--fingerprint" not in sys.argv:
        sys.argv.append("--fingerprint")
    return mod.main()


if __name__ == "__main__":
    raise SystemExit(main())
