"""WF1 — pure data-transform + flow node evaluators (spec 12b; Kun's data group).

Pure Python, no chassis, no side effects. The engine (WF2) calls these directly
for PURE_KINDS *after* WorkflowGuard.dispatch has charged the budget — so nothing
here needs a guard. Typed dataflow: each node transforms the payload flowing from
its upstream node(s). Structured condition eval only (no eval/Function/vm),
carrying forward Slice-N's hardening.
"""

from __future__ import annotations

import json as _json
from typing import Any


class WorkflowNodeError(Exception):
    """A pure node received input it cannot process (bad config / wrong shape)."""


# --------------------------------------------------------------------------- helpers

def _resolve(operand: Any, payload: Any) -> Any:
    """A ``$field`` / ``$a.b`` string reads from the payload; anything else is a literal."""
    if isinstance(operand, str) and operand.startswith("$"):
        cur: Any = payload
        for part in operand[1:].split("."):
            if isinstance(cur, dict):
                cur = cur.get(part)
            else:
                return None
        return cur
    return operand


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def evaluate_condition(config: dict, payload: Any) -> bool:
    """Structured comparison: leftExpr / operator / rightValue / caseSensitive."""
    left = _resolve(config.get("leftExpr"), payload)
    right = _resolve(config.get("rightValue"), payload)
    op = config.get("operator", "equals")
    cs = bool(config.get("caseSensitive", False))

    if op == "is_empty":
        return left in (None, "", [], {}, ())
    if isinstance(left, str) and isinstance(right, str) and not cs:
        left, right = left.lower(), right.lower()

    if op == "equals":
        return left == right
    if op == "not_equals":
        return left != right
    if op == "contains":
        try:
            return right in left  # substring or membership
        except TypeError:
            return False
    if op in ("greater_than", "less_than"):
        ln, rn = _num(left), _num(right)
        if ln is None or rn is None:
            return False
        return ln > rn if op == "greater_than" else ln < rn
    raise WorkflowNodeError(f"unknown condition operator '{op}'")


def _as_list(payload: Any) -> list:
    if isinstance(payload, list):
        return payload
    if payload is None:
        return []
    return [payload]


# --------------------------------------------------------------------------- node dispatch

def run_pure_node(kind: str, config: dict, payload: Any, inputs: list[Any] | None = None) -> Any:
    """Evaluate a pure/flow node. ``payload`` = the primary upstream output;
    ``inputs`` = all upstream outputs (for merge). Returns this node's output."""
    config = config or {}
    inputs = inputs if inputs is not None else ([] if payload is None else [payload])

    if kind in ("manual-trigger",):
        return config.get("payload", {})

    if kind == "set-fields":
        base = dict(payload) if isinstance(payload, dict) else {}
        base.update(config.get("fields") or {})
        return base

    if kind == "template":
        text = str(config.get("template", ""))
        src = payload if isinstance(payload, dict) else {}
        for key, val in src.items():
            text = text.replace("{{" + str(key) + "}}", str(val))
        return {"text": text}

    if kind == "json":
        mode = config.get("mode", "stringify")
        if mode == "parse":
            try:
                return _json.loads(payload if isinstance(payload, str) else _json.dumps(payload))
            except (ValueError, TypeError) as exc:
                raise WorkflowNodeError(f"json parse failed: {exc}") from exc
        return {"text": _json.dumps(payload, ensure_ascii=False)}

    if kind == "filter":
        return [item for item in _as_list(payload) if evaluate_condition(config, item)]

    if kind == "sort":
        key = config.get("key")
        reverse = config.get("order") == "desc"
        items = _as_list(payload)

        def _k(it: Any) -> Any:
            v = it.get(key) if (key and isinstance(it, dict)) else it
            return (v is None, v)  # None sorts last, stable across types by (flag, v)

        try:
            return sorted(items, key=_k, reverse=reverse)
        except TypeError:
            return sorted(items, key=lambda it: str(_k(it)), reverse=reverse)

    if kind == "limit":
        try:
            n = int(config.get("count", 10))
        except (TypeError, ValueError):
            n = 10
        return _as_list(payload)[: max(0, n)]

    if kind == "aggregate":
        items = _as_list(payload)
        field = config.get("field")
        op = config.get("op", "count")
        if op == "count":
            return {"value": len(items)}
        nums = [n for n in (_num(it.get(field) if isinstance(it, dict) else it) for it in items) if n is not None]
        if op == "sum":
            return {"value": sum(nums)}
        if op == "avg":
            return {"value": (sum(nums) / len(nums)) if nums else 0}
        if op == "min":
            return {"value": min(nums) if nums else None}
        if op == "max":
            return {"value": max(nums) if nums else None}
        raise WorkflowNodeError(f"unknown aggregate op '{op}'")

    if kind == "merge":
        if all(isinstance(i, dict) for i in inputs):
            out: dict = {}
            for i in inputs:
                out.update(i)
            return out
        merged: list = []
        for i in inputs:
            merged.extend(_as_list(i))
        return merged

    if kind == "output":
        return payload

    raise WorkflowNodeError(f"'{kind}' is not a pure node kind")


def switch_target(config: dict, payload: Any) -> str | None:
    """Return the label of the first matching case, else the default (or None)."""
    for case in config.get("cases") or []:
        if evaluate_condition(case.get("when") or {}, payload):
            return case.get("label")
    return config.get("default")
