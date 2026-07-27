"""Pytest path bootstrap for the vendor-native composite core tests (M0-B1).

Puts only the AIOS experience-store package dir on sys.path — the store (B2) has
not been ported yet. The composite *core* (composite_provider + backends) imports
natively from ``plugins.memory.composite.core`` — no sys.path hack needed for the
engine being tested.

The AIOS composite-provider dir is intentionally NOT on the path: the tests import
directly from ``plugins.memory.composite.core``, proving the vendor copy works.
"""

import os
import sys

_AIOS_ROOT = os.environ.get("AIOS_PACKAGES_DIR")
if not _AIOS_ROOT:
    # Default sibling-checkout path: hermes-agent is at <AIOS>/hermes-agent,
    # AIOS packages are at <AIOS>/AIOS/packages/memory/experience-store
    _HERE = os.path.dirname(os.path.abspath(__file__))
    _HERMES = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", ".."))
    _AIOS_ROOT = os.path.join(os.path.dirname(_HERMES), "AIOS", "packages", "memory")

_STORE_DIR = os.path.join(_AIOS_ROOT, "experience-store")
if os.path.isdir(_STORE_DIR) and _STORE_DIR not in sys.path:
    sys.path.insert(0, _STORE_DIR)
