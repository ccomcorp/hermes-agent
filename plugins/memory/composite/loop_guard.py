"""Loop fail-loud guards (spec-loop-plugin-extraction §8, AC-PX5/PX6).

ONE risk dominates the extracted self-improvement loop: a chassis refactor or a mis-applied
upstream merge silently moves/drops a seam call-site, leaving the loop wired-but-dead — the
predecessor's "15 lessons, zero reads" death, re-armed. This module is the OWN-PROVIDER
fail-loud surface that catches that at three successively-later stages:

  1. STATIC  — :func:`verify_seam_fingerprint` greps the chassis files for the sentinel
     comments ``# AIOS-LOOP-SEAM:<id>`` planted at each of the four seam call-sites. A god-file
     refactor that relocates or removes one trips this BEFORE any silent break (used by the
     boot check below AND the AC-PX6 ``synthetic_week_ac1.py --fingerprint`` regression).
  2. BOOT    — :func:`assert_loop_wired` (called from ``HermesCompositeProvider.initialize``)
     asserts the ``MemoryManager`` still exposes the fan-out dispatch AND the seam fingerprint
     resolves. A lost patch RAISES :class:`LoopWiringError` (refuse-to-load), never warns.
  3. RUNTIME — the plugin's ``loop_self_check`` (present-but-unproductive backstop) lives on
     the provider; this module only owns the static + boot tripwires.

Foreign providers never reach this code — it is invoked only from the composite's own
``initialize``. Pure stdlib; the grep is a literal substring scan (no import of the chassis).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Tuple

# --- the seam fingerprint -------------------------------------------------------------------
#
# Each entry maps a sentinel-id -> the chassis file (repo-relative) that MUST carry the
# matching ``# AIOS-LOOP-SEAM:<id>`` comment at its loop call-site. The id set is the contract:
# every id here must resolve, and a stray/renamed sentinel is reported as missing.
SEAM_SITES: Dict[str, str] = {
    "background-review-write": os.path.join("agent", "background_review.py"),
    "delegation-recall": os.path.join("tools", "delegate_tool.py"),
    "delegation-confirm": os.path.join("tools", "delegate_tool.py"),
    "injection-confirm": os.path.join("agent", "conversation_loop.py"),
}

# The expected sentinel-id SET (what a correctly-wired chassis exposes).
CHASSIS_SEAM_FINGERPRINT = frozenset(SEAM_SITES.keys())

# The literal comment prefix planted at each call-site.
_SENTINEL_PREFIX = "# AIOS-LOOP-SEAM:"


class LoopWiringError(RuntimeError):
    """Raised by :func:`assert_loop_wired` when a wired-loop precondition is missing.

    A distinct type so the chassis (``MemoryManager.initialize_all``) can re-raise THIS
    refuse-to-boot error while keeping unrelated per-provider init failures as warnings —
    the loop must never boot silently-dead.
    """


def _repo_root() -> Path:
    """Resolve the hermes-agent repo root (``plugins/memory/composite/loop_guard.py`` ->
    ``parents[3]``)."""
    return Path(__file__).resolve().parents[3]


def _sentinel_for(seam_id: str) -> str:
    return f"{_SENTINEL_PREFIX}{seam_id}"


def verify_seam_fingerprint(repo_root: "str | os.PathLike | None" = None) -> Tuple[bool, List[str]]:
    """Grep the chassis seam files for every ``# AIOS-LOOP-SEAM:<id>`` sentinel.

    Returns ``(ok, missing)`` where ``missing`` lists the sentinel-ids whose comment was NOT
    found at the expected file (a missing/renamed sentinel, an absent file, or an unreadable
    one all count as missing — the seam is not provably present). ``ok`` is ``True`` iff every
    id in :data:`CHASSIS_SEAM_FINGERPRINT` resolved.

    ``repo_root`` overrides the resolved hermes-agent root (used by tests to point at a temp
    copy of the chassis files).
    """
    root = Path(repo_root) if repo_root is not None else _repo_root()
    # Read each file once (several seams may share a file).
    file_text: Dict[str, str] = {}
    missing: List[str] = []
    for seam_id, rel_path in SEAM_SITES.items():
        text = file_text.get(rel_path)
        if text is None:
            fpath = root / rel_path
            try:
                text = fpath.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                text = ""
            file_text[rel_path] = text
        if _sentinel_for(seam_id) not in text:
            missing.append(seam_id)
    return (not missing, sorted(missing))


def assert_loop_wired(memory_manager, *, repo_root: "str | os.PathLike | None" = None) -> None:
    """Boot wiring assertion (AC-PX5 #2, OWN PROVIDER ONLY).

    Refuse to load a silently-dead loop. Raises :class:`LoopWiringError` when EITHER:
      (a) the ``MemoryManager`` no longer exposes the fan-out dispatch methods
          (``on_background_review`` / ``recall_for_delegation`` / ``confirm_consumed``) — the
          carried patch was lost in an update; OR
      (b) the static seam fingerprint does not resolve (a call-site sentinel moved/dropped).

    On a correctly-wired boot this is a no-op (it MUST never raise on the live config — a
    false positive would prevent the desktop from starting).
    """
    required = ("on_background_review", "recall_for_delegation", "confirm_consumed")
    missing_methods = [
        name for name in required if not callable(getattr(memory_manager, name, None))
    ]
    if missing_methods:
        raise LoopWiringError(
            "composite loop refusing to boot: the MemoryManager fan-out dispatch is missing "
            f"{missing_methods} — the loop hooks were lost (likely a dropped patch after an "
            "upstream merge). Re-home the fan-out before booting (spec-loop-plugin-extraction "
            "§3.1 / AC-PX5 #2)."
        )
    ok, seam_missing = verify_seam_fingerprint(repo_root)
    if not ok:
        raise LoopWiringError(
            "composite loop refusing to boot: seam fingerprint check failed — missing sentinel "
            f"call-sites {seam_missing}. A chassis refactor moved or dropped a loop seam "
            f"(expected '# AIOS-LOOP-SEAM:<id>' at {[SEAM_SITES[m] for m in seam_missing]}). "
            "Re-home the seam(s) before booting (AC-PX5 #1/#2)."
        )


__all__ = [
    "SEAM_SITES",
    "CHASSIS_SEAM_FINGERPRINT",
    "LoopWiringError",
    "verify_seam_fingerprint",
    "assert_loop_wired",
]
