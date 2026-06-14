"""AC-PX4 — the four optional loop-seam hooks on MemoryProvider are additive no-ops.

A provider subclass that implements NONE of the loop seams still constructs and the
default hook bodies return their documented neutral values (backward compat). The
MemoryManager fan-out over such a provider is a clean no-op.
"""

from __future__ import annotations

from agent.memory_manager import MemoryManager
from agent.memory_provider import MemoryProvider


class _BareProvider(MemoryProvider):
    """Implements only the abstract surface — none of the optional loop seams."""

    @property
    def name(self) -> str:
        return "bare"

    def is_available(self) -> bool:
        return True

    def initialize(self, session_id: str, **kwargs) -> None:
        pass

    def get_tool_schemas(self):
        return []


def test_bare_provider_constructs_and_defaults_are_neutral():
    p = _BareProvider()
    assert p.name == "bare"
    # Default hook bodies: documented neutral values.
    assert p.confirm_prefetch_consumed() is False
    assert p.confirm_prefetch_consumed(session_id="s") is False
    assert p.on_background_review([], session_id="s") == 0
    assert p.on_background_review([{"lesson": "x"}]) == 0
    assert p.recall_for_delegation("goal") == ("", None)
    assert p.recall_for_delegation("goal", session_id="s") == ("", None)
    assert p.confirm_consumed("rid") is None


def test_manager_fanout_over_bare_provider_is_noop():
    mgr = MemoryManager()
    mgr.add_provider(_BareProvider())

    # None of the seams produce side effects or raise against a provider that opts out.
    assert mgr.on_background_review([{"lesson": "y"}], session_id="s") == 0
    assert mgr.recall_for_delegation("goal", session_id="s") == ("", None)
    mgr.confirm_consumed("rid")  # no-op, no raise
