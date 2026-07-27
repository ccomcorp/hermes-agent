"""Vendor-native composite memory provider core (M0-B1).

The AIOS composite engine ported into hermes-agent as a native package —
no sys.path hack, no sibling-checkout dependency, no _base_shim fallback.
The store (ExperienceStore) is still injected; B2 ports the store.

Subclass HermesCompositeProvider (provider.py) still bridges the chassis
plugin-loader contract; this core is the portable provider engine.
"""

from .composite_provider import CompositeMemoryProvider, SESSION_START_CALL_SITE, TOOL_SIGNAL, TOOL_FORGET
from .backends import BrainClient, VaultCache, BRAIN_OK, BRAIN_DEGRADED, BRAIN_FAIL

__all__ = [
    "CompositeMemoryProvider",
    "SESSION_START_CALL_SITE",
    "TOOL_SIGNAL",
    "TOOL_FORGET",
    "BrainClient",
    "VaultCache",
    "BRAIN_OK",
    "BRAIN_DEGRADED",
    "BRAIN_FAIL",
]
