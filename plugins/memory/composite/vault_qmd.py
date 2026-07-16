"""Thin SYNC vault recall-cache adapter over QMD (the ``VaultCache`` the composite injects
in the dev instance). QMD is the retrieval layer: a Node CLI (``@tobilu/qmd``) over a local
sqlite index (``I:/QMD/index.sqlite``), exposing ``qmd search <q> --json`` — a pure BM25
full-text query with NO LLM expansion and NO API key, so it is cheap and offline-safe.

This is the dev-instance binding of the AIOS composite-provider ``VaultCache`` Protocol
(``backends.py``): a single SYNC ``recall(query) -> list[{content, score}]`` that returns
``[]`` on any miss/offline/error (fail-open, NEVER raises).

Design — carried from the brain-leg (``brain_http.py``) elicitation and the M1 SPEC:

  * **Off the hot path by contract.** The composite calls ``vault.recall`` ONLY inside
    ``queue_prefetch`` (the chassis ``mem-sync`` background worker), caching the result for
    the next ``prefetch``; ``prefetch`` itself reads the warm cache and does NO inline vault
    call. So a CLI subprocess spawn here (~0.7s BM25) never blocks a turn (R4 / Sev-4).
  * **``qmd search`` (BM25), not ``qmd query``.** ``query`` runs LLM expansion + reranking
    (slow, key-dependent); ``search`` is the fast deterministic full-text path — the right
    budget for a cache warm.
  * **Short timeout, single attempt, fail-open.** Every call is best-effort: a timeout,
    a missing binary/index, a non-zero exit, or malformed JSON all degrade to ``[]``.
  * **k <= recall_limit cap + per-item text clamp** BEFORE items can reach the model context
    (R5), and score is normalised into ``[0, 1)`` so a vault item never outranks the store's
    authoritative 1.0 band in ``_merge_dedup`` (parity with the brain leg's squash).

QMD source wiring is REAL here (live ``qmd search``). What is intentionally minimal for M1
(and a candidate for the M3 retrieval milestone) is recall QUALITY: this leg uses BM25 only,
not QMD's hybrid vec/hyde rerank — that richer retrieval is deferred so vault recall stays
cheap and key-free on the dev desktop. The leg is correct and contributes to merged recall now.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, List, Optional

logger = logging.getLogger(__name__)

# Item keys QMD `search --json` may use for the recalled text, in precedence order
# (matches the composite _merge_dedup text resolution: lesson > content > text).
_TEXT_KEYS = ("snippet", "title", "content", "text")

_DEFAULT_TIMEOUT_S = 4.0
_DEFAULT_MAX_ITEM_CHARS = 2000

# Default QMD install on the dev desktop (npm global). Overridable via HERMES_VAULT_QMD_JS.
_DEFAULT_QMD_JS = (
    "C:/Users/LogosOne/AppData/Roaming/npm/node_modules/@tobilu/qmd/dist/cli/qmd.js"
)
# Default QMD sqlite index (env INDEX_PATH the CLI reads). Overridable via HERMES_VAULT_INDEX.
_DEFAULT_INDEX_PATH = "I:/QMD/index.sqlite"
# Default Node for QMD better-sqlite3 (ABI 137 = Node 24). Do NOT fall back to bare
# "node": launch-dev-hermes.ps1 pins Hermes managed Node 22 first on PATH for the
# Electron rebuild, and node22 dlopen-fails QMD's better-sqlite3 (silent empty vault).
# Overridable via HERMES_VAULT_NODE. (Pin verified 2026-07-15.)
_DEFAULT_NODE_BIN = "C:/Program Files/nodejs/node.exe"

# Substrings in QMD's stderr that mean the native engine (better-sqlite3) could not LOAD
# under this Node runtime (wrong ABI / Node 22 vs the required Node 24 / ABI 137) — i.e. a
# misconfiguration, NOT a normal empty result. When these appear we notify LOUDLY (warn-once)
# instead of the quiet debug used for genuine misses. See SPEC-hermes-parameterization-failloud.
_ENGINE_FAIL_MARKERS = (
    "ERR_DLOPEN_FAILED",
    "NODE_MODULE_VERSION",
    "was compiled against a different Node.js version",
    "could not locate the bindings file",
    "invalid ELF header",
    "is not a valid Win32 application",
)


def _is_engine_failure(stderr: str) -> bool:
    """True if QMD stderr indicates a native-module load failure (ABI/Node mismatch)."""
    s = stderr or ""
    return any(m in s for m in _ENGINE_FAIL_MARKERS)


def _resolve_node_bin(node_bin: Optional[str] = None) -> str:
    """Prefer explicit arg / HERMES_VAULT_NODE / Node 24 default; last resort PATH ``node``."""
    candidates = [
        node_bin,
        os.environ.get("HERMES_VAULT_NODE"),
        _DEFAULT_NODE_BIN,
        "node",
    ]
    for c in candidates:
        if not c:
            continue
        if os.path.sep in c or "/" in c:
            if Path(c).is_file():
                return c
            continue
        # bare name
        if shutil.which(c):
            return c
    return node_bin or os.environ.get("HERMES_VAULT_NODE") or _DEFAULT_NODE_BIN or "node"


class QmdVaultCache:
    """Blocking-subprocess ``VaultCache`` over ``qmd search``. ``recall`` degrades to ``[]``
    on any failure (offline/absent binary/timeout/parse error) — it NEVER raises."""

    def __init__(
        self,
        *,
        qmd_js: Optional[str] = None,
        index_path: Optional[str] = None,
        node_bin: Optional[str] = None,
        collection: Optional[str] = None,
        timeout: float = _DEFAULT_TIMEOUT_S,
        recall_limit: int = 5,
        max_item_chars: int = _DEFAULT_MAX_ITEM_CHARS,
    ) -> None:
        self._qmd_js = qmd_js or os.environ.get("HERMES_VAULT_QMD_JS") or _DEFAULT_QMD_JS
        self._index_path = (
            index_path or os.environ.get("HERMES_VAULT_INDEX") or _DEFAULT_INDEX_PATH
        )
        self._node_bin = _resolve_node_bin(node_bin)
        self._collection = collection or os.environ.get("HERMES_VAULT_COLLECTION") or ""
        self._timeout = float(timeout)
        self._recall_limit = int(recall_limit)
        self._max_item_chars = int(max_item_chars)
        # Warn-once latch: an engine (ABI) load failure is a misconfig, notified LOUDLY the
        # first time only, so a broken vault never degrades silently (fail-safe + fail-loud).
        self._engine_warned = False

    # ----- availability -----------------------------------------------------------

    def is_available(self) -> bool:
        """True only if the QMD CLI script AND its sqlite index both exist AND a node
        runtime is resolvable. Used by ``build_provider`` to decide whether to construct
        the leg at all (an absent QMD must leave ``vault=None``, not a leg that always
        returns ``[]``). Pure filesystem/which checks — no subprocess, no I/O on the index.
        """
        if not Path(self._qmd_js).is_file():
            return False
        if not Path(self._index_path).is_file():
            return False
        # Absolute node path → check the file; bare name → resolve on PATH.
        if os.path.sep in self._node_bin or "/" in self._node_bin:
            return Path(self._node_bin).is_file()
        return shutil.which(self._node_bin) is not None

    def health(self) -> dict[str, Any]:
        """Actively probe the vault engine so an EXPECTED-but-broken leg is caught at build,
        not silently at recall. Runs one short ``qmd search`` and classifies the outcome:

          * ``ok``          — engine loaded and ran (recall will work).
          * ``missing``     — QMD CLI or index file absent (leg intentionally absent).
          * ``engine_fail`` — native-module/ABI load failure (wrong Node; the silent-empty trap).
          * ``error``       — other non-zero/transport failure.

        Never raises. Returns ``{ok, reason, detail}``.
        """
        if not Path(self._qmd_js).is_file() or not Path(self._index_path).is_file():
            return {"ok": False, "reason": "missing", "detail": "qmd_js or index not found"}
        cmd = [self._node_bin, self._qmd_js, "search", "healthcheck", "--json"]
        env = dict(os.environ)
        env["INDEX_PATH"] = self._index_path
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True,
                timeout=min(self._timeout, 6.0), env=env, check=False,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            return {"ok": False, "reason": "error", "detail": str(exc)[:200]}
        if proc.returncode == 0:
            return {"ok": True, "reason": "ok", "detail": ""}
        if _is_engine_failure(proc.stderr):
            return {"ok": False, "reason": "engine_fail", "detail": (proc.stderr or "")[:200]}
        return {"ok": False, "reason": "error", "detail": (proc.stderr or "")[:200]}

    # ----- VaultCache surface -----------------------------------------------------

    def recall(self, query: str) -> List[dict[str, Any]]:
        """Fast BM25 cache recall via ``qmd search <query> --json``. Returns validated/
        clamped ``[{content, score}, ...]`` capped to ``recall_limit``; ``[]`` on empty
        query, miss, offline, timeout, or any parse/transport failure (fail-open)."""
        q = (query or "").strip()
        if not q:
            return []
        cmd = [self._node_bin, self._qmd_js, "search", q, "--json"]
        if self._collection:
            cmd += ["--collection", self._collection]
        env = dict(os.environ)
        env["INDEX_PATH"] = self._index_path
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
                env=env,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            logger.debug("vault recall (qmd search) failed: %s", exc)
            return []
        if proc.returncode != 0:
            if _is_engine_failure(proc.stderr) and not self._engine_warned:
                self._engine_warned = True
                logger.warning(
                    "composite vault leg DEGRADED: QMD engine failed to load under node '%s' "
                    "(native-module/ABI mismatch) -> recall is returning EMPTY. Set HERMES_VAULT_NODE "
                    "to Node 24 (ABI 137). stderr: %s",
                    self._node_bin, (proc.stderr or "")[:200],
                )
            else:
                logger.debug("vault recall (qmd search) exit=%s: %s", proc.returncode, proc.stderr[:200])
            return []
        try:
            payload = json.loads(proc.stdout or "[]")
        except (ValueError, TypeError) as exc:
            logger.debug("vault recall (qmd search) bad json: %s", exc)
            return []
        return self._normalize_items(payload)

    def _normalize_items(self, payload: Any) -> List[dict[str, Any]]:
        """Validate/clamp QMD items into ``[{content, score}, ...]``.

        QMD ``search --json`` returns a top-level list of ``{docid, score, file, title,
        snippet, ...}``. Text precedence: ``snippet`` → ``title`` → ``content`` → ``text``
        (an item with none is dropped). Score: a numeric ``score`` squashed via ``s/(s+1)``
        into ``[0, 1)`` so a vault item ranks among itself but never reaches the store's
        authoritative 1.0 band in ``_merge_dedup`` (BM25 scores can exceed 1.0)."""
        raw = payload
        if isinstance(payload, dict):  # tolerate {results:[...]} shape defensively
            raw = next(
                (payload[k] for k in ("results", "items", "matches") if isinstance(payload.get(k), list)),
                [],
            )
        if not isinstance(raw, list):
            return []
        out: List[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue  # drop malformed (non-dict)
            text = next((item[k] for k in _TEXT_KEYS if item.get(k)), None)
            if not text:
                continue  # drop items with no recalled text
            out.append(
                {
                    "content": str(text)[: self._max_item_chars],
                    "score": self._resolve_score(item),
                }
            )
            if len(out) >= self._recall_limit:
                break
        return out

    @staticmethod
    def _resolve_score(item: dict[str, Any]) -> float:
        """Numeric ``score`` squashed into ``[0, 1)`` via ``s/(s+1)`` (>= 0); else ``0.0``.
        The squash keeps vault items rankable among themselves while ensuring a vault item
        never outranks the store's authoritative 1.0 band in ``_merge_dedup``."""
        score = item.get("score")
        if isinstance(score, (int, float)) and score >= 0:
            s = float(score)
            return s / (s + 1.0)
        return 0.0


__all__ = ["QmdVaultCache"]
