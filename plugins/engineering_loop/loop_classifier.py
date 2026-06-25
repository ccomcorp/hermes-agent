"""Loop type classification — deterministic vs non-deterministic vs hybrid.

Classifies engineering work based on task description, acceptance criteria,
and project characteristics to determine which gate strategy to apply.
"""

from __future__ import annotations

import re
from typing import List

from .schemas import LoopType

# Keywords that signal deterministic work
_DETERMINISTIC_SIGNALS = [
    "test", "tests", "testing", "pytest", "unittest",
    "build", "compile", "lint", "typecheck", "type check",
    "ci", "continuous integration", "pipeline",
    "migrate", "migration", "schema change",
    "fix bug", "bug fix", "patch", "hotfix",
    "refactor", "clean up", "cleanup",
    "api", "endpoint", "endpoints",
    "performance", "optimize", "benchmark",
    "security fix", "vulnerability", "cve",
    "dependency update", "upgrade",
]

# Keywords that signal non-deterministic (subjective) work
_NON_DETERMINISTIC_SIGNALS = [
    "ui", "ux", "user interface", "user experience",
    "design", "visual", "look and feel", "aesthetic",
    "layout", "style", "styling", "css", "tailwind",
    "copy", "copywriting", "wording", "text",
    "brand", "branding", "logo",
    "responsive", "mobile-first",
    "animation", "transition", "interaction",
    "color", "colour", "font", "typography",
    "image", "asset", "icon", "illustration",
    "polish", "polishing",
    "accessibility", "a11y", "wcag",
    "dark mode", "light mode", "theme",
]


def classify_loop(
    goal: str,
    acceptance_criteria: List[str],
    changed_files: List[str],
) -> LoopType:
    """Classify engineering work as deterministic, non-deterministic, or hybrid.

    Uses the goal text, acceptance criteria, and file paths to determine
    the appropriate loop type.
    """
    text = _normalize(goal)
    text += " " + " ".join(_normalize(c) for c in acceptance_criteria)

    has_det = _has_signals(text, _DETERMINISTIC_SIGNALS)
    has_non_det = _has_signals(text, _NON_DETERMINISTIC_SIGNALS)

    # Check file paths for additional signals
    for f in changed_files:
        norm = _normalize(f)
        if any(ext in norm for ext in [".css", ".scss", ".less", ".svg", ".png", ".jpg"]):
            has_non_det = True
        if any(ext in norm for ext in [".test.", "_test.", "test_", "conftest"]):
            has_det = True

    if has_det and not has_non_det:
        return LoopType.DETERMINISTIC
    if has_non_det and not has_det:
        return LoopType.NON_DETERMINISTIC
    if has_det and has_non_det:
        return LoopType.HYBRID

    # Default to hybrid when unclear
    return LoopType.HYBRID


def _normalize(text: str) -> str:
    """Normalize text for keyword matching."""
    return text.lower().strip()


def _has_signals(text: str, signals: List[str]) -> bool:
    """Check if any signal keyword appears in the text."""
    for signal in signals:
        pattern = r"\b" + re.escape(signal) + r"\b"
        if re.search(pattern, text):
            return True
    return False
