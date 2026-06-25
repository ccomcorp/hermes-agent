"""Tool-rejection -> skill-review trigger (learnable-error capture).

A tool that returns an OPERATOR-MISUSE rejection ({"error":"UnknownRef"}, invalid arg, schema
violation) is wired into the background skill-review trigger so a misused tool becomes a learning
signal instead of evaporating. ENVIRONMENTAL/transient errors (404, file-not-found, timeout,
rate-limit) are deliberately NOT triggers — they are is_error=True but not misuse lessons.

Tests cover: the trigger DECISION rule (isolated), the NARROW rejection classifier
(tool_result_is_rejection), and the underlying is_error detection it builds on.

Run: python -m pytest tests/agent/test_tool_rejection_skill_review_trigger.py -q
"""

from __future__ import annotations

import json

from agent.tool_result_classification import tool_result_is_rejection


class _StubAgent:
    def __init__(self, *, iters_since_skill=0, skill_nudge_interval=10,
                 has_skill_manage=True, tool_rejection=False):
        self._iters_since_skill = iters_since_skill
        self._skill_nudge_interval = skill_nudge_interval
        self.valid_tool_names = {"skill_manage"} if has_skill_manage else set()
        self._tool_rejection_this_turn = tool_rejection


def _compute_should_review_skills(agent):
    """Mirror of the trigger rule in turn_finalizer.finalize_turn / codex_runtime (the
    production code is the source of behavior; this reproduces it for an isolated unit test)."""
    should = False
    if (agent._skill_nudge_interval > 0
            and agent._iters_since_skill >= agent._skill_nudge_interval
            and "skill_manage" in agent.valid_tool_names):
        should = True
        agent._iters_since_skill = 0
    if getattr(agent, "_tool_rejection_this_turn", False):
        if "skill_manage" in agent.valid_tool_names:
            should = True
        agent._tool_rejection_this_turn = False
    return should


# --- trigger decision rule ----------------------------------------------------------

def test_rejection_triggers_skill_review_below_iteration_threshold():
    agent = _StubAgent(iters_since_skill=0, tool_rejection=True)
    assert _compute_should_review_skills(agent) is True
    assert agent._tool_rejection_this_turn is False  # consumed/reset


def test_no_rejection_no_review_below_threshold():
    agent = _StubAgent(iters_since_skill=0, tool_rejection=False)
    assert _compute_should_review_skills(agent) is False


def test_rejection_flag_reset_even_when_iterations_already_triggered():
    agent = _StubAgent(iters_since_skill=10, tool_rejection=True)
    assert _compute_should_review_skills(agent) is True
    assert agent._tool_rejection_this_turn is False
    assert agent._iters_since_skill == 0


def test_rejection_without_skill_manage_does_not_review_but_still_resets():
    agent = _StubAgent(iters_since_skill=0, has_skill_manage=False, tool_rejection=True)
    assert _compute_should_review_skills(agent) is False
    assert agent._tool_rejection_this_turn is False


# --- NARROW rejection classifier (Defect-3 fix): misuse triggers, environmental does not -----

def test_classifier_flags_unknownref_as_rejection():
    payload = json.dumps({"error": "UnknownRef", "ref": "some-skill-name",
                          "ack": {"store": "rejected", "brain": "skipped"}})
    assert tool_result_is_rejection("experience_signal", payload) is True


def test_classifier_flags_invalid_argument_as_rejection():
    # specific, unambiguous misuse markers (bare "validation error"/"schema" were intentionally
    # dropped — they collide with downstream service errors; see Bug-3 regression test below)
    for msg in ("invalid argument 'foo'", "unexpected keyword argument 'task_id'",
                "missing required parameter: ref", "must be one of: a, b, c",
                "invalid type for 'x': expected one of int, str"):
        payload = json.dumps({"error": msg})
        assert tool_result_is_rejection("some_tool", payload) is True, msg


def test_classifier_does_not_flag_environmental_errors():
    # these are is_error=True but NOT learnable misuse — must NOT trigger a review
    for msg in ("File not found: foo.py", "HTTP 404 Not Found", "request timed out",
                "rate limit exceeded (429)", "connection refused (ECONNREFUSED)",
                "network unreachable", "permission denied", "503 service unavailable, try again later"):
        payload = json.dumps({"error": msg})
        assert tool_result_is_rejection("read_file", payload) is False, msg


def test_classifier_environmental_marker_vetoes_even_with_generic_word():
    # "invalid value" co-occurring with an environmental phrase -> environmental wins
    payload = json.dumps({"error": "invalid value: URL not found (404)"})
    assert tool_result_is_rejection("web_fetch", payload) is False


# --- adversarial-review regression cases (hardened classifier) ----------------------

def test_classifier_bug1_environmental_word_in_arg_description_is_still_a_rejection():
    # REGRESSION (review Bug 1): a misuse rejection whose ARGUMENT happens to be named/described
    # with an environmental word ('timeout','connection','network') must NOT be vetoed — the
    # word appears inside a parameter description, not as an environmental failure.
    for msg in ("invalid argument: timeout must be an integer, got string",
                "invalid argument: max_connections must be a positive int",
                "missing required parameter: network_name",
                "unknown parameter: connection_pool_size"):
        payload = json.dumps({"error": msg})
        assert tool_result_is_rejection("some_tool", payload) is True, msg


def test_classifier_bug2_expected_status_code_is_not_a_rejection():
    # REGRESSION (review Bug 2): 'expected 200, got 503' is a downstream HTTP-status error,
    # not a tool-argument rejection.
    payload = json.dumps({"error": "API returned unexpected status: expected 200, got 503"})
    assert tool_result_is_rejection("web_fetch", payload) is False


def test_classifier_bug3_service_schema_errors_are_not_rejections():
    # REGRESSION (review Bug 3): GraphQL/Avro/JSON service-side schema validation errors are
    # not tool misuse — the ambiguous bare 'validation error'/'schema' markers were removed.
    for msg in ("GraphQL schema validation error: type Query undefined",
                "Avro schema evolution error: field removed",
                "JSON schema mismatch: response body failed validation"):
        payload = json.dumps({"error": msg})
        assert tool_result_is_rejection("graphql_query", payload) is False, msg


def test_classifier_real_misuse_validation_still_caught_via_specific_markers():
    # dropping bare 'validation error' must NOT lose real misuse — specific markers still catch it
    for msg in ("invalid value for derivation",
                "derivation must be one of: task_completed, test_result",
                "invalid type for 'valence': expected number",
                "missing required parameter: ref"):
        payload = json.dumps({"error": msg})
        assert tool_result_is_rejection("experience_signal", payload) is True, msg


def test_classifier_bug_env_word_in_param_name_is_still_a_rejection():
    # REGRESSION (round-3): a single-word/numeric ENV marker inside a parameter name
    # ('offline_threshold', 'retry_on_503', 'max_429_retries') must NOT veto a real misuse
    # rejection — the env side is now boundary-anchored like the misuse side.
    for msg in ("invalid parameter: offline_threshold must be a positive integer",
                "invalid argument: retry_on_503 must be boolean",
                "unknown parameter: max_429_retries"):
        payload = json.dumps({"error": msg})
        assert tool_result_is_rejection("some_tool", payload) is True, msg


def test_classifier_genuine_env_words_still_veto():
    # the boundary fix must not lose real environmental vetoes
    for msg in ("upstream went offline, try again later", "503 service unavailable",
                "HTTP 429 rate limit", "connection refused"):
        payload = json.dumps({"error": msg})
        assert tool_result_is_rejection("web_fetch", payload) is False, msg


def test_classifier_ignores_non_dict_and_success_payloads():
    assert tool_result_is_rejection("t", "plain string") is False
    assert tool_result_is_rejection("t", json.dumps({"ok": True})) is False
    assert tool_result_is_rejection("t", json.dumps(["a", "b"])) is False


def test_detect_tool_failure_still_flags_unknownref_as_is_error():
    # the broad is_error detection (for logging/UX) still fires; only the LEARNING gate narrowed
    from agent.display import _detect_tool_failure
    payload = json.dumps({"error": "UnknownRef", "ref": "x"})
    is_error, suffix = _detect_tool_failure("experience_signal", payload)
    assert is_error is True
    assert "UnknownRef" in suffix
