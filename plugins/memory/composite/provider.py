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
The VAULT leg (V1) is now wired too: a QMD-backed ``VaultCache`` (``vault_qmd.QmdVaultCache``)
is constructed when QMD is installed/indexed (default ON; HERMES_VAULT_ENABLE=0 disables),
else ``vault=None``. Vault recall is cache-fronted via the base ``queue_prefetch`` and merged
by score in ``prefetch`` — no inline network on the turn thread. The ``sync_turn`` ack reports
a leg by its ACTUAL presence/stage (R9 — never a healthy-looking status for a leg that was
never constructed): an absent leg is ``"skipped"``, an active brain leg is ``"observe-only"``
(reward is outcome-gated in ``handle_tool_call``, never per-turn), an active vault leg ``"ok"``.
"""

from __future__ import annotations

import collections
import concurrent.futures
import hashlib
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


def _resolve_aios_health_dir() -> Optional[str]:
    """Return the AIOS ``packages/health`` dir (for ``ExperienceHealth``), or ``None``.

    Mirrors ``synthetic_week_ac1.py``: ``AIOS_HEALTH_DIR`` override, else sibling
    ``<AIOS>/aios/packages/health`` resolved from this file. The loop self-check (AC-PX5 #3)
    reads ``ExperienceHealth.circulation_report``; an absent health package degrades that
    check to a quiet no-op (best-effort — it never blocks session-end)."""
    env = os.environ.get("AIOS_HEALTH_DIR")
    cand = (
        Path(env)
        if env
        else Path(__file__).resolve().parents[3].parent / "aios" / "packages" / "health"
    )
    return str(cand) if cand.is_dir() else None


_HEALTH_DIR = _resolve_aios_health_dir()
if _HEALTH_DIR and _HEALTH_DIR not in sys.path:
    sys.path.insert(0, _HEALTH_DIR)

# Flat imports (the AIOS packages live in hyphenated dirs, so the package dir itself is
# placed on sys.path and the modules import flat — the convention their own tests use).
# When the chassis is on the path, composite_provider binds the REAL
# agent.memory_provider.MemoryProvider automatically (not the _base_shim).
from store import ExperienceStore  # noqa: E402  (path inserted above)
from composite_provider import (  # noqa: E402
    CompositeMemoryProvider,
    TOOL_SIGNAL,
)
from backends import BRAIN_OK, BRAIN_DEGRADED, BRAIN_FAIL  # noqa: E402  (per-backend ack markers)

# Cap on a single mirrored lesson's text. Matches the composite's brain-observe cap;
# keeps a full SKILL.md body from bloating the FTS index while preserving recall keys.
_LESSON_MAX_CHARS = 2000

# G1 / SPEC-m1-outbox §2.3: max outbox ops a single background drain pass delivers, so the
# drain stays bounded and never monopolizes the mem-sync worker (Q1 — left open in the spec;
# chosen here, TUNABLE via HERMES_OUTBOX_DRAIN_MAX).
_OUTBOX_DRAIN_MAX = 20


def _observe_content_hash(content: str) -> str:
    """Stable content hash for an observe op (SPEC-m1-outbox §2.3, finding GAP-2).

    Required on every enqueued observe so a restart re-send (or any re-drain) collapses to the
    brain's content_hash/chunk_key vault dedup instead of creating a duplicate corpus row. A
    plain sha256 over the (already-capped) observed text — deterministic across processes, so the
    SAME content always hashes the SAME way regardless of which run enqueued it.
    """
    return hashlib.sha256((content or "").encode("utf-8")).hexdigest()


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
        # S2 (loop-plugin-extraction STEP 1): always run the BASE consume-at-injection path
        # (consume_on_inject=True) instead of a forked prefetch override. The base prefetch
        # then stashes the receipt in _pending_prefetch and confirm_prefetch_consumed marks
        # it — behaviorally identical to the removed subclass overrides. Every construction
        # site (build_provider + tests/harness) inherits defer mode this way.
        super().__init__(
            store,
            brain=brain,
            vault=vault,
            owns_brain=owns_brain,
            recall_limit=recall_limit,
            consume_on_inject=True,
        )
        self._db_path = db_path
        self._agent_context = "primary"
        # _pending_prefetch (the D4-A receipt carrier) is owned by the base now.
        # Brain activation stage: 0=off, 1=observe+recall, 2=+paired reward (flip as verified).
        self._brain_stage = int(brain_stage)
        # Brain observation handles captured by sync_turn (per session), popped one-shot by the
        # stage-2 reward leg so an outcome PAIRS against the right observation (reaches dW>0).
        self._last_observation: Dict[str, str] = {}
        self._obs_lock = threading.Lock()
        # D3 lesson-keyed pairing: lesson_ref -> recall-time brain observation_id. Populated by
        # recall_for (Event 2) when a lesson is served; consumed one-shot by the reward leg so an
        # OUTCOME reinforces the LESSON's synapses, not whatever the last turn observed. Bounded
        # FIFO (observation_ids age out of the eligibility window in minutes; no need to retain
        # more). In-process only — a restart between recall and outcome falls back to turn-pairing.
        self._lesson_observation: "collections.OrderedDict[str, str]" = collections.OrderedDict()
        self._lesson_obs_lock = threading.Lock()
        self._LESSON_OBS_MAX = 256
        self._review_observe_count: int = 0  # falsifiability: authored lessons observed into brain
        # Background worker for the paired reward — kept OFF the turn thread (R4). Lazy-built.
        self._reward_pool: Optional[concurrent.futures.ThreadPoolExecutor] = None
        self._reward_futures: List["concurrent.futures.Future"] = []
        # D3: background worker for recall-time re-observe (Event 2). recall_for runs on the
        # synchronous delegation-recall path; a per-lesson brain.observe (observe_timeout up to
        # 10s each) MUST NOT block it. Lazy-built, single worker — same pattern as _reward_pool.
        self._observe_pool: Optional[concurrent.futures.ThreadPoolExecutor] = None
        self._observe_futures: List["concurrent.futures.Future"] = []
        # Brain health surface (Task #11): the LAST completed reward + running dW totals, so the
        # brain ack is HONEST (no hardcoded 'degraded'). Set by the backgrounded reward _run.
        self._last_brain_reward: Optional[Dict[str, Any]] = None
        self._reward_dW_total: float = 0.0
        self._reward_count: int = 0
        # AC-PX5 #3 (present-but-unproductive backstop): a small consecutive-counter over
        # session-end self-checks. K consecutive write-only checks (circulation==0 with a
        # corpus above the recall floor) flips the loop-health status from passive report to
        # an ERROR. K is configurable via HERMES_LOOP_WRITEONLY_K (default 2); the lesson floor
        # via HERMES_LOOP_WRITEONLY_FLOOR (default 0 — any non-empty write-only corpus counts;
        # a fresh/foreign store with 0 lessons never trips because WRITE_ONLY_MEMORY needs
        # total_lessons>0). Tracked here so the ERROR fires only on a SUSTAINED dead loop.
        self._writeonly_streak: int = 0
        self._loop_writeonly_alarm: bool = False
        try:
            self._loop_writeonly_k = max(1, int(os.environ.get("HERMES_LOOP_WRITEONLY_K", "2")))
        except (TypeError, ValueError):
            self._loop_writeonly_k = 2
        try:
            self._loop_writeonly_floor = max(0, int(os.environ.get("HERMES_LOOP_WRITEONLY_FLOOR", "0")))
        except (TypeError, ValueError):
            self._loop_writeonly_floor = 0

    def is_available(self) -> bool:
        """Available if a store already exists OR we know how to build one — WITHOUT opening
        it (D1: discovery must not construct the store; it is built in ``initialize``)."""
        return self._store is not None or self._db_path is not None

    def get_config_schema(self):
        """Desktop/web Memory settings surface for NeuroLinked + vault legs.

        Composite is env-staged at gateway start (``HERMES_BRAIN_STAGE`` /
        ``HERMES_BRAIN_URL`` / ``HERMES_VAULT_ENABLE``). The schema maps those
        knobs so Config → Memory can edit them; ``save_config`` writes both the
        provider JSON and the matching env vars (restart required to apply).
        """
        return [
            {
                "key": "brain_stage",
                "label": "NeuroLinked brain stage",
                "description": (
                    "0 = brain leg off (default). "
                    "1 = observe + recall from NeuroLinked. "
                    "2 = + paired reward (learning). "
                    "Requires a full Hermes restart after Save."
                ),
                "choices": [
                    {"value": "0", "label": "0 — Off (no NeuroLinked leg)"},
                    {"value": "1", "label": "1 — Observe + recall"},
                    {"value": "2", "label": "2 — Observe + recall + learning reward"},
                ],
                "default": "0",
                "env_var": "HERMES_BRAIN_STAGE",
            },
            {
                "key": "brain_url",
                "label": "NeuroLinked brain URL",
                "description": (
                    "HTTP base for the NeuroLinked brain API "
                    "(observe/recall/feedback). Legacy memory.config used "
                    "brain_host + brain_port — prefer a full URL here."
                ),
                "default": "http://1.1.11.31:8000",
                "placeholder": "http://1.1.11.31:8000",
                "env_var": "HERMES_BRAIN_URL",
            },
            {
                "key": "vault_enable",
                "label": "QMD vault recall leg",
                "description": (
                    "When on (1), merge QMD vault search into composite recall "
                    "if an index is available. Off (0) = experience store + brain only."
                ),
                "choices": [
                    {"value": "1", "label": "On — use QMD vault when available"},
                    {"value": "0", "label": "Off — store + brain only"},
                ],
                "default": "1",
                "env_var": "HERMES_VAULT_ENABLE",
            },
            {
                "key": "max_recall_results",
                "label": "Max recall results",
                "description": "How many items each recall leg may contribute per turn.",
                "default": "5",
            },
        ]

    def save_config(self, values, hermes_home):
        """Persist composite knobs to provider JSON + HERMES_HOME .env.

        ``build_provider`` reads env at process start, so env write is what makes
        brain stage/URL live after relaunch. JSON keeps the UI fields stable.
        """
        import json
        from pathlib import Path

        home = Path(hermes_home)
        cfg_dir = home / "composite"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        cfg_path = cfg_dir / "config.json"
        existing = {}
        if cfg_path.exists():
            try:
                raw = json.loads(cfg_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    existing = raw
            except Exception:
                existing = {}
        cleaned = {
            str(k): ("" if v is None else str(v)) for k, v in (values or {}).items()
        }
        existing.update(cleaned)
        cfg_path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")

        env_map = {
            "brain_stage": "HERMES_BRAIN_STAGE",
            "brain_url": "HERMES_BRAIN_URL",
            "vault_enable": "HERMES_VAULT_ENABLE",
        }
        try:
            from hermes_cli.config import save_env_value
        except Exception:
            save_env_value = None  # type: ignore

        for key, env_key in env_map.items():
            if key not in cleaned:
                continue
            val = cleaned[key].strip()
            if not val and key != "vault_enable":
                continue
            if save_env_value is not None:
                try:
                    save_env_value(env_key, val)
                    continue
                except Exception:
                    logger.debug("save_env_value failed for %s", env_key, exc_info=True)
            _upsert_env_file(home / ".env", env_key, val)

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
        # AC-PX5 #2 (boot wiring assertion, OWN PROVIDER ONLY): refuse to boot a silently-dead
        # loop. Assert the chassis still exposes the MemoryManager fan-out dispatch AND the seam
        # sentinels resolve; a lost patch RAISES LoopWiringError here (re-raised by
        # initialize_all), never warn-and-continue. The live config MUST pass (no false positive
        # — a raise here would prevent the desktop from starting; covered by a live-boot test).
        # The manager is threaded from initialize_all when available; otherwise the class-level
        # dispatch surface is verified via the MemoryManager class.
        try:
            from .loop_guard import assert_loop_wired
        except ImportError:  # loaded flat (plugin dir not a package on this path)
            from loop_guard import assert_loop_wired  # type: ignore
        manager = kwargs.get("memory_manager")
        if manager is None:
            from agent.memory_manager import MemoryManager
            manager = MemoryManager
        assert_loop_wired(manager)

        if self._store is None and self._db_path is not None:
            self._store = ExperienceStore(db_path=self._db_path)
        # G1 / SPEC-m1-outbox §2.3 restart reclaim: any orphaned in_flight outbox op (a drain
        # interrupted by a prior crash/restart) → pending, so it is re-drained. Done ONCE at
        # startup, guarded to the observe stage + a present store. Reclaim is store-ONLY (no brain
        # client / HTTP needed): it must run even when the brain client is absent, else previously
        # enqueued in_flight rows are never reclaimed. The drain itself still guards _brain is None.
        # Re-send is safe — the brain's content_hash vault dedup collapses a duplicate. Best-effort:
        # never blocks boot.
        if self._store is not None and self._brain_stage >= 1:
            try:
                reclaimed = self._store.outbox_reclaim()
                if reclaimed:
                    logger.info("outbox restart-reclaim: %d in_flight op(s) → pending", reclaimed)
            except Exception as exc:
                logger.debug("outbox_reclaim failed at startup: %s", exc)
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
            content = (assistant_content or "")[:_LESSON_MAX_CHARS]
            try:
                obs_id = self._brain.observe({"type": "context", "content": content})
                if obs_id:
                    with self._obs_lock:
                        self._last_observation[sid] = str(obs_id)
                    ack["brain"] = "observe-only"
                else:
                    # Non-confirming response (no valid observation_id) — enqueue durably (G1).
                    ack["brain"] = self._enqueue_observe(content, sid)
            except Exception as exc:  # transport error; degrade, never crash — but enqueue (G1).
                logger.debug("brain observe failed: %s", exc)
                ack["brain"] = self._enqueue_observe(content, sid)
        return ack

    # ----- G1 / AC5: durable observe outbox (SPEC-m1-outbox §2.2 enqueue, §2.3 drain) -----

    def _enqueue_observe(self, content: str, session_id: str) -> str:
        """On a failed live observe, write a durable `pending` outbox op instead of dropping it
        (SPEC-m1-outbox §2.2). DEGRADE-NOT-STALL: the enqueue is a cheap local sqlite write and
        is wrapped so it NEVER raises into the turn — an enqueue failure logs and returns
        ``BRAIN_FAIL`` exactly as the pre-outbox drop did. A successful live observe never gets
        here (fast path unchanged). Reward is NEVER enqueued — only observe ops (reward replay is
        M6). Returns the brain ack marker for ``sync_turn``.

        The op carries a stable ``content_hash`` (so a re-send hits the brain's vault dedup, §2.3
        GAP-2) and a deterministic ``enqueue_key`` from session+content_hash (so a duplicated turn
        is an outbox-local no-op, not a second row).
        """
        if self._store is None:
            return BRAIN_FAIL
        try:
            content_hash = _observe_content_hash(content)
            self._store.outbox_enqueue(
                kind="observe",
                payload={"type": "context", "content": content},
                content_hash=content_hash,
                session_id=session_id,
                enqueue_key=f"observe:{session_id}:{content_hash}",
            )
        except Exception as exc:  # never stall the turn on a local enqueue failure
            logger.debug("outbox enqueue failed (observe dropped): %s", exc)
            return BRAIN_FAIL
        return "enqueued"

    def _drain_outbox(self, max_ops: int = _OUTBOX_DRAIN_MAX) -> Dict[str, int]:
        """Drain pending observe ops to the brain — OFF the turn thread (SPEC-m1-outbox §2.3).

        Single-drainer-per-pass, bounded by ``max_ops``. Each op: atomic ``outbox_claim``
        (pending→in_flight), then re-POST observe OUTSIDE the store lock, then settle:
          * valid ``observation_id`` returned → ``outbox_confirm`` (in_flight→confirmed).
          * transport error (observe raised) → ``outbox_fail('transport')`` (back to pending,
            attempts UNCHANGED — a long outage must not poison-kill, §2.3 finding #6).
          * non-confirming response (no id, treated as a substantive/4xx reject) →
            ``outbox_fail('substantive')`` (attempts++, → dead at the cap).
        Best-effort throughout: a settle/claim failure logs and the pass stops; it NEVER raises
        into the caller (the background worker). Guarded to brain_stage>=1 + a present brain/store.
        Returns ``{confirmed, transport_fail, substantive_fail}`` counts (useful to tests/health).
        """
        out = {"confirmed": 0, "transport_fail": 0, "substantive_fail": 0}
        if self._brain is None or self._brain_stage < 1 or self._store is None:
            return out
        for _ in range(max(0, int(max_ops))):
            try:
                row = self._store.outbox_claim()
            except Exception as exc:
                logger.debug("outbox_claim failed; stopping drain pass: %s", exc)
                break
            if row is None:
                break  # nothing pending
            oid = row["id"]
            payload = row.get("payload") or {}
            try:
                obs_id = self._brain.observe(payload)
            except Exception as exc:  # transport — back to pending, do not poison.
                logger.debug("outbox drain observe transport-failed: %s", exc)
                try:
                    self._store.outbox_fail(oid, "transport")
                except Exception as exc2:
                    logger.debug("outbox_fail(transport) failed: %s", exc2)
                out["transport_fail"] += 1
                # The brain is unreachable: a transport-failed op returns to pending with
                # attempts UNCHANGED. STOP the pass rather than re-claim the same row in a spin —
                # the next queue_prefetch tick retries (degrade-not-stall; finding #6).
                break
            try:
                if obs_id:
                    self._store.outbox_confirm(oid, str(obs_id))
                    out["confirmed"] += 1
                else:
                    self._store.outbox_fail(oid, "substantive")
                    out["substantive_fail"] += 1
            except Exception as exc:
                logger.debug("outbox settle failed for %s: %s", oid, exc)
        return out

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

    # ----- D4-A: consumed-at-injection -----
    #
    # ``prefetch`` and ``confirm_prefetch_consumed`` are now SERVED BY THE BASE
    # (``CompositeMemoryProvider`` with ``consume_on_inject=True``, set in __init__). The base
    # path is behaviorally identical to the removed subclass overrides: same store.recall on the
    # session-start call site, same _merge_dedup over store/vault/brain warm-cache, same
    # _pending_prefetch stash keyed by session, same _format_context output, same
    # mark_consumed-on-confirm timing. STEP 1 / S2 of loop-plugin-extraction removed the fork.
    #
    # SEMANTIC FORK NOTE (R2-11) still applies at the *configuration* level: this subclass
    # always constructs the base in consume-at-injection mode, so circulation() timing differs
    # from a bare AIOS composite built with the default consume-on-return — do not compare
    # circulation across the two as if identical. (C4 / Sev-2-#8 fix.)

    def on_session_switch(self, new_session_id, *, parent_session_id="", reset=False, **kwargs):
        """Thin subclass override: free the LEAVING session's brain ``_last_observation`` (a
        subclass-only field the base does not know about), THEN delegate to the base — which
        frees the base-owned ``_pending_prefetch`` receipt and rotates the cached id. Retained
        per STEP 1 / S2: the base cannot clean a field it does not own (AC-PX3b guard)."""
        if parent_session_id:
            self._last_observation.pop(parent_session_id, None)
        super().on_session_switch(
            new_session_id, parent_session_id=parent_session_id, reset=reset, **kwargs
        )

    def on_session_end(self, messages) -> None:
        """Thin subclass override: free the current session's ``_last_observation`` (subclass-
        only), run the AC-PX5 #3 loop self-check (present-but-unproductive backstop), THEN
        delegate to the base to free the base-owned ``_pending_prefetch``."""
        self._last_observation.pop(self._session_id, None)
        # Reuse the existing session-end hook as the runtime tripwire (spec §8 AC-PX5 #3).
        try:
            self.loop_self_check()
        except Exception as exc:  # best-effort; a health-read failure never breaks session-end
            logger.debug("loop_self_check failed: %s", exc)
        super().on_session_end(messages)

    # ----- AC-PX5 #3: present-but-unproductive (runtime backstop) -----

    def loop_self_check(self) -> Dict[str, Any]:
        """Read ``ExperienceHealth(store).circulation_report()`` and detect a SUSTAINED
        write-only loop (the predecessor's "lessons written, never read" death).

        A check is "write-only" when the ``WRITE_ONLY_MEMORY`` flag is active (circulation==0
        with total_lessons>0) AND the corpus exceeds the configured recall floor. K consecutive
        write-only checks emit a ``logger.ERROR`` and flip ``_loop_writeonly_alarm`` (surfaced
        by :meth:`loop_health`). A circulating check (or a fresh/foreign store below the floor)
        resets the streak and clears the alarm — so noise from a cold or non-loop store stays
        quiet. Returns the structured self-check result (also useful to tests/health callers).

        Best-effort: with no store yet, or the AIOS health package absent, returns a quiet
        ``{"checked": False, ...}`` and changes no state.
        """
        result: Dict[str, Any] = {
            "checked": False,
            "write_only": False,
            "streak": self._writeonly_streak,
            "alarm": self._loop_writeonly_alarm,
            "circulation": None,
            "total_lessons": None,
        }
        if self._store is None:
            return result
        try:
            from experience_health import ExperienceHealth  # AIOS health pkg (path inserted)
        except ImportError:
            logger.debug("loop_self_check: AIOS health package not importable; skipping")
            return result

        report = ExperienceHealth(self._store).circulation_report()
        circulation = report.get("circulation", 0)
        total = report.get("total_lessons", 0)
        write_only_flag = next(
            (f for f in report.get("flags", []) if f.get("name") == "WRITE_ONLY_MEMORY"),
            None,
        )
        flag_active = bool(write_only_flag and write_only_flag.get("active"))
        # Above-floor guard: a corpus at/below the floor is too small to call a pathology.
        write_only = flag_active and total > self._loop_writeonly_floor

        result.update(
            checked=True,
            write_only=write_only,
            circulation=circulation,
            total_lessons=total,
        )

        if not write_only:
            # Circulating, or below floor / fresh store -> reset and stay quiet.
            self._writeonly_streak = 0
            self._loop_writeonly_alarm = False
            result["streak"] = 0
            result["alarm"] = False
            return result

        self._writeonly_streak += 1
        result["streak"] = self._writeonly_streak
        if self._writeonly_streak >= self._loop_writeonly_k:
            self._loop_writeonly_alarm = True
            logger.error(
                "LOOP WRITE-ONLY: %d consecutive session-end checks with circulation=0 and "
                "%d lesson(s) stored (the predecessor death — fork-authored lessons written but "
                "never reaching a consumed recall). The self-improvement loop is wired but dead: "
                "check the recall/consume seams (delegation-recall / injection-confirm) and the "
                "store recall path. (AC-PX5 #3, K=%d)",
                self._writeonly_streak, total, self._loop_writeonly_k,
            )
        result["alarm"] = self._loop_writeonly_alarm
        return result

    def loop_health(self) -> Dict[str, Any]:
        """Status surface for the AC-PX5 #3 runtime backstop (parallels :meth:`brain_health`).

        ``status``:
          * ``write-only-alarm`` — K consecutive write-only checks tripped (loop wired but dead).
          * ``write-only`` — a write-only check fired but the K streak is not yet reached.
          * ``ok`` — last check saw circulation (or a below-floor/fresh store).
        """
        if self._loop_writeonly_alarm:
            status = "write-only-alarm"
        elif self._writeonly_streak > 0:
            status = "write-only"
        else:
            status = "ok"
        return {
            "status": status,
            "write_only_streak": self._writeonly_streak,
            "write_only_alarm": self._loop_writeonly_alarm,
            "write_only_k": self._loop_writeonly_k,
            "write_only_floor": self._loop_writeonly_floor,
        }

    # ----- G1 / AC5: background drain off the hot path -----

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Background warm (the chassis runs this on its `mem-sync` worker, OFF the turn thread):
        first drain any pending observe outbox ops (SPEC-m1-outbox §2.3 — delivered here so a
        slow/offline brain never touches the turn), THEN delegate to the base warm-cache recall.

        Both legs are best-effort: a drain failure never raises and never blocks the base warm
        (which itself degrades, never stalls). The drain is bounded per pass (`_OUTBOX_DRAIN_MAX`).
        """
        try:
            self._drain_outbox()
        except Exception as exc:  # never let the drain break the prefetch warm
            logger.debug("outbox drain pass failed (queue_prefetch): %s", exc)
        super().queue_prefetch(query, session_id=session_id)

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
        # D3 Event 2 (re-observe at recall): a lesson served here will, IF it drives a real
        # outcome, receive an outcome-gated reward via handle_tool_call. For R-STDP to land on
        # the LESSON's synapses the reward must pair to an observation within the eligibility
        # window — the authoring-time trace has long decayed. Re-observe each served lesson and
        # stash its observation_id keyed by ref. This is dispatched to a BACKGROUND worker
        # (Sev: a per-lesson brain.observe can block up to observe_timeout ~10s; recall_for is
        # on the synchronous delegation-recall path and must never block on N brain RPCs). The
        # map is populated shortly after; if a (much-later) outcome races ahead of it,
        # handle_tool_call falls back to turn-pairing (graceful, never wrong).
        if self._brain is not None and self._brain_stage >= 1:
            self._submit_reobserve(
                [(rec.get("ref") or rec.get("id"), rec.get("lesson") or rec.get("content"))
                 for rec in records]
            )
        return self._format_context(self._merge_dedup(records, [], [])), receipt["id"]

    def confirm_consumed(self, receipt_id: str) -> bool:
        """Mark a specific receipt consumed (D3b: after its block reached the child prompt)."""
        return bool(self._store.mark_consumed(receipt_id))

    # ----- loop-seam bridges (spec-loop-plugin-extraction §3.2) -----
    #
    # THIN bridges to the existing methods above so the chassis can route the loop's seams
    # through generic MemoryManager fan-out instead of by-name get_provider("composite")
    # lookups. No behavior change — same storage/recall as the prior direct calls.

    def on_background_review(self, lesson_candidates, *, session_id: str = "") -> int:
        """Store each neutral lesson candidate via :meth:`record_fork_lesson`; return the count
        written. The chassis has already extracted the candidates (neutral
        ``{lesson, task_type, tags, provenance}`` shape) — this is the storage-policy entry.
        A per-lesson append failure is logged, never raised (best-effort, matches the prior
        in-chassis loop)."""
        written = 0
        for cand in lesson_candidates or []:
            try:
                self.record_fork_lesson(
                    cand["lesson"],
                    provenance=cand["provenance"],
                    task_type=cand.get("task_type", "workflow"),
                    tags=cand.get("tags"),
                )
                written += 1
            except Exception as exc:
                logger.warning("fork experience-store append failed: %s", exc)
                continue  # do not observe a lesson that failed to store
            # D3 Event 1 (observe at authoring): Hebbian-encode the distilled lesson so its
            # neural representation EXISTS. The concept-dense lesson fires different populations
            # than the raw turn sync_turn observed (non-redundant). Deliberately NO reward here:
            # authoring is not an outcome, and a constant reward would saturate the RPE baseline
            # and corrupt every channel's plasticity. Reward stays outcome-gated (Event 3), paired
            # to the recall-time observation (Event 2). Best-effort; never breaks the review.
            if self._brain is not None and self._brain_stage >= 1:
                try:
                    self._brain.observe(
                        {"type": "text", "content": str(cand["lesson"])[:_LESSON_MAX_CHARS]}
                    )
                    with self._lesson_obs_lock:  # counter shared with the reobserve worker
                        self._review_observe_count += 1
                except Exception as exc:
                    logger.debug("D3 background-review brain observe failed: %s", exc)
        return written

    def recall_for_delegation(self, goal: str, *, session_id: str = ""):
        """Pre-delegation knowledge-gate recall — delegate to the existing
        :meth:`recall_for` primitive with the ``"pre-delegation"`` call site. Returns
        ``(block, receipt_id)``."""
        return self.recall_for("pre-delegation", goal)

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
        # D3 Event 3 (lesson-keyed pairing): if the signal names a lesson ref AND we re-observed
        # that lesson at recall time, pair the reward to the LESSON's observation so R-STDP
        # reinforces the lesson's synapses. Else fall back to the session-turn observation
        # (pre-D3 behavior — zero regression for non-lesson signals). Both maps pop one-shot.
        ref = str(args.get("ref") or "")
        observation_id = None
        if ref:
            with self._lesson_obs_lock:
                observation_id = self._lesson_observation.pop(ref, None)
        if observation_id is None:
            with self._obs_lock:
                observation_id = self._last_observation.pop(session_id, None)
        # DEVIATION (one-shot pairing): fire the reward ONLY when a captured observation is
        # present to pair against. An un-paired signal (no prior observe, or the stash was
        # already popped by an earlier signal) is not re-credited — this is the one-shot
        # guarantee that prevents double-credit on a popped id.
        if observation_id is None:
            return out
        self._submit_reward(
            ref=ref,
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
            # Record the honest outcome for the health surface: the dW the adapter captured
            # from THIS reward's response (read off the brain; None if unreported/failed).
            dw = getattr(self._brain, "_last_reward_dW", None)
            self._last_brain_reward = {
                "status": status, "observation_id": observation_id, "dW": dw,
            }
            self._reward_count += 1
            if isinstance(dw, (int, float)):
                self._reward_dW_total += float(dw)
            return status

        self._reward_futures.append(self._reward_pool.submit(_run))

    def brain_health(self) -> Dict[str, Any]:
        """An HONEST snapshot of the brain reward leg (Task #11) — derived deterministically
        from the recorded last reward + stage, with NO hardcoded label. The elicitation showed
        a static 'degraded' is a lie post the .31 dW-fix; here the status reflects the ACTUAL
        last completed reward.

        ``status`` label table:
          * ``disabled``     — no brain OR stage < 1 (the leg is not active).
          * ``observe-only`` — stage == 1 (observe + recall, no reward leg).
          * ``pending``      — stage >= 2 but no reward has completed yet (or one is in flight).
          * ``live``         — stage >= 2 and the last reward was BRAIN_OK (a real dW landed).
          * ``degraded``     — stage >= 2 and the last reward was BRAIN_DEGRADED (dW=0/422/legacy).
          * ``fail``         — stage >= 2 and the last reward was BRAIN_FAIL (transport error).

        Two distinct dW totals are reported (they are NOT the same number):
          * ``reward_dW_total``  — LOCAL: the sum of per-reward dW THIS process applied
            (accumulated in ``_run`` from each feedback response's dW). Zero until a reward runs.
          * ``brain_dW_total``   — BRAIN-AUTHORITATIVE: the brain's own running total read from
            ``/api/claude/summary`` (``last_reward_dW_total``, the key the battery reads). This is
            best-effort — a live HTTP read that is ``None`` on any failure (offline/absent/raise),
            never raising and never blocking the health call beyond the adapter's short timeout.
        """
        last = self._last_brain_reward
        if self._brain is None or self._brain_stage < 1:
            status = "disabled"
        elif self._brain_stage == 1:
            status = "observe-only"
        elif last is None:
            status = "pending"  # stage>=2, no completed reward yet (or in flight)
        else:
            status = {
                BRAIN_OK: "live",
                BRAIN_DEGRADED: "degraded",
                BRAIN_FAIL: "fail",
            }.get(last.get("status"), "pending")
        # Brain-authoritative total (best-effort; never raises, None on any failure).
        brain_dW_total: Optional[float] = None
        if self._brain is not None:
            try:
                reader = getattr(self._brain, "brain_dW_total", None)
                if callable(reader):
                    brain_dW_total = reader()
            except Exception as exc:  # noqa: BLE001 - health surface must never raise
                logger.debug("brain_dW_total read failed: %s", exc)
        return {
            "stage": self._brain_stage,
            "brain_present": self._brain is not None,
            "status": status,
            "last_reward": last,
            "reward_count": self._reward_count,
            "reward_dW_total": self._reward_dW_total,
            "brain_dW_total": brain_dW_total,
        }

    def _submit_reobserve(self, ref_text_pairs) -> None:
        """D3 Event 2 worker: re-observe served lessons OFF the synchronous recall path and
        stash each observation_id keyed by lesson ref. Single-worker pool (ordering preserved);
        best-effort — a brain fault on any lesson is logged and skipped, never raised. The
        counter and the map are mutated only here and in on_background_review, both under
        ``_lesson_obs_lock``."""
        pairs = [(str(r), str(t)) for (r, t) in ref_text_pairs if r and t]
        if not pairs:
            return
        if self._observe_pool is None:
            self._observe_pool = concurrent.futures.ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="brain-reobserve"
            )

        def _run() -> None:
            for ref, text in pairs:
                try:
                    obs_id = self._brain.observe(
                        {"type": "text", "content": text[:_LESSON_MAX_CHARS]}
                    )
                except Exception as exc:  # best-effort; a fault on one lesson skips only it
                    logger.debug("D3 recall re-observe failed for ref=%s: %s", ref, exc)
                    continue
                if obs_id:
                    with self._lesson_obs_lock:
                        # one entry per ref; refresh moves it to MRU end
                        self._lesson_observation.pop(ref, None)
                        self._lesson_observation[ref] = str(obs_id)
                        self._review_observe_count += 1
                        while len(self._lesson_observation) > self._LESSON_OBS_MAX:
                            self._lesson_observation.popitem(last=False)  # evict oldest (FIFO)

        self._observe_futures.append(self._observe_pool.submit(_run))

    def _flush_observes(self, timeout: float = 5.0) -> None:
        """Wait for outstanding background re-observes (used by tests + shutdown)."""
        futures, self._observe_futures = self._observe_futures, []
        for fut in futures:
            try:
                fut.result(timeout=timeout)
            except Exception:  # noqa: BLE001 - best-effort drain
                pass

    def _flush_rewards(self, timeout: float = 5.0) -> None:
        """Wait for outstanding background rewards (used by tests + shutdown)."""
        futures, self._reward_futures = self._reward_futures, []
        for fut in futures:
            try:
                fut.result(timeout=timeout)
            except Exception:  # noqa: BLE001 - best-effort drain
                pass

    def shutdown(self) -> None:
        self._flush_observes(timeout=2.0)
        self._flush_rewards(timeout=2.0)
        if self._observe_pool is not None:
            self._observe_pool.shutdown(wait=False)
            self._observe_pool = None
        if self._reward_pool is not None:
            self._reward_pool.shutdown(wait=False)
            self._reward_pool = None
        super().shutdown()



def _upsert_env_file(env_path, key: str, value: str) -> None:
    """Best-effort KEY=value upsert for HERMES_HOME/.env (no shelling out)."""
    from pathlib import Path

    path = Path(env_path)
    lines = []
    if path.exists():
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception:
            lines = []
    prefix = f"{key}="
    out = []
    found = False
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("export "):
            stripped = stripped[len("export "):]
        if stripped.startswith(prefix):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        if out and out[-1].strip():
            out.append("")
        out.append(f"{key}={value}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def _load_composite_ui_settings(hermes_home: str) -> dict:
    """Merge composite UI settings from JSON + config.yaml (incl. legacy memory.config)."""
    import json
    from pathlib import Path

    settings = {}
    home = Path(hermes_home)

    for path in (home / "composite" / "config.json", home / "composite.json"):
        if not path.exists():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                settings.update({str(k): v for k, v in raw.items()})
        except Exception:
            pass

    try:
        from hermes_cli.config import load_config

        cfg = load_config() or {}
        mem = cfg.get("memory") if isinstance(cfg, dict) else {}
        if isinstance(mem, dict):
            block = mem.get("composite")
            if isinstance(block, dict):
                settings.update({str(k): v for k, v in block.items()})
            legacy = mem.get("config")
            if isinstance(legacy, dict):
                if "brain_url" not in settings:
                    host = str(legacy.get("brain_host") or "").strip()
                    port = legacy.get("brain_port") or 8000
                    if host:
                        settings["brain_url"] = f"http://{host}:{port}"
                if (
                    "max_recall_results" not in settings
                    and legacy.get("max_recall_results") is not None
                ):
                    settings["max_recall_results"] = legacy.get("max_recall_results")
    except Exception:
        logger.debug("composite: load_config for UI settings failed", exc_info=True)

    return settings


def _resolve_brain_stage(settings: Optional[dict] = None) -> int:
    """Parse HERMES_BRAIN_STAGE safely. Clamps to 0..2; any garbage -> 0 (off). Default 0
    keeps the LIVE agent byte-for-byte unchanged until a stage is deliberately flipped."""
    raw = os.environ.get("HERMES_BRAIN_STAGE")
    if raw is None or str(raw).strip() == "":
        if settings and settings.get("brain_stage") is not None:
            raw = settings.get("brain_stage")
        else:
            raw = "0"
    try:
        return max(0, min(2, int(str(raw).strip())))
    except (TypeError, ValueError):
        return 0


def _vault_enabled(settings: Optional[dict] = None) -> bool:
    """Parse HERMES_VAULT_ENABLE (default ON). The vault leg is cache-fronted and reaches
    only the background mem-sync worker, so it is safe to default-on; set "0"/"false"/"off"
    to disable (e.g. a host with no QMD index)."""
    raw = os.environ.get("HERMES_VAULT_ENABLE")
    if raw is None or str(raw).strip() == "":
        if settings and settings.get("vault_enable") is not None:
            raw = settings.get("vault_enable")
        else:
            raw = "1"
    raw = (str(raw) if raw is not None else "1").strip().lower()
    return raw not in ("0", "false", "off", "no", "")


def _resolve_vault(recall_limit: int):
    """Construct the QMD-backed ``VaultCache`` for the dev instance, or return ``None``.

    Returns ``None`` (so the composite stays vault-less, NOT a leg that always misses) when:
      * the leg is disabled (``HERMES_VAULT_ENABLE=0``), or
      * QMD is not installed/indexed on this host (``QmdVaultCache.is_available()`` is False).
    Otherwise returns a live adapter — vault recall is warmed in the background by the base
    ``queue_prefetch`` and merged into recall by score; nothing here touches the turn thread.
    """
    if not _vault_enabled():
        logger.debug("composite vault leg disabled (HERMES_VAULT_ENABLE=0)")
        return None
    try:
        from .vault_qmd import QmdVaultCache  # type: ignore
    except ImportError:  # loaded flat (composite dir on sys.path)
        from vault_qmd import QmdVaultCache  # type: ignore
    vault = QmdVaultCache(recall_limit=recall_limit)
    if not vault.is_available():
        logger.info(
            "composite vault leg SKIPPED: QMD not available "
            "(set HERMES_VAULT_QMD_JS / HERMES_VAULT_INDEX, or HERMES_VAULT_ENABLE=0)"
        )
        return None
    logger.info("composite vault leg ACTIVE: QMD search (BM25), background cache-warmed")
    return vault


def build_provider(hermes_home: str) -> "HermesCompositeProvider":
    """Construct the composite over a profile-scoped experience store.

    Brain activation is STAGED via env (flip only after verifying each stage live):
      * HERMES_BRAIN_STAGE=0 (default) -> brain=None; the live agent is unaffected.
      * =1 -> observe + recall active (the brain receives experience + supplies recall).
      * =2 -> + the paired reward (the learning leg; gate on battery D1 PASS on the host).
    HERMES_BRAIN_URL overrides the endpoint (default http://1.1.11.31:8000). When a brain is
    constructed the composite OWNS it (owns_brain=True; the urllib adapter's close() is a no-op).
    A liveness probe is logged at build so a dead endpoint is visible, not silently degraded.

    The VAULT leg (the third recall backend) is now wired: a QMD-backed ``VaultCache``
    (``vault_qmd.QmdVaultCache``) is constructed when QMD is installed/indexed on the host
    (default ON; disable via HERMES_VAULT_ENABLE=0). Vault recall is cache-fronted — the base
    ``queue_prefetch`` warms it on the mem-sync worker, and ``prefetch`` merges it by score —
    so it adds nothing inline on the turn thread. When QMD is absent the leg is ``None`` and
    the loop runs store+brain only (sync_turn reports ``vault="skipped"``).
    """
    db_path = os.path.join(hermes_home, "experience.db")
    settings = _load_composite_ui_settings(hermes_home)
    stage = _resolve_brain_stage(settings)
    try:
        recall_limit = max(
            1,
            int(
                str(
                    settings.get("max_recall_results")
                    or os.environ.get("HERMES_COMPOSITE_RECALL_LIMIT")
                    or "5"
                ).strip()
            ),
        )
    except (TypeError, ValueError):
        recall_limit = 5
    # Prefer process env; seed from UI settings when env unset so _vault_enabled sees it.
    if not os.environ.get("HERMES_VAULT_ENABLE") and settings.get("vault_enable") is not None:
        os.environ["HERMES_VAULT_ENABLE"] = str(settings.get("vault_enable"))
    vault = _resolve_vault(recall_limit)
    brain = None
    if stage >= 1:
        url = (
            os.environ.get("HERMES_BRAIN_URL")
            or str(settings.get("brain_url") or "").strip()
            or "http://1.1.11.31:8000"
        )
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
        db_path=db_path, brain=brain, vault=vault,
        owns_brain=brain is not None, brain_stage=stage,
        recall_limit=recall_limit,
    )


__all__ = ["HermesCompositeProvider", "build_provider", "ExperienceStore"]
