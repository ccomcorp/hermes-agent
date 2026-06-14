"""Thin SYNC blocking-HTTP adapter to the NeuroLinked brain (the ``BrainClient`` the
composite injects in the dev instance). Stdlib ``urllib`` only — no new dependency, no
persistent client to leak (so ``close()`` is a no-op and ``owns_brain`` is moot).

Design is the product of the M1 brain-add-on elicitation; the load-bearing choices:

  * **Short timeout, NO retries.** The reference RUFLOW client uses ``timeout=120`` +
    retries — catastrophic on any turn-adjacent path. Here every call is best-effort with
    a single attempt and a ≤~2.5s timeout; a slow/offline brain degrades, never stalls.
  * **``observe`` returns the brain ``observation_id`` (UUID string), not a bool.** The
    paired-reward (R-STDP, dW>0) path is keyed by that UUID; a bool drops the handle. The
    int ``id`` rowid is deliberately NOT returned — the feedback endpoint 422s on an int.
    A non-empty string stays truthy, so the base ``ok = brain.observe(...)`` guard is
    unaffected (backward compatible widening).
  * **``reward`` sends the SIGNED ``outcome`` float, not just ``was_helpful``.** The brain
    learns from failures via a negative outcome; collapsing to a bool throws the sign away
    and biases the brain toward constant-positive drift. ``was_helpful`` is sent too
    (the API takes both), derived from the sign.
  * **Reward status is honest:** ``ok`` ONLY for a paired (observation_id) HTTP-200 that
    produced a non-zero dW; ``degraded`` for the legacy no-id path, a dW=0 no-op, or a
    422 stale/unknown observation; ``fail`` for transport errors.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Single-source the per-backend ack constants from the contract when importable; fall back
# to the literal contract values so the adapter is usable even before sys.path is wired.
try:  # pragma: no cover - trivial import shim
    from backends import BRAIN_OK, BRAIN_DEGRADED, BRAIN_FAIL
except ImportError:  # pragma: no cover
    BRAIN_OK, BRAIN_DEGRADED, BRAIN_FAIL = "ok", "degraded", "fail"

_DEFAULT_TIMEOUT_S = 2.5
_DEFAULT_MAX_ITEM_CHARS = 2000
# Response keys that, if present and numeric, report the synaptic change of a reward.
_DW_KEYS = ("dW", "dw", "reward_dW_total", "weight_delta", "dw_total", "total_dW")
# Response containers a recall payload may use for its item list.
_RECALL_LIST_KEYS = ("results", "memories", "lessons", "items", "knowledge")
# Item keys that carry the recalled text, in precedence order (matches _merge_dedup).
_TEXT_KEYS = ("lesson", "content", "text", "memory", "summary")


class HttpBrainClient:
    """Blocking-HTTP ``BrainClient``. Methods degrade gracefully (return, never raise)."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = _DEFAULT_TIMEOUT_S,
        source: str = "hermes-agent",
        domain: Optional[str] = None,
        recall_limit: int = 5,
        max_item_chars: int = _DEFAULT_MAX_ITEM_CHARS,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = float(timeout)
        self._source = source
        self._domain = domain or ""
        self._recall_limit = int(recall_limit)
        self._max_item_chars = int(max_item_chars)

    # ----- transport ---------------------------------------------------------------

    def _request(self, path: str, method: str = "GET", data: Optional[dict] = None):
        """Single-attempt request. Returns ``(status_code, parsed_json_or_None, error)``.

        ``status_code`` is the HTTP code (or None on transport failure); ``error`` is the
        exception on transport/parse failure else None. No retries — best-effort by design.
        """
        url = f"{self._base_url}{path}"
        headers = {"Content-Type": "application/json"}
        body = json.dumps(data).encode("utf-8") if data is not None else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, (json.loads(raw) if raw else {}), None
        except urllib.error.HTTPError as exc:  # a response WITH a status (e.g. 422)
            try:
                parsed = json.loads(exc.read().decode("utf-8"))
            except Exception:
                parsed = None
            return exc.code, parsed, exc
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            return None, None, exc

    # ----- BrainClient surface -----------------------------------------------------

    def prefetch(self, query: str) -> list[dict[str, Any]]:
        """Cache-only recall (fast budget). Returns validated/clamped scored items; [] on
        miss/offline. Caps the item count to ``recall_limit`` and each text to
        ``max_item_chars`` BEFORE the items can reach the model context (R5)."""
        q = urllib.parse.quote(query or "")
        path = f"/api/claude/recall?q={q}&limit={self._recall_limit}"
        if self._domain:
            path += f"&domain={urllib.parse.quote(self._domain)}"
        code, payload, err = self._request(path, "GET")
        if err is not None or code != 200 or payload is None:
            if err is not None:
                logger.debug("brain prefetch failed: %s", err)
            return []
        return self._normalize_items(payload)

    def _normalize_items(self, payload: Any) -> list[dict[str, Any]]:
        """Validate/clamp recall items into ``[{content, score}, ...]``.

        Score resolution precedence: explicit ``score`` (numeric, used as-is) → else
        ``relevance`` (numeric, used as-is) → else ``strength`` consulted as a relevance
        proxy and squashed via ``s/(s+1)`` into ``[0, 1)`` (numeric, ``>= 0``) → else
        ``0.0``. The squash keeps brain items rankable among themselves while ensuring
        a brain item never outranks the store's authoritative 1.0 band (squash < 1.0)."""
        raw = payload
        if isinstance(payload, dict):
            raw = next((payload[k] for k in _RECALL_LIST_KEYS if isinstance(payload.get(k), list)), [])
        if not isinstance(raw, list):
            return []
        out: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue  # drop malformed (non-dict)
            text = next((item[k] for k in _TEXT_KEYS if item.get(k)), None)
            if not text:
                continue  # drop items with no recalled text
            out.append({
                "content": str(text)[: self._max_item_chars],
                "score": self._resolve_score(item),
            })
            if len(out) >= self._recall_limit:
                break
        return out

    @staticmethod
    def _resolve_score(item: dict[str, Any]) -> float:
        """Explicit ``score`` → ``relevance`` → squashed ``strength`` → ``0.0`` (see
        ``_normalize_items``). ``strength`` is squashed into ``[0, 1)`` so it ranks
        within the brain band without reaching the store's authoritative 1.0."""
        score = item.get("score")
        if isinstance(score, (int, float)):
            return float(score)
        relevance = item.get("relevance")
        if isinstance(relevance, (int, float)):
            return float(relevance)
        strength = item.get("strength")
        if isinstance(strength, (int, float)) and strength >= 0:
            s = float(strength)
            return s / (s + 1.0)
        return 0.0

    def observe(self, record: dict[str, Any]) -> Optional[str]:
        """Fire-and-forget observation. Returns the brain ``observation_id`` (UUID string)
        on success, ``None`` if offline. The UUID — not the int rowid — is what the paired
        reward path needs."""
        payload = {
            "type": record.get("type", "text"),
            "content": record.get("content", ""),
            "source": self._source,
        }
        code, body, err = self._request("/api/claude/observe", "POST", payload)
        if err is not None or code != 200 or not isinstance(body, dict):
            if err is not None:
                logger.debug("brain observe failed: %s", err)
            return None
        obs_id = body.get("observation_id")
        return str(obs_id) if obs_id else None

    def reward(
        self,
        ref: str = "",
        *,
        valence: float,
        derivation: str,
        observation_id: Optional[str] = None,
        session_id: str = "",
    ) -> str:
        """Deliver a reward. Returns ``BRAIN_OK`` / ``BRAIN_DEGRADED`` / ``BRAIN_FAIL``.

        Sends the SIGNED ``outcome`` (so failures punish) plus ``was_helpful`` for the
        boolean R-STDP channel. ``ok`` is reported ONLY for a paired HTTP-200 with a
        non-zero dW; the legacy no-id path, a dW=0 no-op, and a 422 stale id are all
        ``degraded`` (HTTP-200-but-not-learning); transport failure is ``fail``.
        """
        payload: dict[str, Any] = {
            "session_id": session_id or ref or "",
            "was_helpful": bool(valence > 0),
            "outcome": float(valence),
            "derivation": derivation,
        }
        paired = bool(observation_id)
        if paired:
            payload["observation_id"] = observation_id
        code, body, err = self._request("/api/claude/feedback", "POST", payload)
        if err is not None and code is None:
            logger.debug("brain reward transport failure: %s", err)
            return BRAIN_FAIL
        if code == 422:
            logger.debug("brain reward 422 (stale/unknown observation): %s", observation_id)
            return BRAIN_DEGRADED
        if code != 200:
            return BRAIN_FAIL
        if not paired:
            return BRAIN_DEGRADED  # legacy freshness-only path is NOT the learning path
        dw = self._extract_dw(body)
        if dw is not None and dw == 0.0:
            return BRAIN_DEGRADED  # HTTP-200 but no synaptic change (dW=0)
        return BRAIN_OK  # paired + (dW != 0 or dW unreported on a known-live brain)

    @staticmethod
    def _extract_dw(body: Any) -> Optional[float]:
        if not isinstance(body, dict):
            return None
        for k in _DW_KEYS:
            v = body.get(k)
            if isinstance(v, (int, float)):
                return float(v)
        return None

    def ping(self) -> dict[str, Any]:
        """Liveness probe (logged at build). Returns ``{"ok": bool, "detail": ...}``."""
        code, body, err = self._request("/api/claude/status", "GET")
        if err is None and code == 200:
            return {"ok": True, "detail": body}
        return {"ok": False, "detail": str(err) if err else f"HTTP {code}"}

    def close(self) -> None:
        """No persistent client (urllib opens per-call), so nothing to close."""
        return None


__all__ = ["HttpBrainClient"]
