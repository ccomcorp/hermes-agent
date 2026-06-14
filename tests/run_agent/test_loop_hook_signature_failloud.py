"""AC-PX5 #4: signature-mismatch fail-loud in the MemoryManager loop-seam fan-out.

A provider that HAS a loop hook but with a WRONG signature (a half-ported provider) must NOT
be silently swallowed — the fan-out raises LoopHookSignatureError. This is DISTINCT from a
provider that simply doesn't implement the hook (clean skip via the capability guard) and from
a provider whose hook body raises internally (best-effort, stays non-fatal).
"""

from __future__ import annotations

import pytest

from agent.memory_manager import LoopHookSignatureError, MemoryManager


class _BadSigProvider:
    """Exposes the hook NAMES but with incompatible signatures (half-ported)."""

    name = "badsig"

    def is_available(self):
        return True

    # Wrong: takes no args at all -> cannot bind the chassis call.
    def on_background_review(self):  # noqa: D401
        return 0

    def recall_for_delegation(self):
        return ("", None)

    def confirm_consumed(self):
        return None

    def confirm_prefetch_consumed(self):
        return False


class _NoHookProvider:
    """Implements none of the loop hooks (a foreign provider) -> clean skip."""

    name = "foreign"

    def is_available(self):
        return True


class _BodyRaisesProvider:
    """Correct signatures, but the body raises -> best-effort (non-fatal), not a sig error."""

    name = "bodyraises"

    def is_available(self):
        return True

    def on_background_review(self, lesson_candidates, *, session_id=""):
        raise RuntimeError("store append blew up internally")


def _mgr(provider):
    # Register the provider directly on the fan-out list — bypassing add_provider's tool-schema
    # routing (not needed here; these stubs exercise only the loop-seam fan-out signature guard).
    m = MemoryManager()
    m._providers.append(provider)
    return m


def test_wrong_signature_on_background_review_raises():
    m = _mgr(_BadSigProvider())
    with pytest.raises(LoopHookSignatureError) as exc:
        m.on_background_review([{"lesson": "x", "provenance": "p"}], session_id="s")
    assert "on_background_review" in str(exc.value)


def test_wrong_signature_recall_for_delegation_raises():
    m = _mgr(_BadSigProvider())
    with pytest.raises(LoopHookSignatureError):
        m.recall_for_delegation("goal", session_id="s")


def test_wrong_signature_confirm_consumed_raises():
    m = _mgr(_BadSigProvider())
    with pytest.raises(LoopHookSignatureError):
        m.confirm_consumed("rid")


def test_wrong_signature_confirm_prefetch_consumed_raises():
    m = _mgr(_BadSigProvider())
    with pytest.raises(LoopHookSignatureError):
        m.confirm_prefetch_consumed(session_id="s")


def test_foreign_provider_clean_skip():
    """No hooks implemented -> clean no-op, never a signature error (AC-PX4 backward-compat)."""
    m = _mgr(_NoHookProvider())
    assert m.on_background_review([{"lesson": "x", "provenance": "p"}], session_id="s") == 0
    assert m.recall_for_delegation("goal", session_id="s") == ("", None)
    assert m.confirm_consumed("rid") is None
    assert m.confirm_prefetch_consumed(session_id="s") is None


def test_body_raises_is_best_effort_not_signature_error():
    """A correctly-signatured hook whose BODY raises stays non-fatal (returns 0), not loud."""
    m = _mgr(_BodyRaisesProvider())
    # Must NOT raise LoopHookSignatureError; the internal RuntimeError is swallowed/warned.
    assert m.on_background_review([{"lesson": "x", "provenance": "p"}], session_id="s") == 0
