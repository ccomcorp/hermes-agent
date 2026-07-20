"""Deterministic route-advisor scoring signals.

Ported from OmniRoute's MIT-licensed specificity scorer, with the Hermes
rescope described in H-CIC spec 2026-07-20 Part B:
- github.com/diegosouzapw/OmniRoute open-sse/services/specificityRules.ts
- github.com/diegosouzapw/OmniRoute open-sse/services/specificityDetector.ts

Hermes intentionally scores only the current user turn. The original
``toolCalling`` rule inspected the request ``tools[]`` array; that is constant
inside a Hermes session, so this port replaces it with implementation-intent
keywords and caps the signal at 3 instead of 10.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import re
from typing import Dict, List

SIGNAL_KEYS = (
    "code_complexity",
    "math_complexity",
    "reasoning_depth",
    "context_size",
    "tool_calling",
    "domain_specificity",
)

_TRIGGER_NAMES = {
    "code_complexity": "code-complexity",
    "math_complexity": "math-complexity",
    "reasoning_depth": "reasoning-depth",
    "context_size": "context-size",
    "tool_calling": "tool-calling",
    "domain_specificity": "domain-specificity",
}


@dataclass(frozen=True)
class SpecificityAnalysis:
    """Deterministic complexity analysis for a single user turn."""

    score: int
    level: str
    signals: Dict[str, int]
    input_tokens: int
    triggered_signals: List[str]


def estimate_tokens(text: str) -> int:
    return int(math.ceil(len(text) / 4))


def _count_patterns(text: str, patterns: list[str], flags: int = 0) -> int:
    return sum(len(re.findall(pattern, text, flags)) for pattern in patterns)


def detect_code_complexity(text: str) -> int:
    code_block_count = len(re.findall(r"```[\s\S]*?```", text))
    inline_code_count = len(re.findall(r"`[^`]+`", text))
    lang_matches = _count_patterns(
        text,
        [
            r"\bfunction\s+\w+\s*\(",
            r"\bconst\s+\w+\s*=",
            r"\bimport\s+.*\bfrom\b",
            r"\bimport\s+[\w.,\s]+",
            r"\bclass\s+\w+",
            r"\binterface\s+\w+",
            r"\basync\s+function\b",
            r"\bdef\s+\w+\s*\(",
            r"\bSELECT\s+.*\bFROM\b",
            r"\$\{.*?\}",
        ],
        re.IGNORECASE,
    )
    raw = code_block_count * 5 + inline_code_count * 0.5 + lang_matches * 2
    return min(25, round(raw))


def detect_math_complexity(text: str) -> int:
    latex_count = len(re.findall(r"\$\$[\s\S]*?\$\$|\$[^$]+\$", text))
    math_matches = _count_patterns(
        text,
        [
            r"[+\-*/^]=",
            r"\b(?:sin|cos|tan|log|sqrt|sum|prod|int|lim)\b",
            r"\b\d+\s*[+\-*/]\s*\d+\s*=",
            r"∑|∏|∫|√|∞|π",
            r"\bf'(?:x)?\b",
            r"\bdx\b",
        ],
        re.IGNORECASE,
    )
    raw = latex_count * 4 + math_matches * 1.5
    return min(20, round(raw))


def detect_reasoning_depth(text: str, message_count: int = 1) -> int:
    reason_matches = _count_patterns(
        text,
        [
            r"\b(?:first|step\s*\d|secondly|finally|therefore|thus|consequently|because|since)\b",
            r"\b(?:let me think|let's reason|let's analyze|step by step|breaking this down)\b",
            r"\b(?:we need to|we must|we should|the approach is|the solution involves)\b",
            r"(?:\d+\.\s+)(?:\w+)",
            r"\b(?:if\s+.+\s+then\s+|assuming\s+|suppose\s+|consider\s+that)\b",
        ],
        re.IGNORECASE,
    )
    message_depth_bonus = min(5, max(0, int(message_count or 0)))
    raw = reason_matches * 2 + message_depth_bonus
    return min(20, round(raw))


def detect_context_size(text: str) -> int:
    total_tokens = estimate_tokens(text)
    if total_tokens > 64000:
        return 15
    if total_tokens > 32000:
        return 12
    if total_tokens > 16000:
        return 9
    if total_tokens > 8000:
        return 6
    if total_tokens > 4000:
        return 4
    if total_tokens > 1000:
        return 2
    return 0


def detect_tool_calling(text: str) -> int:
    """Implementation-intent keyword substitute for OmniRoute's tools[] rule."""

    matches = _count_patterns(
        text,
        [
            r"\b(?:open|inspect|read|search|find)\s+(?:the\s+)?(?:file|files|path|paths|repo|repository|codebase)\b",
            r"\b(?:file|files|path|paths|repo|repository|codebase)\b",
            r"\b(?:implement|patch|edit|modify|fix|debug|refactor)\b",
            r"\b(?:run|execute)\s+(?:the\s+)?(?:test|tests|build|lint|typecheck|command|script)\b",
            r"\b(?:test|tests|build|lint|typecheck|command|terminal|script)\b",
        ],
        re.IGNORECASE,
    )
    if matches >= 6:
        return 3
    if matches >= 3:
        return 2
    if matches >= 1:
        return 1
    return 0


def detect_domain_specificity(text: str) -> int:
    domain_terms = {
        "medical": [r"\bdiagnosis\b", r"\bsymptoms\b", r"\btreatment\b", r"\bpatient\b", r"\bclinical\b"],
        "legal": [r"\bpursuant\b", r"\bstatute\b", r"\bliability\b", r"\bjurisdiction\b", r"\bhereby\b"],
        "scientific": [r"\bhypothesis\b", r"\bmethodology\b", r"\bempirical\b", r"\bsignificant\b"],
        "financial": [r"\bportfolio\b", r"\bdividend\b", r"\bamortization\b", r"\barbitrage\b"],
    }
    max_domain_score = 0
    for terms in domain_terms.values():
        score = sum(2 for pattern in terms if re.search(pattern, text, re.IGNORECASE))
        max_domain_score = max(max_domain_score, score)
    return min(10, max_domain_score)


def specificity_level(score: int) -> str:
    if score <= 5:
        return "trivial"
    if score <= 20:
        return "simple"
    if score <= 40:
        return "moderate"
    if score <= 65:
        return "complex"
    return "expert"


def analyze_text(text: str, message_count: int = 1) -> SpecificityAnalysis:
    current_text = text if isinstance(text, str) else ""
    signals = {
        "code_complexity": detect_code_complexity(current_text),
        "math_complexity": detect_math_complexity(current_text),
        "reasoning_depth": detect_reasoning_depth(current_text, message_count=message_count),
        "context_size": detect_context_size(current_text),
        "tool_calling": detect_tool_calling(current_text),
        "domain_specificity": detect_domain_specificity(current_text),
    }
    score = sum(signals.values())
    triggered = [_TRIGGER_NAMES[key] for key in SIGNAL_KEYS if signals.get(key, 0) > 0]
    return SpecificityAnalysis(
        score=score,
        level=specificity_level(score),
        signals=signals,
        input_tokens=estimate_tokens(current_text),
        triggered_signals=triggered,
    )
