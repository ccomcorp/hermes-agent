from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

from hermes_constants import get_hermes_home

_PENDING_ADVISORY_REL = Path("dox") / "pending_advisories.jsonl"
_HEADER_RE = re.compile(r"(?:<!--\s*hermes-dox\s*-->|\bHermes\s+DOX\b|\bDOX\s*:\s*enabled\b)", re.I)
_MAX_PATHS_IN_CONTEXT = 8


def pending_advisory_path() -> Path:
    """Return the profile-scoped pending-advisory sink path."""
    return get_hermes_home() / _PENDING_ADVISORY_REL


def _coerce_paths(paths: Iterable[str | Path]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for raw in paths or []:
        text = str(raw or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _path_has_dox_marker(raw_path: str) -> bool:
    try:
        path = Path(raw_path).expanduser()
        current = path if path.is_dir() else path.parent
    except Exception:
        return False
    for parent in [current, *current.parents]:
        if (parent / "docops.yml").exists():
            return True
        agents = parent / "AGENTS.md"
        if agents.exists():
            try:
                head = "\n".join(agents.read_text(encoding="utf-8").splitlines()[:25])
            except (OSError, UnicodeDecodeError):
                head = ""
            if _HEADER_RE.search(head):
                return True
    return False


def record_pending_advisory(
    paths: Iterable[str | Path],
    *,
    session_id: str | None = None,
    reason: str = "meaningful_file_edit",
    require_dox_marker: bool = False,
) -> dict[str, Any] | None:
    """Append a pending DOX advisory under ``get_hermes_home()``.

    ``require_dox_marker`` lets the global file-mutation hook stay quiet for
    non-DOX projects, while unit tests and explicit DOX callers can record a
    known advisory directly.
    """
    normalized = _coerce_paths(paths)
    if require_dox_marker:
        normalized = [path for path in normalized if _path_has_dox_marker(path)]
    if not normalized:
        return None

    record: dict[str, Any] = {
        "ts": datetime.now(UTC).isoformat(),
        "reason": reason,
        "session_id": session_id or "",
        "paths": normalized,
    }
    path = pending_advisory_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    return record


def _read_pending_records() -> list[dict[str, Any]]:
    path = pending_advisory_path()
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for line in lines:
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            records.append(data)
    return records


def pending_advisory_count() -> int:
    """Return the count of parseable pending advisory records."""
    return len(_read_pending_records())


def drain_pending_advisories(*, session_id: str | None = None) -> list[dict[str, Any]]:
    """Drain pending advisories once, keeping other-session records intact."""
    path = pending_advisory_path()
    records = _read_pending_records()
    if not records:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
        return []

    sid = session_id or ""
    drained: list[dict[str, Any]] = []
    kept: list[dict[str, Any]] = []
    for record in records:
        record_sid = str(record.get("session_id") or "")
        if not sid or not record_sid or record_sid == sid:
            drained.append(record)
        else:
            kept.append(record)

    try:
        if kept:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                "".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in kept),
                encoding="utf-8",
                newline="\n",
            )
        else:
            path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        # Best effort: injection should never break a turn.
        pass
    return drained


def build_pending_advisory_context(records: Iterable[dict[str, Any]]) -> str:
    """Render pending advisories as compact user-message context."""
    paths: list[str] = []
    seen: set[str] = set()
    for record in records:
        raw_paths = record.get("paths") if isinstance(record, dict) else None
        if not isinstance(raw_paths, list):
            continue
        for raw in raw_paths:
            text = str(raw or "").strip()
            if text and text not in seen:
                seen.add(text)
                paths.append(text)
    if not paths:
        return ""

    shown = paths[:_MAX_PATHS_IN_CONTEXT]
    path_lines = "\n".join(f"- `{path}`" for path in shown)
    if len(paths) > len(shown):
        path_lines += f"\n- … and {len(paths) - len(shown)} more"
    return (
        "## DOX pending advisory\n\n"
        "A meaningful file edit landed in a Hermes DOX-aware project. Before "
        "continuing or claiming done, update the nearest owning AGENTS.md and "
        "the prompted ledger/publish docs as applicable; run `hermes dox status` "
        "and `hermes dox check --write` when relevant.\n\n"
        "Changed paths:\n"
        f"{path_lines}"
    )


def drain_pending_advisory_context(*, session_id: str | None = None) -> str:
    """Drain pending advisories and return a one-shot context reminder."""
    return build_pending_advisory_context(drain_pending_advisories(session_id=session_id))
