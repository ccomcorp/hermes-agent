"""Adversarial review routing.

Routes engineering changes to a separate reviewer agent using a different
model or agent.  The coder must not be the only reviewer.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional

from .schemas import ReviewerResult, ReviewerStatus

logger = logging.getLogger(__name__)

# Review prompt template — sent to the reviewer agent
_REVIEW_PROMPT = """You are an adversarial code reviewer. Your job is to find
problems, NOT to approve. Be skeptical. Look for:

- Missed acceptance criteria
- Failing or insufficient tests
- Overfitting or brittle logic
- Security or privacy issues
- Maintainability problems
- Hidden regressions
- Poor UX or accessibility
- Incomplete documentation
- Uncommitted artifacts
- Prompt/memory conflicts (for Hermes Agent architecture)

## Original Goal
{goal}

## Acceptance Criteria
{criteria}

## Loop Type
{loop_type}

## Changed Files
{changed_files}

## Diff
```diff
{diff}
```

## Verification Results
{verification_results}

## Known Risks
{risks}

## Instructions
Return EXACTLY one of these as your verdict:

- PASS — if you find NO issues
- CHANGES_REQUIRED — if you find ANY issue that needs fixing (list them)
- BLOCKED — if you cannot complete the review (explain why)

Format your response as JSON:
{{"verdict": "PASS|CHANGES_REQUIRED|BLOCKED", "feedback": "...", "action_items": ["..."]}}
"""


def build_review_context(
    goal: str,
    acceptance_criteria: List[str],
    loop_type: str,
    changed_files: List[str],
    diff: str,
    verification_results: str,
    risks: str = "",
) -> str:
    """Build the review prompt with full context."""
    changed_files_str = "\n".join(f"- {f}" for f in changed_files)
    criteria_str = "\n".join(f"- {c}" for c in acceptance_criteria)
    return _REVIEW_PROMPT.format(
        goal=goal,
        criteria=criteria_str or "(none)",
        loop_type=loop_type,
        changed_files=changed_files_str or "(none)",
        diff=diff[:8000],  # Cap diff size
        verification_results=verification_results,
        risks=risks or "(none)",
    )


def parse_review_response(response: str) -> ReviewerResult:
    """Parse the reviewer's JSON response into a ReviewerResult."""
    import json

    # Try to extract JSON from the response
    result = ReviewerResult(status=ReviewerStatus.BLOCKED)

    try:
        # Find JSON block
        start = response.find("{")
        end = response.rfind("}") + 1
        if start >= 0 and end > start:
            data = json.loads(response[start:end])
        else:
            result.feedback = f"Could not parse reviewer response as JSON:\n{response[:500]}"
            return result
    except json.JSONDecodeError:
        result.feedback = f"Could not parse reviewer response as JSON:\n{response[:500]}"
        return result

    verdict = data.get("verdict", "").strip().upper()
    if verdict == "PASS":
        result.status = ReviewerStatus.PASS
    elif verdict == "CHANGES_REQUIRED":
        result.status = ReviewerStatus.CHANGES_REQUIRED
    else:
        result.status = ReviewerStatus.BLOCKED

    result.feedback = data.get("feedback", "")
    result.action_items = data.get("action_items", [])
    return result


def check_same_model(
    main_model: str,
    main_provider: str,
    reviewer_model: str,
    reviewer_provider: str,
) -> bool:
    """Return True if the reviewer is the same model/provider as the main agent."""
    return (
        main_model.lower() == reviewer_model.lower()
        and main_provider.lower() == reviewer_provider.lower()
    )
