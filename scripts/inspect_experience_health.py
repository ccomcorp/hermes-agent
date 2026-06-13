#!/usr/bin/env python3
"""Read-only experience-store health inspector (rung-3 live validation).

Prints the AC1 circulation report over the ACTIVE HERMES_HOME's experience.db. NEVER writes.
Use it between/after live sessions to watch AC1 move (circulation > 0 = a fork-authored lesson
was recalled into a CONSUMED context) and to read the anti-invisibility flags.

Run:  python scripts/inspect_experience_health.py
Exit 0 = report printed; 1 = no experience.db yet (composite not active / no writes).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# AIOS health + store packages (sibling layout, env-overridable — mirrors the composite plugin).
_root = (
    Path(os.environ["AIOS_PACKAGES_DIR"])
    if os.environ.get("AIOS_PACKAGES_DIR")
    else Path(__file__).resolve().parents[1].parent / "aios" / "packages" / "memory"
)
for _d in (_root / "experience-store", _root.parent / "health"):
    if _d.is_dir() and str(_d) not in sys.path:
        sys.path.insert(0, str(_d))

from experience_health import ExperienceHealth  # noqa: E402  (path inserted above)


def _hermes_home() -> str:
    try:
        from hermes_constants import get_hermes_home

        return str(get_hermes_home())
    except Exception:
        return os.path.expandvars(os.path.join("%LOCALAPPDATA%", "hermes"))


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    db = os.path.join(_hermes_home(), "experience.db")
    if not os.path.exists(db):
        print(f"no experience.db at {db}")
        print("  -> composite is not the active provider yet, or it has not written/recalled.")
        return 1
    health = ExperienceHealth(db_path=db)
    print(f"experience.db: {db}")
    print(health.summary())
    print(json.dumps(health.circulation_report(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
