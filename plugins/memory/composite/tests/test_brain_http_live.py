"""LIVE smoke test for ``brain_http.HttpBrainClient`` against the deployed NeuroLinked
brain (default ``http://1.1.11.31:8000``). This is a "real data" contract test: it
validates the adapter's parsing against the ACTUAL deployed HTTP surface, not a stub.

CAUTION: ``.31`` is a LIVE production brain. This test is deliberately CONSERVATIVE.

  * It SKIPS cleanly (never fails CI) when the brain is unreachable — reachability is
    probed once via ``ping()`` in a module-scoped fixture; an un-ok ping skips all tests.
  * The SAFE tests only ``ping``/``observe``/``prefetch`` (reads + one clearly-tagged
    observation). They apply NO learning signal.
  * The REWARD test applies REAL ``dW`` to the live brain and is therefore OPT-IN: it is
    skipped unless ``HERMES_BRAIN_LIVE_REWARD=1`` is set in the environment.

Host override: ``HERMES_BRAIN_URL`` (default ``http://1.1.11.31:8000``).

Run:  python -m pytest plugins/memory/composite/tests/test_brain_http_live.py -v -rs
"""

from __future__ import annotations

import os
import uuid

import pytest

from plugins.memory.composite.brain_http import HttpBrainClient
from plugins.memory.composite.core import BRAIN_OK, BRAIN_DEGRADED, BRAIN_FAIL

_BRAIN_URL = os.environ.get("HERMES_BRAIN_URL", "http://1.1.11.31:8000")
_REWARD_OPT_IN = os.environ.get("HERMES_BRAIN_LIVE_REWARD") == "1"

# Unique, clearly-marked tag so the observation this test creates is identifiable on the
# live brain (and could be tombstoned later by an operator if desired).
_RUN_TAG = uuid.uuid4().hex[:12]
_OBS_CONTENT = f"[m1-smoke] adapter contract test {_RUN_TAG}"


@pytest.fixture(scope="module")
def live_client() -> HttpBrainClient:
    """Build a client and probe reachability ONCE. Skip the whole module if the brain
    is not ok — keeps CI green when ``.31`` is offline/unroutable."""
    client = HttpBrainClient(_BRAIN_URL, timeout=2.5, source="hermes-agent-m1-smoke")
    health = client.ping()
    if not health.get("ok"):
        pytest.skip(
            f"brain unreachable at {_BRAIN_URL}: {health.get('detail')!r} "
            "(set HERMES_BRAIN_URL to override)"
        )
    yield client
    client.close()


# --- SAFE tests (run whenever the brain is reachable) -------------------------------


def test_ping_ok(live_client: HttpBrainClient) -> None:
    """Liveness probe returns ok with a detail payload."""
    health = live_client.ping()
    assert health["ok"] is True, health
    # status payload is whatever the brain returns; just assert it's present.
    assert health.get("detail") is not None


def test_observe_returns_uuid_string(live_client: HttpBrainClient) -> None:
    """``observe`` returns a NON-EMPTY string observation_id (a UUID-looking string), NOT
    an int rowid. The paired-reward path is keyed on this UUID, so the type matters."""
    obs_id = live_client.observe({"type": "context", "content": _OBS_CONTENT})
    assert isinstance(obs_id, str), f"expected str observation_id, got {type(obs_id)!r}"
    assert obs_id, "observation_id must be non-empty"
    # A UUID-looking handle: not a bare integer rowid (the int id 422s on feedback).
    assert not obs_id.isdigit(), f"observation_id looks like an int rowid: {obs_id!r}"
    # Heuristic UUID shape check (the deployed contract returns a UUID string).
    assert "-" in obs_id and len(obs_id) >= 32, f"unexpected observation_id shape: {obs_id!r}"


def test_prefetch_returns_well_shaped_items(live_client: HttpBrainClient) -> None:
    """``prefetch`` returns a list (possibly empty) of ``{content:str, score:float}`` dicts.
    Assert the SHAPE the adapter guarantees, not specific recalled contents.

    NOTE on the deployed contract (probed live 2026-06-13): the recall envelope is
    ``{"query","results","count","domain_filter"}`` and each ``results`` item carries
    ``text`` (which the adapter reads) but NO ``score``/``relevance`` field. The adapter's
    score fallback therefore yields ``0.0`` for every live item. That keeps the SHAPE
    contract intact (score is a float), so this test asserts the float type only — it does
    NOT require a non-zero score, which would fail against the real brain."""
    items = live_client.prefetch("experience store")
    assert isinstance(items, list), f"prefetch must return a list, got {type(items)!r}"
    for item in items:
        assert isinstance(item, dict), f"each item must be a dict, got {type(item)!r}"
        assert set(item.keys()) == {"content", "score"}, f"unexpected item keys: {item.keys()}"
        assert isinstance(item["content"], str), f"content must be str, got {type(item['content'])!r}"
        assert item["content"], "content must be non-empty (adapter drops textless items)"
        assert isinstance(item["score"], float), f"score must be float, got {type(item['score'])!r}"


# --- REWARD test (OPT-IN: applies real dW to the live brain) ------------------------


@pytest.mark.skipif(
    not _REWARD_OPT_IN,
    reason="opt-in: applies real dW to live brain (set HERMES_BRAIN_LIVE_REWARD=1)",
)
def test_reward_paired_and_stale_paths(live_client: HttpBrainClient) -> None:
    """Validate the two reward outcomes against the live brain:

      * PAIRED (fresh observation_id): a learning reward must NOT be ``fail`` — it is
        ``ok`` (paired + non-zero dW) or ``degraded`` (HTTP-200 but dW==0 no-op).
      * STALE (unknown all-zero UUID): the brain 422s -> adapter reports ``degraded``.
    """
    # Paired path: observe -> reward on that fresh UUID.
    obs_id = live_client.observe(
        {"type": "context", "content": f"[m1-smoke] reward probe {_RUN_TAG}"}
    )
    assert isinstance(obs_id, str) and obs_id, "need a UUID handle to test the paired path"

    paired_status = live_client.reward(
        valence=0.5,
        derivation="task_completed",
        observation_id=obs_id,
        session_id="m1-smoke",
    )
    assert paired_status in (BRAIN_OK, BRAIN_DEGRADED), (
        f"paired reward must not fail; got {paired_status!r}"
    )

    # Stale path: an unknown all-zero UUID -> brain 422 unknown_observation -> degraded.
    stale_status = live_client.reward(
        valence=0.5,
        derivation="task_completed",
        observation_id="00000000-0000-0000-0000-000000000000",
        session_id="m1-smoke",
    )
    assert stale_status == BRAIN_DEGRADED, (
        f"stale/unknown observation_id should be degraded (422), got {stale_status!r}"
    )
