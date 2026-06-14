"""AC-PX3b — override-removal regression guard (loop-plugin-extraction STEP 1 / S2).

After S2 (set ``consume_on_inject=True``, drop the subclass ``prefetch`` /
``confirm_prefetch_consumed`` overrides, retain a THIN subclass override freeing
``_last_observation``), a dropped-injection turn followed by a session switch/end must
leave NEITHER pending map orphaned:

  * ``_pending_prefetch`` — now BASE-served (base ``on_session_switch`` / ``on_session_end``
    pop it). Proves the base cleanup still fires through ``super()``.
  * ``_last_observation`` — RETAINED thin subclass override. We stash a fake entry to prove
    the subclass-only cleanup still fires after the override was reduced to call ``super()``.

A dropped-injection turn = a ``prefetch`` that stashed a pending receipt but was never
``confirm_prefetch_consumed`` (the block never reached the dispatched prompt).
"""

from __future__ import annotations

import pytest

try:
    from plugins.memory.composite.provider import ExperienceStore, HermesCompositeProvider

    _HAVE_AIOS = True
except Exception:  # pragma: no cover - sibling AIOS repo absent
    _HAVE_AIOS = False

pytestmark = pytest.mark.skipif(not _HAVE_AIOS, reason="AIOS composite/store not importable")


def _comp(session_id):
    store = ExperienceStore(db_path=":memory:")
    comp = HermesCompositeProvider(store, brain=None, vault=None, owns_brain=False)
    comp.initialize(session_id, agent_context="primary")
    comp.record_fork_lesson(
        "Clear the zorblat lock before retrying the deploy.",
        provenance="fork:background_review:s",
        task_type="workflow",
    )
    return store, comp


def test_session_switch_frees_both_pending_maps_after_dropped_injection():
    """Dropped-injection turn on the leaving session, then on_session_switch(child,
    parent_session_id=old): base frees _pending_prefetch, thin subclass override frees
    _last_observation. Neither orphans an entry for the leaving session."""
    store, comp = _comp("old")

    # Dropped-injection turn: prefetch stashes a pending receipt but is NEVER confirmed.
    ctx = comp.prefetch("zorblat lock retry", session_id="old")
    assert ctx  # recall hit -> a pending receipt was stashed
    assert comp._pending_prefetch.get("old") is not None
    assert store.circulation() == 0  # never confirmed -> never consumed

    # Stash a fake brain observation to prove the subclass-only cleanup still fires.
    comp._last_observation["old"] = "obs-fake-123"

    comp.on_session_switch("child", parent_session_id="old")

    # BASE-served cleanup: _pending_prefetch no longer orphans the leaving session.
    assert "old" not in comp._pending_prefetch
    # RETAINED subclass cleanup: _last_observation no longer orphans the leaving session.
    assert "old" not in comp._last_observation
    # Dropped block stayed uncounted throughout.
    assert store.circulation() == 0


def test_session_end_frees_both_pending_maps_after_dropped_injection():
    """Dropped-injection turn, then on_session_end: base frees _pending_prefetch for the
    current session, thin subclass override frees _last_observation."""
    store, comp = _comp("cur")

    ctx = comp.prefetch("zorblat lock retry", session_id="cur")
    assert ctx
    assert comp._pending_prefetch.get("cur") is not None

    comp._last_observation["cur"] = "obs-fake-456"

    comp.on_session_end(messages=[])

    assert "cur" not in comp._pending_prefetch  # base-served pop
    assert "cur" not in comp._last_observation  # retained subclass pop
    assert store.circulation() == 0
