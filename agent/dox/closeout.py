from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent.dox.core import DoxError, _load_docops, status_project

_MODES = {"code", "ops", "hybrid"}


@dataclass(frozen=True)
class CloseoutStep:
    order: int
    step: str
    auto: bool | None
    layer: str
    notes: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "order": self.order,
            "step": self.step,
            "auto": self.auto,
            "layer": self.layer,
            "notes": self.notes,
        }


_DEFAULT_STEPS: dict[str, tuple[tuple[str, bool | None, str, str], ...]] = {
    "code": (
        (
            "read_contract",
            None,
            "Contract",
            "Walk root→target AGENTS.md before edit (agent behavior, via skill).",
        ),
        (
            "update_nearest_agents_md",
            False,
            "Contract",
            "Agent updates the closest owning AGENTS.md to reflect the change.",
        ),
        (
            "reconcile_child_index",
            True,
            "Contract",
            "Engine reconciles child-index tables (Tier A).",
        ),
        (
            "append_ledger",
            False,
            "Ledger",
            "Agent appends CHANGELOG / ADR / session-log entry.",
        ),
        (
            "size_gate",
            True,
            "Ledger",
            "Tier B: warn+record if changelog over size_limit_words; escapable on record.",
        ),
    ),
    "ops": (
        (
            "read_contract",
            None,
            "Contract",
            "Read contract + the workstream LIVE-STATUS.md.",
        ),
        (
            "update_live_status",
            False,
            "Publish",
            "Agent updates current-truth scoreboard.",
        ),
        (
            "update_checklist",
            False,
            "Publish",
            "Agent updates the wave/task checklist row (if checklist set).",
        ),
        ("append_session_log", False, "Ledger", "Audit entry."),
        (
            "append_ledger",
            False,
            "Ledger",
            "Ledger line only if the change is a durable program/tool change.",
        ),
        (
            "render_html",
            True,
            "Publish",
            "Engine re-renders the human pack HTML from markdown (html: derived).",
        ),
        (
            "refresh_manifest",
            True,
            "Publish",
            "Engine refreshes MANIFEST.json keys.",
        ),
        (
            "update_canvas_pointer",
            True,
            "Publish",
            "Engine points canvas_dir/index.html at the latest pack (index.html only).",
        ),
        (
            "size_gate",
            True,
            "Ledger",
            "Tier B on any size-governed markdown.",
        ),
    ),
}
_DEFAULT_STEPS["hybrid"] = tuple(
    list(_DEFAULT_STEPS["code"])
    + [step for step in _DEFAULT_STEPS["ops"] if step[0] not in {s[0] for s in _DEFAULT_STEPS["code"]}]
)


def _default_steps(mode: str) -> list[CloseoutStep]:
    return [CloseoutStep(order=i, step=step, auto=auto, layer=layer, notes=notes) for i, (step, auto, layer, notes) in enumerate(_DEFAULT_STEPS[mode], start=1)]


def _configured_steps(config: dict[str, Any]) -> list[CloseoutStep] | None:
    cascade = config.get("cascade")
    if cascade is None:
        return None
    if not isinstance(cascade, dict):
        raise DoxError("docops.yml: cascade must be a mapping")
    if "steps" not in cascade:
        return None
    raw_steps = cascade["steps"]
    if raw_steps is None:
        return None
    if not isinstance(raw_steps, list):
        raise DoxError("docops.yml: cascade.steps must be a list")

    steps: list[CloseoutStep] = []
    for i, raw in enumerate(raw_steps, start=1):
        if not isinstance(raw, dict):
            raise DoxError(f"docops.yml: cascade.steps[{i}] must be a mapping")
        name = raw.get("step")
        if not isinstance(name, str) or not name.strip():
            raise DoxError(f"docops.yml: cascade.steps[{i}].step must be a non-empty string")
        auto = raw.get("auto", False)
        if not isinstance(auto, bool):
            raise DoxError(f"docops.yml: cascade.steps[{i}].auto must be a boolean")
        layer = raw.get("layer", "Custom")
        if not isinstance(layer, str) or not layer.strip():
            raise DoxError(f"docops.yml: cascade.steps[{i}].layer must be a non-empty string")
        notes = raw.get("notes", "Configured cascade step.")
        if not isinstance(notes, str):
            raise DoxError(f"docops.yml: cascade.steps[{i}].notes must be a string")
        steps.append(CloseoutStep(order=i, step=name, auto=auto, layer=layer, notes=notes))
    return steps


def closeout_dry_run(root: str | Path = ".", *, mode: str | None = None) -> dict[str, Any]:
    """Return the ordered DOX closeout cascade without writing project files."""

    if mode is not None and mode not in _MODES:
        raise DoxError(f"mode must be one of {sorted(_MODES)}")
    root_path = Path(root).expanduser().resolve()
    config = _load_docops(root_path)
    status = status_project(root_path)
    resolved_mode = mode or status.get("mode") or config.get("mode") or "code"
    if resolved_mode not in _MODES:
        raise DoxError(f"mode must be one of {sorted(_MODES)}")

    steps = _configured_steps(config) or _default_steps(resolved_mode)
    return {
        "root": str(root_path),
        "mode": resolved_mode,
        "dry_run": True,
        "steps": [step.to_dict() for step in steps],
    }
