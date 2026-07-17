"""Spoken reply pipeline for voice conversational mode.

When ``voice.speak_mode == "conversational"``, the full assistant message is
not spoken verbatim. Instead:

1. ``needs_rewrite()`` detects structured content (code blocks, lists, tables,
   rich markdown) that wouldn't sound natural read aloud.
2. If the text needs rewriting, the ``auxiliary.spoken_summary`` model is asked
   to produce a concise spoken version.
3. ``buildSpokenReply()`` applies character/word caps and strips markdown
   for the fallback path (when the auxiliary model is unavailable or the text
   doesn't need rewriting but exceeds caps).
4. The resulting ``spoken_reply`` is persisted in the session DB alongside the
   full assistant message and delivered to the TTS pipeline instead of the
   raw text.

Tests: ``tests/agent/test_spoken_reply.py`` (EVAL-VDP-001 through EVAL-VDP-008).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional, Tuple


@dataclass
class SpokenReplyCaps:
    """Char/word limits for spoken replies (conversational mode).

    Defaults aligned with a multi-sentence spoken answer (~paragraph),
    not a full essay. Override via voice.spoken_max_chars / spoken_max_words.
    """

    max_words: int = 900
    max_chars: int = 5000


@dataclass
class SpokenReply:
    """The result of the spoken reply pipeline.

    Attributes:
        source: How the reply was produced:
            - ``"direct"`` — short/natural text, returned verbatim (with
              light markdown stripping).
            - ``"fallback"`` — structured content or oversized; stripped
              to first 2 sentences then capped.
            - ``"aux"`` — rewritten by the auxiliary spoken_summary model.
        text: The spoken reply text ready for TTS.
    """

    source: str  # "direct", "fallback", or "aux"
    text: str


# ── Structured-content detection ──────────────────────────────────────


_STRUCTURED_PATTERNS: Tuple[re.Pattern[str], ...] = (
    # Fenced code blocks (``` … ```) — structural
    re.compile(r"```", re.MULTILINE),
    # Markdown headers (## Title) — structural
    re.compile(r"^#{1,6}\s", re.MULTILINE),
    # Unordered list items (• or - or * at line start) — structural
    re.compile(r"^[\t ]*[-*•+]\s", re.MULTILINE),
    # Numbered list items (1. or 1) at line start) — structural
    re.compile(r"^[\t ]*\d+[.)]\s", re.MULTILINE),
    # Horizontal rules (---, ***, ___) — structural
    re.compile(r"^[\t ]*[-*_]{3,}\s*$", re.MULTILINE),
    # Blockquotes (> at line start) — structural
    re.compile(r"^>", re.MULTILINE),
    # Markdown tables (| --- |) — structural
    re.compile(r"\|[\s\-:]+\|"),
    # Admonition blocks (NOTE:, WARNING:, TIP:, etc.) — structural
    re.compile(r"^(?:NOTE|WARNING|TIP|INFO|IMPORTANT|CAUTION|DANGER):\s", re.MULTILINE),
    # Indented code blocks (Python/Ruby/etc. keywords at 2+ space indent)
    re.compile(r"^[\t ]{2,}(?:def |class |async |return |import |from |if |for |while "
               r"|try |with |print |raise |yield |pass |break |continue |elsif "
               r"|unless |rescue |ensure |begin |catch |finally |throw |switch "
               r"|case |default )", re.MULTILINE),
    # HTML/XML tags (<pre>, <code>, <script>, <div>, etc.)
    re.compile(r"</?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?>"),
    # JSON-like data: braces/brackets at line start (not inline)
    re.compile(r'^[\t ]*[\[{]', re.MULTILINE),
)

# NOTE: **bold**, *italic*, and `inline code` are intentionally NOT in
# _STRUCTURED_PATTERNS. They are common in conversational text and can be
# stripped by build_sanitized_direct() without triggering a full rewrite.


def needs_rewrite(text: str) -> bool:
    """Return True if the text contains structured content that wouldn't
    sound natural when read aloud verbatim.

    Structured content includes: code blocks, markdown headers, bullet/numbered
    lists, tables, horizontal rules, rich formatting markers, and admonition
    blocks (NOTE:, WARNING:, TIP:, etc.).

    Args:
        text: The final assistant response text.

    Returns:
        True if the text would benefit from spoken-summary rewriting.
    """
    if not text or not text.strip():
        return False
    return any(p.search(text) for p in _STRUCTURED_PATTERNS)


# ── Caps enforcement ──────────────────────────────────────────────────


def _ignore_word_cap(text: str) -> bool:
    """CJK / no-space scripts: secondary word cap does not apply (ADR-003)."""
    stripped = text.strip()
    if not stripped:
        return False
    # Long run without whitespace → char cap only
    if " " not in stripped and "\t" not in stripped and len(stripped) > 40:
        return True
    # Any whitespace-free segment longer than 40 code points
    for part in re.split(r"\s+", stripped):
        if len(part) > 40:
            return True
    return False


def enforce_spoken_caps(text: str, caps: SpokenReplyCaps) -> str:
    """Truncate to caps; total length including ellipsis never exceeds max_chars.

    Char cap is primary. Word cap is secondary and skipped for CJK/no-space runs.
    """
    text = text.strip()
    if not text:
        return text

    max_c = max(1, int(caps.max_chars))
    max_w = max(1, int(caps.max_words))
    truncated = False

    if len(text) > max_c:
        text = text[: max(0, max_c - 1)].rstrip()
        truncated = True

    if not _ignore_word_cap(text):
        words = text.split()
        if len(words) > max_w:
            text = " ".join(words[:max_w]).rstrip(",;:*")
            truncated = True

    if truncated and text:
        budget = max(0, max_c - 1)
        if len(text) > budget:
            text = text[:budget].rstrip()
        # single ellipsis, already inside budget
        if not text.endswith("…"):
            text = text + "…"
        elif len(text) > max_c:
            text = text[:budget].rstrip() + "…"

    return text

# ── Markdown stripping ─────────────────────────────────────────────────


_MARKDOWN_STRIP_PATTERNS: Tuple[Tuple[re.Pattern[str], str], ...] = (
    # Fenced code blocks — remove entirely
    (re.compile(r"```[\s\S]*?```"), " "),
    # [text](url) → text
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"), r"\1"),
    # Bare URLs
    (re.compile(r"https?://\S+"), ""),
    # **bold**
    (re.compile(r"\*\*(.+?)\*\*"), r"\1"),
    # *italic*
    (re.compile(r"\*(.+?)\*"), r"\1"),
    # `inline code`
    (re.compile(r"`(.+?)`"), r"\1"),
    # Headers: # Title → Title
    (re.compile(r"^#{1,6}\s*", re.MULTILINE), ""),
    # List items: - or * or • or +
    (re.compile(r"^[\t ]*[-*•+]\s+", re.MULTILINE), ""),
    # Horizontal rules
    (re.compile(r"^[\t ]*[-*_]{3,}\s*$", re.MULTILINE), ""),
    # Blockquotes: > text → text
    (re.compile(r"^>\s*", re.MULTILINE), ""),
    # Admonition prefixes
    (re.compile(r"^(?:NOTE|WARNING|TIP|INFO|IMPORTANT|CAUTION|DANGER):\s*",
               re.MULTILINE), ""),
    # Collapse excessive newlines
    (re.compile(r"\n{3,}"), "\n\n"),
)

# Fallback extracts the first N sentences before applying caps as a
# multi-sentence spoken take (not a full essay, not a one-liner).
_MAX_FALLBACK_SENTENCES = 20


def _strip_markdown(text: str) -> str:
    """Apply all markdown strip patterns and collapse whitespace for speech."""
    for pattern, replacement in _MARKDOWN_STRIP_PATTERNS:
        text = pattern.sub(replacement, text)
    # Drop markdown table rows / separator lines entirely (sound terrible aloud)
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("|") and stripped.endswith("|"):
            continue
        if re.fullmatch(r"\|?[\s\-:|]+\|?", stripped):
            continue
        # Drop leftover pipe-heavy pseudo-rows
        if stripped.count("|") >= 2:
            continue
        lines.append(stripped)
    text = " ".join(lines)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n+", " ", text)
    return text.strip()


def build_spoken_fallback(text: str, caps: SpokenReplyCaps) -> str:
    """Produce a spoken reply by stripping markdown, keeping the first
    few sentences as a rough summary, then capping.

    This is the fallback path used when the auxiliary spoken_summary model
    is not available or the caller hasn't wired it in yet.

    Args:
        text: The full assistant response.
        caps: Character and word limits.

    Returns:
        Cleaned, truncated text suitable for TTS.
    """
    text = _strip_markdown(text)
    if not text:
        return ""

    # Extract first N sentences as a rough spoken summary
    sentences = _split_sentences(text)
    if len(sentences) > _MAX_FALLBACK_SENTENCES:
        text = " ".join(sentences[: _MAX_FALLBACK_SENTENCES])

    return enforce_spoken_caps(text, caps)


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences on period/exclamation/question-mark
    followed by a space or end of string."""
    return re.split(r"(?<=[.!?])\s+", text)


# ── Main entry point ──────────────────────────────────────────────────


def build_sanitized_direct(text: str) -> str:
    """Lightly sanitize short natural text for direct spoken delivery.

    Strips bold markers, inline code, links, and leading/trailing whitespace
    but does NOT truncate or apply caps — used when the text is already
    within limits and has no structured content.
    """
    # Bold: **text** → text
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    # Inline code: `text` → text
    text = re.sub(r"`(.+?)`", r"\1", text)
    # Links: [text](url) → text
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return text.strip()


def buildSpokenReply(
    text: str, caps: Optional[SpokenReplyCaps] = None
) -> SpokenReply:
    """Produce a spoken reply from the assistant's final response.

    Decision tree:

    1. Empty text → ``SpokenReply(source="fallback", text="")``
    2. Short natural text (no structured content, within caps) → cleaned
       and returned as ``source="direct"``
    3. Text with structured content or exceeding caps → stripped to first
       ``_MAX_FALLBACK_SENTENCES`` sentences and capped, returned as
       ``source="fallback"``

    Callers that have access to the auxiliary spoken_summary model should
    additionally check ``needs_rewrite()`` and, if true, invoke the aux
    model and set ``source="aux"``.

    Args:
        text: The final assistant response.
        caps: Character and word limits (default: 600 words, 4000 chars).

    Returns:
        A ``SpokenReply`` with the spoken text and its provenance.
    """
    if caps is None:
        caps = SpokenReplyCaps()

    if not text or not text.strip():
        return SpokenReply(source="fallback", text="")

    text_len, word_count = _measure(text)

    # Case 1: Within caps + natural content → direct
    if text_len <= caps.max_chars and word_count <= caps.max_words:
        if not needs_rewrite(text):
            return SpokenReply(
                source="direct",
                text=build_sanitized_direct(text),
            )
        # Has structured content — fallback
        return SpokenReply(
            source="fallback",
            text=build_spoken_fallback(text, caps),
        )

    # Case 2: Exceeds caps — fallback (truncate + strip)
    return SpokenReply(
        source="fallback",
        text=build_spoken_fallback(text, caps),
    )


def _measure(text: str) -> Tuple[int, int]:
    """Return (char_count, word_count) for the given text."""
    stripped = text.strip()
    if not stripped:
        return 0, 0
    return len(stripped), len(stripped.split())
