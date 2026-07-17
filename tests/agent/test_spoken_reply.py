"""Unit tests for pure spoken-reply helpers (EVAL-VDP-001, EVAL-VDP-008)."""

from agent.spoken_reply import (
    SpokenReplyCaps,
    buildSpokenReply,
    build_spoken_fallback,
    enforce_spoken_caps,
    needs_rewrite,
)


def test_long_reply_with_code_fence_falls_back_under_char_cap_eval_vdp_001():
    text = (
        "Here is the implementation you asked for. It creates the helper and tests it. "
        "```python\n"
        "def example():\n"
        "    return {'secret': 'not a spoken sentence', 'items': [1, 2, 3]}\n"
        "```\n"
        "The full code remains visible in the transcript for review and copy paste. "
        "Run the focused unit tests after applying it."
    )
    caps = SpokenReplyCaps(max_chars=120, max_words=40)

    reply = buildSpokenReply(text, caps=caps)

    assert reply is not None
    assert reply.source == "fallback"
    assert len(reply.text) <= caps.max_chars
    assert "```" not in reply.text
    assert "def example" not in reply.text


def test_needs_rewrite_detects_structured_content_even_when_short():
    assert needs_rewrite("| Name | Value |\n| --- | --- |\n| mode | conversational |")
    assert needs_rewrite("Result:\n    def example():\n        return True")
    assert needs_rewrite('<pre>{"raw": true}</pre>')
    assert needs_rewrite('Result:\n{\n  "ok": true\n}')


def test_direct_short_plain_reply_preserves_sanitized_text():
    reply = buildSpokenReply("**Done.** I added `voice.speak_mode` and ran the tests.")

    assert reply is not None
    assert reply.source == "direct"
    assert reply.text == "Done. I added voice.speak_mode and ran the tests."


def test_word_cap_applies_to_whitespace_delimited_text():
    text = "one two three four five six seven"

    truncated = enforce_spoken_caps(text, SpokenReplyCaps(max_chars=80, max_words=4))

    assert truncated == "one two three four…"


def test_cjk_only_text_uses_char_cap_not_bogus_word_count_eval_vdp_008():
    text = "这是一个用于语音回复的中文句子" * 8
    caps = SpokenReplyCaps(max_chars=31, max_words=3)

    truncated = enforce_spoken_caps(text, caps)
    reply = buildSpokenReply(text, caps=caps)

    assert len(truncated) == caps.max_chars
    assert truncated.endswith("…")
    assert " " not in truncated
    assert reply is not None
    assert reply.source == "fallback"
    assert len(reply.text) <= caps.max_chars
    assert reply.text.endswith("…")


def test_fallback_prefers_first_sentences_then_enforces_caps():
    parts = [f"Sentence {i} is here." for i in range(1, 25)]
    text = " ".join(parts)

    fallback = build_spoken_fallback(text, SpokenReplyCaps(max_chars=5000, max_words=900))

    assert "Sentence 1 is here." in fallback
    assert "Sentence 20 is here." in fallback
    assert "Sentence 21 is here." not in fallback
