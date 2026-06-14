"""Put the sibling AIOS composite-provider / experience-store dirs on sys.path so the
flat modules (``backends``, ``composite_provider``, ``store``) import in tests — the same
resolution ``provider.py`` performs at plugin-load (overridable via ``AIOS_PACKAGES_DIR``).
"""

import os
import sys
from pathlib import Path

_HERMES = Path(__file__).resolve().parents[4]          # .../hermes-agent
_ROOT = Path(os.environ.get("AIOS_PACKAGES_DIR") or (_HERMES.parent / "aios" / "packages" / "memory"))

for _sub in ("composite-provider", "experience-store"):
    _d = str(_ROOT / _sub)
    if _d not in sys.path:
        sys.path.insert(0, _d)
