"""Unit tests for the sync HTTP brain adapter (``brain_http.HttpBrainClient``).

These exercise the adapter against a LOCAL stub HTTP server (a real socket, real
``urllib`` round-trips — no mocks of the transport) so the contract under test is the
actual wire behaviour: payload shape, validate/clamp of recall items, the signed
``outcome`` reward channel, the 422 stale-observation path, and fail-open on timeout.

The live ``.31`` smoke test lives separately (``test_brain_http_live.py``) and is
skipped when the brain is unreachable; this file never touches the network beyond
localhost, so it is deterministic in CI.

Run: python -m pytest plugins/memory/composite/tests/test_brain_http.py -q
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import pytest

from plugins.memory.composite.brain_http import HttpBrainClient
from backends import BRAIN_OK, BRAIN_DEGRADED, BRAIN_FAIL


# --- stub brain server --------------------------------------------------------------

class _BrainState:
    """Mutable knobs the handler reads; tests flip these to drive behaviour."""

    def __init__(self):
        self.delay_s = 0.0            # server-side stall (timeout testing)
        self.recall_payload = {"results": []}
        self.observe_payload = {"id": 1, "observation_id": "obs-uuid-1"}
        self.feedback_payload = {"ok": True, "dW": 0.42}
        self.feedback_status = 200    # flip to 422 for the stale-id path
        # /api/brain/learning-delta: a diagnostic SNAPSHOT (no dW total in the live shape).
        self.learning_delta_payload = {"nnz_by_region": {"a->b": 3}, "step": 7}
        # /api/claude/summary: the AUTHORITATIVE brain-side dW total (the key the battery reads).
        self.summary_payload = {"last_reward_dW_total": 6.59}
        self.last_feedback_body = None
        self.last_observe_body = None
        self.last_recall_query = None


def _make_handler(state: _BrainState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):  # silence test noise
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            return json.loads(raw.decode("utf-8")) if raw else {}

        def do_GET(self):
            if state.delay_s:
                time.sleep(state.delay_s)
            parsed = urlparse(self.path)
            if parsed.path == "/api/claude/recall":
                state.last_recall_query = parse_qs(parsed.query)
                return self._send(200, state.recall_payload)
            if parsed.path == "/api/claude/status":
                return self._send(200, {"status": "ok"})
            if parsed.path == "/api/brain/learning-delta":
                return self._send(200, state.learning_delta_payload)
            if parsed.path == "/api/claude/summary":
                return self._send(200, state.summary_payload)
            return self._send(404, {"error": "not found"})

        def do_POST(self):
            if state.delay_s:
                time.sleep(state.delay_s)
            parsed = urlparse(self.path)
            if parsed.path == "/api/claude/observe":
                state.last_observe_body = self._read_json()
                return self._send(200, state.observe_payload)
            if parsed.path == "/api/claude/feedback":
                state.last_feedback_body = self._read_json()
                if state.feedback_status == 422:
                    return self._send(422, {"error": "unknown_observation"})
                return self._send(200, state.feedback_payload)
            return self._send(404, {"error": "not found"})

    return Handler


@pytest.fixture
def brain():
    state = _BrainState()
    server = HTTPServer(("127.0.0.1", 0), _make_handler(state))
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    host, port = server.server_address
    client = HttpBrainClient(f"http://{host}:{port}", timeout=1.0, source="test", recall_limit=3)
    try:
        yield client, state
    finally:
        server.shutdown()
        server.server_close()


# --- observe ------------------------------------------------------------------------

def test_observe_returns_observation_id_string(brain):
    client, state = brain
    obs_id = client.observe({"type": "context", "content": "hello"})
    assert obs_id == "obs-uuid-1"
    # payload must carry type/content/source (the deployed contract)
    assert state.last_observe_body == {"type": "context", "content": "hello", "source": "test"}


def test_observe_returns_uuid_string_never_the_int_rowid(brain):
    # The feedback endpoint 422s on an int id; the adapter must surface the UUID, not `id`.
    client, state = brain
    state.observe_payload = {"id": 999, "observation_id": "the-uuid"}
    assert client.observe({"type": "text", "content": "x"}) == "the-uuid"


def test_observe_offline_returns_none(brain):
    client, _ = brain
    client._base_url = "http://127.0.0.1:1"  # nothing listening -> transport error
    assert client.observe({"type": "text", "content": "x"}) is None


# --- prefetch / recall (validate + clamp, R5) ---------------------------------------

def test_prefetch_returns_scored_items_and_passes_query_params(brain):
    client, state = brain
    state.recall_payload = {"results": [{"content": "a", "score": 0.9}, {"content": "b", "score": 0.5}]}
    items = client.prefetch("how to X")
    assert [i["content"] for i in items] == ["a", "b"]
    assert all(isinstance(i["score"], float) for i in items)
    assert state.last_recall_query["q"] == ["how to X"]
    assert state.last_recall_query["limit"] == ["3"]  # recall_limit


def test_prefetch_drops_malformed_and_clamps_oversized(brain):
    client, state = brain
    big = "x" * 5000
    state.recall_payload = {"results": [
        {"content": "ok", "score": 0.8},
        {"no_content_key": 1},        # malformed -> dropped
        "not a dict",                  # malformed -> dropped
        {"content": big, "score": 0.3},
    ]}
    items = client.prefetch("q")
    assert len(items) == 2
    assert len(items[1]["content"]) <= client._max_item_chars  # clamped


def test_prefetch_caps_item_count_to_recall_limit(brain):
    client, state = brain
    state.recall_payload = {"results": [{"content": f"c{i}", "score": 0.1 * i} for i in range(10)]}
    assert len(client.prefetch("q")) <= 3  # recall_limit


def test_prefetch_offline_returns_empty_list(brain):
    client, _ = brain
    client._base_url = "http://127.0.0.1:1"
    assert client.prefetch("q") == []


def test_prefetch_uses_strength_as_relevance_proxy_when_no_score(brain):
    # Live recall items carry `strength` (a numeric activation) but no score/relevance.
    # The adapter must squash strength into a POSITIVE score so recall is rankable.
    client, state = brain
    state.recall_payload = {"results": [{"content": "a", "strength": 4.0}]}
    items = client.prefetch("q")
    assert len(items) == 1
    assert items[0]["score"] == pytest.approx(4.0 / (4.0 + 1.0))  # 0.8


def test_prefetch_strength_derived_score_is_always_below_one(brain):
    # A huge strength still squashes into [0,1) so a brain item never outranks the
    # store's authoritative 1.0 band.
    client, state = brain
    state.recall_payload = {"results": [{"content": "a", "strength": 1e9}]}
    items = client.prefetch("q")
    assert len(items) == 1
    assert items[0]["score"] < 1.0


def test_prefetch_explicit_score_takes_precedence_over_strength(brain):
    # When both are present, the explicit score wins (strength is only a fallback proxy).
    client, state = brain
    state.recall_payload = {"results": [{"content": "a", "score": 0.25, "strength": 4.0}]}
    items = client.prefetch("q")
    assert len(items) == 1
    assert items[0]["score"] == 0.25


def test_prefetch_no_score_no_relevance_no_strength_is_zero(brain):
    # Existing behavior preserved: an item with none of score/relevance/strength -> 0.0.
    client, state = brain
    state.recall_payload = {"results": [{"content": "a"}]}
    items = client.prefetch("q")
    assert len(items) == 1
    assert items[0]["score"] == 0.0


# --- reward (signed outcome, paired id, 422, fail-open) -----------------------------

def test_reward_paired_sends_signed_outcome_and_was_helpful(brain):
    client, state = brain
    status = client.reward("store-ref", valence=0.7, derivation="task succeeded",
                            observation_id="obs-uuid-1", session_id="S1")
    assert status == BRAIN_OK
    body = state.last_feedback_body
    assert body["observation_id"] == "obs-uuid-1"
    assert body["outcome"] == 0.7            # SIGNED float preserved (not collapsed to bool)
    assert body["was_helpful"] is True
    assert body["session_id"] == "S1"


def test_reward_negative_valence_punishes_with_signed_outcome(brain):
    client, state = brain
    status = client.reward("ref", valence=-0.8, derivation="regressed",
                           observation_id="obs-uuid-1")
    assert status == BRAIN_OK
    assert state.last_feedback_body["outcome"] == -0.8    # negative survives
    assert state.last_feedback_body["was_helpful"] is False


def test_reward_without_observation_id_is_degraded_not_paired(brain):
    # No id => the legacy freshness path => NOT the learning path => degraded, never ok.
    client, _ = brain
    assert client.reward("ref", valence=0.5, derivation="d") == BRAIN_DEGRADED


def test_reward_stale_id_422_is_degraded(brain):
    client, state = brain
    state.feedback_status = 422
    assert client.reward("ref", valence=0.5, derivation="d",
                         observation_id="aged-out") == BRAIN_DEGRADED


def test_reward_dw_zero_is_degraded(brain):
    client, state = brain
    state.feedback_payload = {"ok": True, "dW": 0.0}
    assert client.reward("ref", valence=0.5, derivation="d",
                         observation_id="obs-uuid-1") == BRAIN_DEGRADED


def test_reward_transport_failure_is_fail(brain):
    client, _ = brain
    client._base_url = "http://127.0.0.1:1"
    assert client.reward("ref", valence=0.5, derivation="d",
                        observation_id="obs-uuid-1") == BRAIN_FAIL


def test_reward_captures_last_reward_dw_from_response(brain):
    # The provider reads brain._last_reward_dW for its honest health surface; the adapter
    # must capture the dW carried in the feedback response (no second call).
    client, state = brain
    assert client._last_reward_dW is None                 # unset before any reward
    state.feedback_payload = {"ok": True, "dW": 0.42}
    client.reward("ref", valence=0.5, derivation="d", observation_id="obs-uuid-1")
    assert client._last_reward_dW == pytest.approx(0.42)


def test_reward_last_reward_dw_is_none_when_response_omits_dw(brain):
    client, state = brain
    state.feedback_payload = {"ok": True}                  # no dW key
    client.reward("ref", valence=0.5, derivation="d", observation_id="obs-uuid-1")
    assert client._last_reward_dW is None


# --- learning_delta SNAPSHOT (diagnostic only; carries NO dW total) -----------------

def test_learning_delta_returns_parsed_snapshot_payload(brain):
    # /api/brain/learning-delta is a diagnostic snapshot (nnz_by_region/step/...), NOT a
    # dW-total source. The method returns the parsed dict verbatim.
    client, state = brain
    state.learning_delta_payload = {"nnz_by_region": {"a->b": 3}, "step": 12}
    delta = client.learning_delta()
    assert delta == {"nnz_by_region": {"a->b": 3}, "step": 12}


def test_learning_delta_offline_returns_empty_dict(brain):
    client, _ = brain
    client._base_url = "http://127.0.0.1:1"
    assert client.learning_delta() == {}


# --- brain_dW_total (AUTHORITATIVE total off /api/claude/summary) -------------------

def test_brain_dW_total_reads_last_reward_dW_total_from_summary(brain):
    # The authoritative brain-side running total lives on /api/claude/summary under the
    # EXACT key the battery reads (last_reward_dW_total) -- NOT on learning-delta.
    client, state = brain
    state.summary_payload = {"last_reward_dW_total": 6.59}
    assert client.brain_dW_total() == pytest.approx(6.59)


def test_brain_dW_total_offline_returns_none(brain):
    client, _ = brain
    client._base_url = "http://127.0.0.1:1"  # nothing listening -> transport error
    assert client.brain_dW_total() is None


def test_brain_dW_total_absent_key_returns_none(brain):
    # A summary payload without last_reward_dW_total -> None, never a crash.
    client, state = brain
    state.summary_payload = {"uptime": 123, "step": 7}
    assert client.brain_dW_total() is None


def test_learning_delta_total_alias_delegates_to_brain_dW_total(brain):
    # The deprecated alias delegates to brain_dW_total (hits /api/claude/summary).
    client, state = brain
    state.summary_payload = {"last_reward_dW_total": 2.5}
    assert client.learning_delta_total() == pytest.approx(2.5)


# --- timeout fail-open (R4) ---------------------------------------------------------

def test_slow_brain_fails_open_within_bounded_time(brain):
    client, state = brain
    state.delay_s = 3.0          # >> client timeout (1.0s)
    t0 = time.monotonic()
    assert client.observe({"type": "text", "content": "x"}) is None
    assert client.prefetch("q") == []
    elapsed = time.monotonic() - t0
    assert elapsed < 6.0, f"adapter did not bound on timeout: {elapsed:.1f}s"


# --- liveness probe (R6) ------------------------------------------------------------

def test_ping_reports_reachable(brain):
    client, _ = brain
    res = client.ping()
    assert res["ok"] is True


def test_ping_unreachable_is_not_ok(brain):
    client, _ = brain
    client._base_url = "http://127.0.0.1:1"
    res = client.ping()
    assert res["ok"] is False


def test_close_is_noop(brain):
    client, _ = brain
    client.close()  # must not raise
