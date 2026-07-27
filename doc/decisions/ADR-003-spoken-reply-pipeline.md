# ADR-003: Spoken Reply Pipeline for Voice Conversational Mode

- **Status**: accepted
- **Date**: 2026-07-16
- **Deciders**: desktop-backend-expert
- **Replaces**: —
- **Supersedes**: —

## Context

When `voice.speak_mode` is `"full"` (the default), the entire assistant response
is fed to TTS after basic markdown stripping. This works for short replies but
becomes unusable when the response contains code blocks, structured data, or
long-form text — common outputs for a coding agent.

We need a *conversational* mode (`voice.speak_mode = "conversational"`) that
produces a short, spoken reply suitable for voice output, distinct from the
full assistant answer shown on-screen.

## Decision

### Spoken reply module (`agent/spoken_reply.py`)

A standalone pipeline module with these functions:

| Function | Role |
|---|---|
| `needs_rewrite(text)` | Detects structured content (code fences, headers, lists, tables, HTML, JSON) or text exceeding spoken caps |
| `buildSpokenReply(text, caps)` | Main entry point: routes to `direct`, `fallback`, or (future) `aux` path |
| `build_spoken_fallback(text, caps)` | Produces a short spoken version by extracting first N sentences and enforcing caps |
| `enforce_spoken_caps(text, caps)` | Truncates text to character cap (CJK-aware — skips word cap for ideographic runs) |
| `build_sanitized_direct(text)` | Light in-line formatting strip for short natural text (`**bold**`, `` `code` ``) |

### Data model

```python
@dataclass
class SpokenReplyCaps:
    max_words: int = 600
    max_chars: int = 4000

@dataclass
class SpokenReply:
    text: str
    source: str  # "direct" | "fallback" | "aux"
```

### Decision tree

1. Empty text → `SpokenReply(source="fallback", text="")`
2. Short natural text (no structured content, within caps) → cleaned + sanitized, `source="direct"`
3. Structured content or exceeds caps → first N sentences truncated + capped, `source="fallback"`
4. (Future) Auxiliary model rewrite → `source="aux"`

### Schema: `messages.spoken_reply`

A nullable `TEXT` column on the `messages` table, auto-added by
`_reconcile_columns` on next startup. Set by the TTS path on the last
assistant message dict so it survives to the session DB flush.

### Integration points

- **`cli.py:_voice_speak_response`**: When `speak_mode == "conversational"`,
  calls `buildSpokenReply()` to produce TTS text. Persists `spoken_reply` on
  the last assistant message in `conversation_history`.
- **`hermes_cli/voice.py:speak_text`**: Same conversational check for the
  TUI gateway path (persistence handled by `run_agent.py:_flush_messages`).
- **`run_agent.py:_flush_messages_to_session_db`**: Passes
  `msg.get("spoken_reply")` to `append_message()`.
- **`hermes_state.py:append_message`**: Accepts optional `spoken_reply`
  parameter, inserts into `messages` table.

### Design choices

**Why not do the spoken reply generation in `conversation_loop.py`?**
The conversation loop is provider-agnostic and shouldn't know about TTS or
voice mode. The TTS pipeline is the natural place to decide *how* to speak.

**Why a fallback path instead of requiring an auxiliary model?**
The auxiliary `spoken_summary` model adds a network round-trip per response.
The fallback path (extract first N sentences + cap) is immediate, deterministic,
and sufficient for the MVP. The `source="aux"` path is designed for future
use when fast auxiliary models are reliably available.

**Why not strip bold/inline code in `needs_rewrite` and use direct path?**
The `needs_rewrite` check is specifically for *structural* content (code blocks,
headers, tables). Inline formatting like `**bold**` and `` `code` `` is common
in conversational text and handled by `build_sanitized_direct` without flagging
the text for rewrite.

## Consequences

- **Positive**: `voice.speak_mode = "conversational"` produces natural spoken
  output even when the full assistant response contains code, markdown, or
  structured content.
- **Positive**: Schema addition is declarative — no manual migration needed.
- **Negative**: The `build_spoken_fallback` path (sentence extraction) is a
  heuristic and may occasionally produce awkward output for edge cases.
- **Future work**: Integrate the `auxiliary.spoken_summary` model for
  genuinely rewritten spoken replies where the fallback is insufficient.

## Tests

- `tests/agent/test_spoken_reply.py` — 6 tests covering all decision tree paths
  (EVAL-VDP-001 through EVAL-VDP-008)
- `tests/hermes_cli/test_config.py` — 8 tests covering `speak_mode` config
  validation and persistence
