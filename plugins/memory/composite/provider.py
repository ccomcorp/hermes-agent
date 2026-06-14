"""Composite memory provider plugin — dev-instance wiring for the AIOS experience store.

This is the thin chassis-side binding described in
``packages/memory/composite-provider/INTEGRATION.md`` (AIOS repo). The routing /
composition engine and the store engine both live in the AIOS repo and are unit-tested
there; nothing here re-implements them. This module only:

  1. Puts the two AIOS packages on ``sys.path`` so the chassis can import them.
  2. Subclasses ``CompositeMemoryProvider`` with ``record_fork_lesson()`` — the
     fork-authored append seam consumed by ``agent/background_review.py`` (M1 Task 2
     BLOCKER #2: without a fork→store write, ``store.circulation()`` has no
     ``migrated=0`` rows to count and AC1's numerator is structurally 0).
  3. Builds the provider with ``owns_brain=False`` — shutdown() must never close a
     shared HTTP client it did not create.
  4. DEFERS the ``ExperienceStore`` open to ``initialize()`` so a read-only discovery probe
     creates no sqlite connection / no ``experience.db`` (D1).

The brain leg is now wireable and STAGED via ``HERMES_BRAIN_STAGE`` (0=off default /
1=observe+recall / 2=+paired reward); stage 0 keeps the live agent byte-for-byte unchanged.
The vault leg is still absent (``vault=None``). The ``sync_turn`` ack reports a leg by its
ACTUAL presence/stage (R9 — never a healthy-looking status for a leg that was never
constructed): an absent leg is ``"skipped"``, the active brain leg is ``"observe-only"``
(reward is outcome-gated in ``handle_tool_call``, never per-turn).
"""

from __future__ import annotations

import concurrent.futures
import json
import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# --- 1. Put the AIOS packages on the chassis path -------------------------------------
def _resolve_aios_package_dirs():
    """Return ``(experience-store dir, composite-provider dir)`` or raise an ACTIONABLE
    ``ImportError`` naming ``AIOS_PACKAGES_DIR`` when the sibling AIOS checkout is missing (R8).

    Repos are siblings: ``<AIOS>/hermes-agent`` and ``<AIOS>/aios``; resolve relative to this
    file (``parents[3]`` == hermes-agent), overridable via ``AIOS_PACKAGES_DIR`` for a deeper
    checkout / symlink. A bare ``ModuleNotFoundError`` with no hint is the failure mode we
    refuse to ship — without this, an absent or mis-located AIOS dir surfaces only as an
    opaque import error.
    """
    env = os.environ.get("AIOS_PACKAGES_DIR")
    root = (
        Path(env)
        if env
        else Path(__file__).resolve().parents[3].parent / "aios" / "packages" / "memory"
    )
    store_dir = root / "experience-store"
    composite_dir = root / "composite-provider"
    missing = [str(d) for d in (store_dir, composite_dir) if not d.is_dir()]
    if missing:
        raise ImportError(
            "composite memory provider requires the AIOS packages, not found at: "
            f"{missing}. Set AIOS_PACKAGES_DIR to the directory containing "
            "'composite-provider' and 'experience-store' (a sibling AIOS checkout beside "
            f"hermes-agent). AIOS_PACKAGES_DIR={env or 'unset (used sibling-path default)'}"
        )
    return store_dir, composite_dir


_STORE_DIR, _COMPOSITE_DIR = _resolve_aios_package_dirs()
for _d in (_STORE_DIR, _COMPOSITE_DIR):
    _s = str(_d)
    if _s not in sys.path:
        sys.path.insert(0, _s)

# Flat imports (the AIOS packages live in hyphenated dirs, so the package dir itself is
# placed on sys.path and the modules import flat — the convention their own tests use).
# When the chassis is on the path, composite_provider binds the REAL
# agent.memory_provider.MemoryProvider automatically (not the _base_shim).
from store import ExperienceStore  # noqa: E402  (path inserted above)
from composite_provider import (  # noqa: E402
    CompositeMemoryProvider,
    SESSION_START_CALL_SITE,
    TOOL_SIGNAL,
)
from backends import BRAIN_FAIL  # noqa: E402  (per-backend ack markers)

# Cap on a single mirrored lesson's text. Matches the composite's brain-observe cap;
# keeps a full SKILL.md body from bloating the FTS index while preserving recall keys.
_LESSON_MAX_CHARS = 2000


class HermesCompositeProvider(CompositeMemoryProvider):
    """CompositeMemoryProvider + the dev-instance fork-authored append seam.

    ``record_fork_lesson`` is the ONLY addition. It writes a deliberately-reviewed,
    fork-authored lesson (``source='reviewed'``, ``migrated=False``) to the experience
    store so it becomes eligible for the AC1 circulation numerator once recalled into a
    consumed context. It is distinct from ``sync_turn``/``on_delegation`` (observe-only,
    ``source='auto'``) — those are the noisy per-turn write side AC1 deliberately excludes.
    """

    def __init__(
        self,
        store=None,
        *,
        db_path: Optional[str] = None,
        brain=None,
        vault=None,
        owns_brain: bool = False,
        recall_limit: int = 5,
        brain_stage: int = 0,
    ) -> None:
        """Accept EITHER a live ``store`` (tests/harness) OR a ``db_path`` for DEFERRED
        construction (D1).

        With a ``db_path`` the ``ExperienceStore`` is NOT opened until ``initialize()`` — so
        the read-only discovery probe (which calls ``is_available`` but never ``initialize``)
        creates no sqlite connection and no ``experience.db``. The eager-store form is kept
        for unit tests / the synthetic-week harness that pass a ``:memory:`` store directly.
        """
        super().__init__(
            store, brain=brain, vault=vault, owns_brain=owns_brain, recall_limit=recall_limit
        )
        self._db_path = db_path
        self._agent_context = "primary"
        # D4-A carrier: receipt id stashed by prefetch (per session), marked consumed only
        # after the chassis confirms the block was injected into the dispatched prompt.
        self._pending_prefetch: Dict[str, str] = {}
        # Brain activation stage: 0=off, 1=observe+recall, 2=+paired reward (flip as verified).
        self._brain_stage = int(brain_stage)
        # Brain observation handles captured by sync_turn (per session), popped one-shot by the
        # stage-2 reward leg so an outcome PAIRS against the right observation (reaches dW>0).
        self._last_observation: Dict[str, str] = {}
        self._obs_lock = threading.Lock()
        # Background worker for the paired reward — kept OFF the turn thread (R4). Lazy-built.
        self._reward_pool: Optional[concurrent.futures.ThreadPoolExecutor] = None
        self._reward_futures: List["concurrent.futures.Future"] = []
        self._last_brain_reward: Optional[Dict[str, Any]] = None

    def is_available(self) -> bool:
        """Available if a store already exists OR we know how to build one — WITHOUT opening
        it (D1: discovery must not construct the store; it is built in ``initialize``)."""
        return self._store is not None or self._db_path is not None

    def initialize(self, session_id: str, **kwargs) -> None:
        """Build the store lazily on activation (D1) and capture ``agent_context`` (#5).

        D1: the ``ExperienceStore`` is constructed here — on the ACTIVE provider — not in
        ``build_provider``/``register`` (which the loader re-runs per discovery probe). The
        build is idempotent (only when no store was injected).

        #5 (latent guard): the chassis currently hardcodes ``agent_context="primary"`` at its
        single ``initialize_all`` call site (agent_init.py), so the non-primary skip in
        ``sync_turn`` does not yet fire in practice. It is kept as future-proofing AND because
        ``sync_turn`` performs no store append regardless — the store stays clean either way.
        """
        if self._store is None and self._db_path is not None:
            self._store = ExperienceStore(db_path=self._db_path)
        super().initialize(session_id, **kwargs)
        self._agent_context = str(kwargs.get("agent_context") or "primary")

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> dict:
        """Observe-only, but with NO store append (#5 — dev-instance corpus policy).

        The base composite appends every turn as a ``source=auto, migrated=0`` lesson;
        that is the *write* side of the predecessor's "write-only memory" death — raw
        conversational turns compete in FTS top-5 with deliberately-authored lessons and
        would inflate AC1's ``migrated=0`` band with non-deliberate content. Here the
        store corpus is deliberately-authored only (fork-review lessons + delegation
        observations via ``on_delegation``); ``sync_turn`` keeps just the fire-and-forget
        brain observation. Non-primary contexts are skipped entirely.
        """
        if getattr(self, "_agent_context", "primary") != "primary":
            return {"store": "skipped", "brain": "skipped", "vault": "skipped"}

        # R9: report each leg by ACTUAL presence/stage. The brain leg is OBSERVE-ONLY here
        # (reward lives in handle_tool_call, the outcome-gated path) — sync_turn never reports
        # a reward state. The observation handle is captured so the stage-2 reward can pair.
        ack = {
            "store": "skipped",
            "brain": "observe-only" if (self._brain is not None and self._brain_stage >= 1) else "skipped",
            "vault": "ok" if self._vault is not None else "skipped",
        }
        if self._brain is not None and self._brain_stage >= 1:
            sid = session_id or self._session_id
            try:
                obs_id = self._brain.observe(
                    {"type": "context", "content": (assistant_content or "")[:_LESSON_MAX_CHARS]}
                )
                if obs_id:
                    with self._obs_lock:
                        self._last_observation[sid] = str(obs_id)
                    ack["brain"] = "observe-only"
                else:
                    ack["brain"] = BRAIN_FAIL
            except Exception as exc:  # best-effort; degrade, never crash
                logger.debug("brain observe failed: %s", exc)
                ack["brain"] = BRAIN_FAIL
        return ack

    def record_fork_lesson(
        self,
        lesson: str,
        *,
        provenance: str,
        task_type: str = "workflow",
        tags: Optional[List[str]] = None,
        source: str = "reviewed",
    ) -> str:
        """Append a fork-authored lesson; returns the store ref (uuid hex).

        Raises the store's own validation errors (bad ``task_type``/``source``, empty
        lesson, missing provenance) — the caller treats a failure as best-effort and logs.
        """
        record = {
            "lesson": str(lesson)[:_LESSON_MAX_CHARS],
            "task_type": task_type,
            "tags": list(tags or ["fork", "background_review"]),
            "provenance": provenance,
            "source": source,
            "migrated": False,  # fork-authored — the AC1-eligible band
        }
        return self._store.append(record)

    # ----- D4-A: consumed-at-injection (defer mark_consumed off prefetch) -----

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Like the base session-start prefetch, but does NOT mark the receipt consumed
        inline (D4-A). The base marks consumed the instant prefetch returns non-empty —
        "returned" != "the model saw it". Here we stash the receipt id (per session) and
        the chassis calls ``confirm_prefetch_consumed`` only AFTER the block is actually
        injected into the dispatched prompt (conversation_loop). A recalled block that is
        assembled-but-dropped therefore never counts toward AC1.

        Reuses the inherited merge/format so recall output is identical to the base — only
        the mark timing changes. If no chassis ever confirms (e.g. a direct caller that does
        not inject), the receipt simply stays unconsumed — recall is still recorded.

        SEMANTIC FORK (R2-11): the AIOS base ``CompositeMemoryProvider.prefetch`` self-consumes
        on return (and AIOS's own tests assert that for the base). This Hermes subclass
        intentionally diverges to consume-at-injection, so ``circulation()`` timing differs
        between a bare AIOS composite (recall-time) and this subclass (injection-time). Do not
        compare circulation across the two as if identical. This is the C4/Sev-2-#8 fix.
        """
        store_records, receipt = self._store.recall(
            query, call_site=SESSION_START_CALL_SITE, limit=self._recall_limit
        )
        merged = self._merge_dedup(
            store_records, self._warm_cache["vault"], self._warm_cache["brain"]
        )
        if not merged:
            return ""
        self._pending_prefetch[session_id or self._session_id] = receipt["id"]
        return self._format_context(merged)

    def confirm_prefetch_consumed(self, session_id: str = "") -> bool:
        """Mark the stashed session-start receipt consumed — called by the chassis after the
        recalled block reaches the dispatched prompt. No-op (returns False) if there is no
        pending receipt (e.g. the block was dropped, or already confirmed this turn)."""
        rid = self._pending_prefetch.pop(session_id or self._session_id, None)
        if rid is None:
            return False
        return bool(self._store.mark_consumed(rid))

    def on_session_switch(self, new_session_id, *, parent_session_id="", reset=False, **kwargs):
        """Free the LEAVING session's un-confirmed prefetch receipt (R2-9/AC-R5) before
        rotating the cached id — so a session that prefetched but never confirmed (dropped
        injection / aborted turn) does not orphan a _pending_prefetch entry."""
        if parent_session_id:
            self._pending_prefetch.pop(parent_session_id, None)
            self._last_observation.pop(parent_session_id, None)
        super().on_session_switch(
            new_session_id, parent_session_id=parent_session_id, reset=reset, **kwargs
        )

    def on_session_end(self, messages) -> None:
        """Free the current session's un-confirmed prefetch receipt at session end (R2-9)."""
        self._pending_prefetch.pop(self._session_id, None)
        self._last_observation.pop(self._session_id, None)

    # ----- D3b: pre-delegation knowledge-gate recall -----

    def recall_for(self, call_site: str, query: str, *, limit: Optional[int] = None):
        """Recall for a non-session-start call site (e.g. ``"pre-delegation"``). Returns
        ``(formatted_block, receipt_id)``. Always emits a receipt (a miss writes a
        ``kind='miss'`` receipt — never silent). Does NOT mark consumed; the caller confirms
        via :meth:`confirm_consumed` once the block is placed in the dispatched prompt.
        """
        records, receipt = self._store.recall(
            query, call_site=call_site, limit=limit or self._recall_limit
        )
        if not records:
            return "", receipt["id"]
        return self._format_context(self._merge_dedup(records, [], [])), receipt["id"]

    def confirm_consumed(self, receipt_id: str) -> bool:
        """Mark a specific receipt consumed (D3b: after its block reached the child prompt)."""
        return bool(self._store.mark_consumed(receipt_id))

    # ----- brain reward leg (stage 2): outcome-gated + BACKGROUNDED (R4) -----

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        """Route signal/forget to the store (base), THEN — at stage 2 only — fire a PAIRED
        brain reward for a real outcome (the loop's learning leg).

        This runs on the foreground TURN/tool thread, so the brain reward is SUBMITTED to a
        background worker and NOT awaited — we return the store ack immediately
        (ack.brain="pending"); a slow/offline brain can never stall the turn (R4). C3 is
        preserved: reward fires only here (a deliberate outcome), never per-turn in sync_turn.
        The SIGNED valence is carried so failures punish; valence==0 is neutral and skips the
        reward; the captured observation_id is popped one-shot to avoid double-credit.

        The store's ``signal()`` enforces a closed ``VALID_DERIVATIONS`` whitelist (its C5
        non-constant-by-construction guard), and the ``experience_signal`` tool schema
        constrains ``derivation`` to that same enum — so a compliant caller can only ever send
        a whitelist-valid derivation. The args are therefore routed to the store UNMODIFIED:
        if a caller does send an out-of-set derivation it is a real error and the base correctly
        surfaces the store's ``ConstantValenceError`` as a clean ``{"error": ...}`` (never a
        silently-normalized success). The same caller-supplied derivation reaches
        ``self._brain.reward`` below.
        """
        out = super().handle_tool_call(tool_name, args, **kwargs)
        if tool_name != TOOL_SIGNAL or self._brain is None or self._brain_stage < 2:
            return out
        try:
            parsed = json.loads(out)
        except (ValueError, TypeError):
            return out
        if not isinstance(parsed, dict) or "error" in parsed:
            return out  # store rejected the signal — do not reward a degenerate outcome
        try:
            valence = float(args.get("valence"))
        except (TypeError, ValueError):
            return out
        if valence == 0.0:
            return out  # neutral is not a reward
        session_id = kwargs.get("session_id") or self._session_id
        with self._obs_lock:
            observation_id = self._last_observation.pop(session_id, None)
        # DEVIATION (one-shot pairing): fire the reward ONLY when a captured observation is
        # present to pair against. An un-paired signal (no prior observe, or the stash was
        # already popped by an earlier signal) is not re-credited — this is the one-shot
        # guarantee that prevents double-credit on a popped id.
        if observation_id is None:
            return out
        self._submit_reward(
            ref=str(args.get("ref") or ""),
            valence=valence,
            derivation=str(args.get("derivation") or ""),
            observation_id=observation_id,
            session_id=session_id,
        )
        ack = parsed.get("ack") if isinstance(parsed.get("ack"), dict) else {}
        ack["brain"] = "pending"  # backgrounded; final dW status recorded async (health view)
        parsed["ack"] = ack
        return json.dumps(parsed)

    def _submit_reward(self, *, ref, valence, derivation, observation_id, session_id) -> None:
        if self._reward_pool is None:
            self._reward_pool = concurrent.futures.ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="brain-reward"
            )

        def _run() -> str:
            try:
                status = self._brain.reward(
                    ref, valence=valence, derivation=derivation,
                    observation_id=observation_id, session_id=session_id,
                )
            except Exception as exc:  # best-effort; never surfaces to the turn
                logger.debug("brain reward failed: %s", exc)
                status = BRAIN_FAIL
            self._last_brain_reward = {"status": status, "observation_id": observation_id}
            return status

        self._reward_futures.append(self._reward_pool.submit(_run))

    def _flush_rewards(self, timeout: float = 5.0) -> None:
        """Wait for outstanding background rewards (used by tests + shutdown)."""
        futures, self._reward_futures = self._reward_futures, []
        for fut in futures:
            try:
                fut.result(timeout=timeout)
            except Exception:  # noqa: BLE001 - best-effort drain
                pass

    def shutdown(self) -> None:
        self._flush_rewards(timeout=2.0)
        if self._reward_pool is not None:
            self._reward_pool.shutdown(wait=False)
            self._reward_pool = None
        super().shutdown()


def _resolve_brain_stage() -> int:
    """Parse HERMES_BRAIN_STAGE safely. Clamps to 0..2; any garbage -> 0 (off). Default 0
    keeps the LIVE agent byte-for-byte unchanged until a stage is deliberately flipped."""
    raw = os.environ.get("HERMES_BRAIN_STAGE", "0")
    try:
        return max(0, min(2, int(str(raw).strip())))
    except (TypeError, ValueError):
        return 0


def build_provider(hermes_home: str) -> "HermesCompositeProvider":
    """Construct the composite over a profile-scoped experience store.

    Brain activation is STAGED via env (flip only after verifying each stage live):
      * HERMES_BRAIN_STAGE=0 (default) -> brain=None; the live agent is unaffected.
      * =1 -> observe + recall active (the brain receives experience + supplies recall).
      * =2 -> + the paired reward (the learning leg; gate on battery D1 PASS on the host).
    HERMES_BRAIN_URL overrides the endpoint (default http://1.1.11.31:8000). When a brain is
    constructed the composite OWNS it (owns_brain=True; the urllib adapter's close() is a no-op).
    A liveness probe is logged at build so a dead endpoint is visible, not silently degraded.
    """
    db_path = os.path.join(hermes_home, "experience.db")
    stage = _resolve_brain_stage()
    brain = None
    if stage >= 1:
        url = os.environ.get("HERMES_BRAIN_URL") or "http://1.1.11.31:8000"
        try:
            from .brain_http import HttpBrainClient  # type: ignore
        except ImportError:  # loaded flat (composite dir on sys.path)
            from brain_http import HttpBrainClient  # type: ignore
        brain = HttpBrainClient(
            url, source="hermes-agent",
            domain=os.environ.get("CLAUDE_ACTIVE_PROJECT") or None,
        )
        probe = brain.ping()
        logger.info(
            "composite brain leg ACTIVE: stage=%d url=%s reachable=%s",
            stage, url, probe.get("ok"),
        )
    else:
        logger.debug("composite brain leg disabled (HERMES_BRAIN_STAGE=0)")
    return HermesCompositeProvider(
        db_path=db_path, brain=brain, vault=None,
        owns_brain=brain is not None, brain_stage=stage,
    )


__all__ = ["HermesCompositeProvider", "build_provider", "ExperienceStore"]
