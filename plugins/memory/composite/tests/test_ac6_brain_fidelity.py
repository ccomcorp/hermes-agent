"""AC6 — brain-recall fidelity through the composite (re-activated assertion).

ORIGINAL AC6 (SPEC v1): "the existing NeuroLinked recall returns byte-identical
results with the composite in front." That wording assumed the composite REUSED a
NeuroLinked ``MemoryProvider`` as a pass-through. The architecture changed: there is
no such provider to reuse — the brain is fronted by a thin ``HttpBrainClient`` adapter
that DELIBERATELY normalizes/clamps/caps and score-squashes recall items (the R5 safety
design). So a literal byte-for-byte equality of the raw HTTP payload would contradict the
intended design and can never hold.

AC6's real INTENT is FIDELITY, not raw byte-identity: when the composite fronts the brain,
the brain's recalled items must reach the model context **faithfully** — same items, same
order, content verbatim — with NOTHING dropped, reordered, or corrupted beyond the
documented normalization. This file re-activates AC6 as that real assertion (it was
"vacuous" while brain=None; the brain leg is now wired).

The unit-level fidelity of the adapter itself (validate/clamp/score precedence) is covered
by ``test_brain_http.py``. Here the subject is the FULL provider: brain items warmed by
``queue_prefetch`` must survive ``_merge_dedup`` → ``_format_context`` into ``prefetch()``
output identical to a direct ``HttpBrainClient.prefetch(query)`` call, with an empty store
so the brain is the sole contributor.

Run: python -m pytest plugins/memory/composite/tests/test_ac6_brain_fidelity.py -q
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import pytest

from plugins.memory.composite.brain_http import HttpBrainClient
from plugins.memory.composite.provider import HermesCompositeProvider
from plugins.memory.composite.experience_store import ExperienceStore


# --- minimal stub brain (real socket, real urllib round-trip) -----------------------

class _State:
    def __init__(self):
        self.recall_payload = {"results": []}
        self.last_recall_query = None


def _make_handler(state: _State):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_a):  # silence
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/api/claude/recall":
                state.last_recall_query = parse_qs(parsed.query)
                return self._send(200, state.recall_payload)
            if parsed.path == "/api/claude/status":
                return self._send(200, {"status": "ok"})
            return self._send(404, {"error": "not found"})

    return Handler


@pytest.fixture
def brain_server():
    state = _State()
    server = HTTPServer(("127.0.0.1", 0), _make_handler(state))
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    host, port = server.server_address
    url = f"http://{host}:{port}"
    try:
        yield url, state
    finally:
        server.shutdown()
        server.server_close()


def _empty_store(tmp_path) -> ExperienceStore:
    """A real, freshly-initialized (empty) store so the brain is the sole recall source."""
    return ExperienceStore(str(tmp_path / "ac6_experience.db"))


def _brain_lines(formatted: str) -> list[str]:
    """The brain-tagged content lines from a _format_context() block, verbatim, in order."""
    return [ln[len("  (B) "):] for ln in formatted.splitlines() if ln.startswith("  (B) ")]


# --- AC6 ----------------------------------------------------------------------------

def test_ac6_brain_recall_survives_composite_verbatim_and_in_order(brain_server, tmp_path):
    """AC6: composite-fronted brain recall == direct brain recall (faithful pass-through)."""
    url, state = brain_server
    # Strictly descending scores → the brain's ranked order is unambiguous, so a faithful
    # composite must reproduce exactly this content order (no reorder).
    state.recall_payload = {"results": [
        {"content": "alpha lesson about retries", "score": 0.91},
        {"content": "beta lesson about timeouts", "score": 0.74},
        {"content": "gamma lesson about caching", "score": 0.55},
    ]}

    brain = HttpBrainClient(url, timeout=1.0, source="test", recall_limit=5)
    # The baseline: what NeuroLinked recall returns directly (the adapter's own output).
    direct = brain.prefetch("how to handle retries")
    direct_contents = [i["content"] for i in direct]
    assert direct_contents == [
        "alpha lesson about retries",
        "beta lesson about timeouts",
        "gamma lesson about caching",
    ]

    prov = HermesCompositeProvider(store=_empty_store(tmp_path), brain=brain, recall_limit=5)
    prov.queue_prefetch("how to handle retries")   # warms the brain cache (off hot path)
    out = prov.prefetch("how to handle retries", session_id="ac6")

    # FIDELITY: every brain item appears verbatim, tagged (B), in the same ranked order,
    # and the composite-fronted set is IDENTICAL to the direct brain recall — nothing
    # dropped, reordered, or corrupted (the store is empty, so brain is the sole source).
    assert _brain_lines(out) == direct_contents


def test_ac6_composite_does_not_fabricate_when_brain_empty(brain_server, tmp_path):
    """Negative control: brain returns nothing → the composite injects no brain items."""
    url, state = brain_server
    state.recall_payload = {"results": []}
    brain = HttpBrainClient(url, timeout=1.0, source="test", recall_limit=5)

    prov = HermesCompositeProvider(store=_empty_store(tmp_path), brain=brain, recall_limit=5)
    prov.queue_prefetch("nothing matches this")
    out = prov.prefetch("nothing matches this", session_id="ac6")

    assert _brain_lines(out) == []           # no fabricated brain content
    assert out == ""                          # empty store + empty brain → empty recall


def test_ac6_brain_offline_degrades_to_empty_never_crashes(brain_server, tmp_path):
    """A faithful front must also fail-open: an offline brain yields no items, no raise."""
    url, _ = brain_server
    brain = HttpBrainClient(url, timeout=1.0, source="test", recall_limit=5)
    brain._base_url = "http://127.0.0.1:1"    # nothing listening → transport error

    prov = HermesCompositeProvider(store=_empty_store(tmp_path), brain=brain, recall_limit=5)
    prov.queue_prefetch("q")                  # best-effort warm; must not raise
    out = prov.prefetch("q", session_id="ac6")
    assert _brain_lines(out) == []
