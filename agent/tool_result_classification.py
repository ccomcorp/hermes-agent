"""Shared helpers for classifying tool result payloads."""

from __future__ import annotations

import json
from typing import Any


FILE_MUTATING_TOOL_NAMES = frozenset({"write_file", "patch"})


# Tools whose interrupted/dangling execution is safe to discard because they
# cannot mutate either external state or Hermes session state. Unknown/plugin/
# MCP tools stay effect-capable by default.
NO_EFFECT_TOOL_NAMES = frozenset({
    "read_file", "search_files", "session_search", "skill_view", "skills_list",
    "web_extract", "web_search", "vision_analyze", "browser_snapshot",
    "browser_get_images", "browser_console", "read_terminal",
})


def tool_may_have_side_effect(tool_name: str) -> bool:
    return tool_name not in NO_EFFECT_TOOL_NAMES


def file_mutation_result_landed(tool_name: str, result: Any) -> bool:
    """Return True when a file mutation result proves the write landed."""
    if tool_name not in FILE_MUTATING_TOOL_NAMES or not isinstance(result, str):
        return False
    try:
        data = json.loads(result.strip())
    except Exception:
        return False
    if not isinstance(data, dict) or data.get("error"):
        return False
    if tool_name == "write_file":
        return "bytes_written" in data
    if tool_name == "patch":
        return data.get("success") is True
    return False


# --- Operator-misuse rejections vs environmental/transient errors -------------------
#
# A tool can return an {"error":...} payload for two very different reasons:
#   (a) OPERATOR MISUSE — the model called the tool wrong: unknown ref/id, invalid or
#       unknown argument, schema/validation failure, wrong type. THIS is a learnable
#       error (a future-self should recall "don't call it that way").
#   (b) ENVIRONMENTAL / TRANSIENT — the world said no: file not found, HTTP 404, network
#       timeout, rate limit, connection reset. NOT a misuse lesson; retrying or moving on
#       is the right response, and authoring a skill lesson about it is noise.
#
# ``_detect_tool_failure`` (display.py) flags BOTH as is_error (correct for logging/UX).
# The learning trigger must be narrower — only (a). This predicate draws that line.
#
# MATCHING DISCIPLINE (hardened after adversarial review):
#   - Misuse markers are matched as WHOLE WORDS/PHRASES via regex word boundaries, so a
#     marker word appearing inside a parameter NAME does not mis-fire — and conversely a
#     short environmental word inside an argument description ("timeout must be an int")
#     does NOT wrongly veto a real misuse rejection.
#   - Environmental markers that are short common words ("connection", "network", "timeout",
#     "offline") are matched only as MULTI-WORD environmental phrases; bare-word forms are
#     dropped precisely because they collide with legitimate parameter names/descriptions.

import re as _re

_REJECTION_MARKERS = (
    "unknownref", "unknown ref", "no such ref", "no lesson with",
    "invalid argument", "invalid arguments", "invalid parameter", "invalid parameters",
    "unknown argument", "unknown parameter", "unexpected keyword",
    "unexpected argument", "missing required", "required argument", "required parameter",
    "must be one of", "not a valid", "invalid value",
    "invalid type", "expected type", "expected one of", "expected argument",
    "is not valid", "constantvalenceerror", "unknownderivation",
    "unknown tool", "no such tool", "not a recognized", "argument schema", "parameter schema",
)

# Environmental phrases that VETO a misuse classification. Matched as whole words/phrases
# (boundary-anchored, same as the misuse markers) so a bare env word inside a parameter
# name ("offline_threshold", "retry_on_503") never wrongly vetoes a real misuse rejection.
# Bare ambiguous words ("connection","network","timeout") are still kept OUT in favour of
# unambiguous multi-word forms ("connection refused","request timeout") to avoid the inverse
# error (a misuse message mentioning a transient concept being read as environmental).
_ENVIRONMENTAL_MARKERS = (
    "not found", "no such file", "404", "rate limit", "429", "503", "502", "500 internal",
    "timed out", "request timeout", "connection refused", "connection reset",
    "connection error", "connection timed out", "network error", "network unreachable",
    "host unreachable", "unreachable host", "econnrefused", "etimedout", "permission denied",
    "try again later", "temporarily unavailable", "service unavailable", "offline",
)

_WORD = lambda marker, text: _re.search(r"(?<![a-z0-9_])" + _re.escape(marker) + r"(?![a-z0-9_])", text) is not None


def tool_result_is_rejection(tool_name: str, result: Any) -> bool:
    """Return True only for an OPERATOR-MISUSE rejection payload (learnable), not for an
    environmental/transient error. Gates the tool-rejection -> skill-review learning signal so
    a 404 / not-found / timeout does NOT spawn a background review.

    Conservative by construction: returns True only when the error text matches a known misuse
    marker as a whole word/phrase AND is not dominated by an environmental phrase. Anything
    ambiguous returns False (better to miss a learnable rejection than flood the review loop).

    Note (intentional): a payload using a bare ``{"message": "..."}`` with neither an ``error``
    key nor ``success: false`` is NOT treated as a rejection — the conservative bias again."""
    if not isinstance(result, str):
        return False
    try:
        data = json.loads(result.strip())
    except Exception:
        return False
    if not isinstance(data, dict):
        return False
    err = data.get("error") or data.get("message")
    if not err or not (data.get("success") is False or "error" in data):
        return False
    text = str(err).lower()
    # Environmental phrases veto FIRST. Boundary-anchored like the misuse markers so a bare
    # short/numeric env word ("offline", "429", "503") inside a PARAMETER name/description
    # ("offline_threshold", "retry_on_503") does not wrongly veto a real misuse rejection.
    if any(_WORD(m, text) for m in _ENVIRONMENTAL_MARKERS):
        return False
    # Misuse markers matched as whole words/phrases (boundary-anchored) to avoid sub-token hits.
    return any(_WORD(m, text) for m in _REJECTION_MARKERS)
