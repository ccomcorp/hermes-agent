"""CompositeMemoryProvider — M1 unit 5 (M0-B1 vendor copy for hermes-agent).

Fronts THREE backends behind the single SYNC chassis MemoryProvider contract:
  1. the experience store  (§4 engine — the corpus-local, behavior-changing leg)
  2. a brain client        (thin SYNC blocking-HTTP wrapper over the brain — injectable / mocked)
  3. a vault recall cache   (read-only fast cache — injectable / mocked)

What is unit-verified here vs DEFERRED to the dev instance is documented per method.

Routing (matches the SYNC chassis contract):
  prefetch                -> FAST: store.recall(call_site="session-start") on the current
                             query (emits the receipt) merged with the brain/vault items
                             WARMED by the previous queue_prefetch; NO inline network (Sev-4).
  queue_prefetch          -> BACKGROUND (chassis mem-sync worker): brain.prefetch + vault.recall
                             cached for the next prefetch. The slow legs live here, off the hot path.
  sync_turn               -> store.append (observe-only) + brain.observe (fire-and-forget).
                             NO auto-reward. The composite NEVER calls reward/signal in
                             sync_turn (decouples from the constant-reward coupling — C3).
                             Valence is tool-driven only.
  get_tool_schemas /      -> expose signal(ref,valence,derivation) and forget(ref) as
  handle_tool_call           explicit agent tools, routed to the store. A missing/invalid
                             derivation surfaces the store's ConstantValenceError as a
                             clean tool error (JSON {"error": ...}), never a crash.
  on_session_switch /     -> implemented per the verified contract.
  on_delegation / shutdown   shutdown closes ONLY a brain client the composite created.

Per-backend ack (C3): every fan-out returns/records {store, brain, vault} — never one
collapsed boolean. The brain REWARD leg reports `degraded` while NeuroLinked dW=0.

F2 (review finding) — store concurrency, RESOLVED in store.py:
  The chassis DOES call the provider from >=2 threads — `prefetch`/`handle_tool_call` on
  the foreground turn thread, `sync_turn`/`queue_prefetch` on a dedicated `mem-sync` worker
  — and the store holds ONE sqlite connection. The fix lives where it belongs: the STORE
  now owns its thread-safety (opens with `check_same_thread=False` + an internal re-entrant
  lock guarding every connection-touching method). So the composite calls the store DIRECTLY
  — no composite-side lock. (The earlier composite `threading.Lock`/`asyncio.Lock` was the
  wrong layer — a single composite cannot protect a store also used by audit/health/tests —
  and is removed.)

Vendored from AIOS packages/memory/composite-provider/composite_provider.py (M0-B1).
Changes from the AIOS original:
  - Removed _base_shim.py fallback — the chassis agent.memory_provider is always available.
  - Changed to relative imports (.backends) — we are a proper hermes-agent sub-package.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

# --- Chassis ABC (always available in hermes-agent — no _base_shim fallback) ---
from agent.memory_provider import MemoryProvider

from .backends import BRAIN_DEGRADED, BRAIN_FAIL, BRAIN_OK, BrainClient, VaultCache

logger = logging.getLogger(__name__)

# Tool names exposed to the agent (outcome-driven valence; never auto-fired).
TOOL_SIGNAL = "experience_signal"
TOOL_FORGET = "experience_forget"

SESSION_START_CALL_SITE = "session-start"


class CompositeMemoryProvider(MemoryProvider):
    """Composite of {experience-store, brain, vault} behind the SYNC chassis ABC."""

    def __init__(
        self,
        store: Any,
        *,
        brain: Optional[BrainClient] = None,
        vault: Optional[VaultCache] = None,
        owns_brain: bool = False,
        recall_limit: int = 5,
        consume_on_inject: bool = False,
    ) -> None:
        """`store` is an ExperienceStore (§4 engine). `brain`/`vault` are injectable and
        may be None (degrade to store-only). `owns_brain` controls shutdown: when False
        (default) the composite was HANDED the brain and must NOT close it (it may hold a
        shared HTTP client owned elsewhere).
        """
        self._store = store
        self._brain = brain
        self._vault = vault
        self._owns_brain = owns_brain
        self._recall_limit = recall_limit
        self._session_id: str = ""
        # No composite-side store lock: the store owns its own thread-safety (F2).
        self._warm_cache: Dict[str, List[Dict[str, Any]]] = {"vault": [], "brain": []}
        # #6 defer-consume: when True, prefetch STASHES the receipt instead of marking
        # it consumed on return.
        self._consume_on_inject = consume_on_inject
        self._pending_prefetch: Dict[str, str] = {}

    # ----- required ABC -----

    @property
    def name(self) -> str:
        return "composite"

    def is_available(self) -> bool:
        # Sync, no network (per ABC contract). The store is always present.
        return self._store is not None

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id

    def system_prompt_block(self) -> str:
        return (
            "Experience memory is active. Relevant past lessons are recalled before "
            "each turn. Use the experience_signal tool to record a real outcome "
            "(task_completed / user_correction / explicit_feedback / test_result) and "
            "experience_forget to retire a lesson that proved wrong."
        )

    # ----- prefetch / queue_prefetch -----

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Session-start recall fanned across store + vault + brain, merged & deduped."""
        store_records, receipt = self._store.recall(
            query, call_site=SESSION_START_CALL_SITE, limit=self._recall_limit
        )
        merged = self._merge_dedup(
            store_records, self._warm_cache["vault"], self._warm_cache["brain"]
        )
        if not merged:
            return ""
        if self._consume_on_inject:
            self._pending_prefetch[session_id or self._session_id] = receipt["id"]
        else:
            self._store.mark_consumed(receipt["id"])
        return self._format_context(merged)

    def confirm_prefetch_consumed(self, session_id: str = "") -> bool:
        """Consume-at-injection (defer mode only): mark the stashed receipt consumed."""
        rid = self._pending_prefetch.pop(session_id or self._session_id, None)
        if rid is None:
            return False
        return bool(self._store.mark_consumed(rid))

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Background warm: do the SLOW brain/vault recall here, cache for next prefetch."""
        vault_items: list[dict] = []
        if self._vault is not None:
            try:
                vault_items = self._vault.recall(query) or []
            except Exception as exc:
                logger.debug("vault recall failed (queue_prefetch): %s", exc)
                vault_items = []

        brain_items: list[dict] = []
        if self._brain is not None:
            try:
                brain_items = self._brain.prefetch(query) or []
            except Exception as exc:
                logger.debug("brain prefetch failed (queue_prefetch): %s", exc)
                brain_items = []

        self._warm_cache = {"vault": vault_items, "brain": brain_items}

    def _merge_dedup(self, store_records, vault_items, brain_items):
        """Merge three result lists by score (desc), dedup by normalized lesson text."""
        out: list[dict] = []
        seen: set[str] = set()

        def _text(item) -> str:
            return str(item.get("lesson") or item.get("content") or item.get("text") or "")

        ranked: list[tuple] = []
        idx = 0
        for src_rank, items, src in (
            (0, store_records, "store"),
            (1, vault_items, "vault"),
            (2, brain_items, "brain"),
        ):
            for it in items:
                score = it.get("score")
                if not isinstance(score, (int, float)):
                    score = 1.0 if src == "store" else 0.0
                norm = {
                    "text": _text(it),
                    "id": it.get("id"),
                    "source": src,
                    "score": float(score),
                    "raw": it,
                }
                ranked.append((src_rank, -float(score), idx, norm))
                idx += 1

        ranked.sort(key=lambda t: (t[1], t[0], t[2]))
        for _r, _s, _i, norm in ranked:
            k = " ".join(norm["text"].lower().split())
            if not k or k in seen:
                continue
            seen.add(k)
            out.append(norm)
        return out[: self._recall_limit]

    def _format_context(self, merged) -> str:
        lines = ["[EXPERIENCE]"]
        for m in merged:
            tag = m["source"][0].upper()  # S/V/B provenance marker
            lines.append(f"  ({tag}) {m['text']}")
        lines.append("[/EXPERIENCE]")
        return "\n".join(lines)

    # ----- sync_turn (observe-only, NO auto-reward — C3) -----

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> dict:
        """Observe-only persistence. Appends a lesson record to the store and forwards a
        fire-and-forget observation to the brain. CRITICALLY: it calls NO reward/signal —
        valence is outcome-driven and tool-only. Returns the per-backend ack."""
        ack = {"store": BRAIN_FAIL, "brain": "degraded", "vault": "ok"}

        record = {
            "lesson": assistant_content or user_content or "(empty turn)",
            "task_type": "workflow",
            "tags": ["turn", "observe-only"],
            "provenance": f"composite:sync_turn:{session_id or self._session_id}",
            "source": "auto",
        }
        try:
            self._store.append(record)
            ack["store"] = "ok"
        except Exception as exc:
            logger.warning("store append failed in sync_turn: %s", exc)
            ack["store"] = BRAIN_FAIL

        if self._brain is not None:
            try:
                ok = self._brain.observe(
                    {"type": "context", "content": (assistant_content or "")[:2000]}
                )
                ack["brain"] = BRAIN_DEGRADED if ok else BRAIN_FAIL
            except Exception as exc:
                logger.debug("brain observe failed: %s", exc)
                ack["brain"] = BRAIN_FAIL
        else:
            ack["brain"] = BRAIN_DEGRADED

        return ack

    # ----- tools: signal + forget -----

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": TOOL_SIGNAL,
                "description": (
                    "Record a REAL outcome against a recalled lesson. Valence must come "
                    "from an actual outcome; derivation is required and must be one of "
                    "task_completed, user_correction, explicit_feedback, test_result. "
                    "Constant/auto valence is rejected."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string", "description": "Lesson ref to signal."},
                        "valence": {
                            "type": "number",
                            "description": "Outcome-derived value (>0 win, <0 loss, 0 neutral).",
                        },
                        "derivation": {
                            "type": "string",
                            "enum": [
                                "task_completed",
                                "user_correction",
                                "explicit_feedback",
                                "test_result",
                            ],
                            "description": "Where this outcome came from (required).",
                        },
                    },
                    "required": ["ref", "valence", "derivation"],
                },
            },
            {
                "name": TOOL_FORGET,
                "description": "Tombstone a lesson that proved wrong; excluded from recall.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string", "description": "Lesson ref to forget."}
                    },
                    "required": ["ref"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        """Route signal/forget to the store. Returns a JSON string (chassis contract)."""
        if tool_name == TOOL_SIGNAL:
            ref = args.get("ref")
            valence = args.get("valence")
            derivation = args.get("derivation")
            try:
                result = self._store.signal(ref, valence=valence, derivation=derivation)
            except KeyError as exc:
                return json.dumps(
                    {
                        "error": "UnknownRef",
                        "ref": ref,
                        "message": (
                            f"No lesson with ref {ref!r}. experience_signal reinforces or "
                            f"corrects a lesson ALREADY in the store — pass a ref returned by "
                            f"a recall. It does not create new lessons; durable knowledge is "
                            f"written by the background review or a skill."
                        ),
                        "ack": {"store": "rejected", "brain": "skipped", "vault": "ok"},
                    }
                )
            except Exception as exc:
                return json.dumps(
                    {
                        "error": type(exc).__name__,
                        "message": str(exc),
                        "ack": {"store": "fail", "brain": "degraded", "vault": "ok"},
                    }
                )
            ack = {"store": "ok", "brain": BRAIN_DEGRADED, "vault": "ok"}
            return json.dumps({"result": result, "ack": ack})

        if tool_name == TOOL_FORGET:
            ref = args.get("ref")
            try:
                result = self._store.forget(ref)
            except Exception as exc:
                return json.dumps({"error": type(exc).__name__, "message": str(exc)})
            if result is None:
                return json.dumps({"error": "UnknownRef", "ref": ref})
            return json.dumps({"result": result, "ack": {"store": "ok"}})

        return json.dumps({"error": "UnknownTool", "tool": tool_name})

    # ----- session / delegation / shutdown -----

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs,
    ) -> None:
        """Update the cached session id. In defer-consume mode, free the leaving
        session's un-confirmed prefetch receipt."""
        if parent_session_id:
            self._pending_prefetch.pop(parent_session_id, None)
        self._session_id = new_session_id

    def on_session_end(self, messages) -> None:
        """Defer-consume mode: free the current session's un-confirmed prefetch receipt."""
        self._pending_prefetch.pop(self._session_id, None)

    def on_delegation(
        self, task: str, result: str, *, child_session_id: str = "", **kwargs
    ) -> dict:
        """Parent-side observation of a subagent's work — appended observe-only, NO reward."""
        ack = {"store": BRAIN_FAIL, "brain": BRAIN_DEGRADED, "vault": "ok"}
        record = {
            "lesson": f"[delegation] task={task[:400]} result={result[:800]}",
            "task_type": "workflow",
            "tags": ["delegation", "observe-only"],
            "provenance": f"composite:on_delegation:{child_session_id}",
            "source": "auto",
        }
        try:
            self._store.append(record)
            ack["store"] = "ok"
        except Exception as exc:
            logger.warning("store append failed in on_delegation: %s", exc)
        return ack

    def shutdown(self) -> None:
        """Clean exit. Closes the brain client ONLY if the composite created it."""
        if self._owns_brain and self._brain is not None:
            close = getattr(self._brain, "shutdown", None) or getattr(
                self._brain, "close", None
            )
            if close is not None:
                try:
                    close()
                except Exception as exc:
                    logger.debug("brain shutdown failed: %s", exc)


__all__ = [
    "CompositeMemoryProvider",
    "SESSION_START_CALL_SITE",
    "TOOL_SIGNAL",
    "TOOL_FORGET",
]
