"""V1 — vault recall leg wired into the composite (the third recall backend).

Subject: ``HermesCompositeProvider`` (which inherits the base ``CompositeMemoryProvider``
prefetch / queue_prefetch / _merge_dedup) with a vault leg present, against a REAL (tmp)
``ExperienceStore`` and a FAKE in-process ``VaultCache``. No live QMD — the vault is mocked.

Verifies the V1 acceptance criteria:
  * 3-source merge (store + brain + vault) returns deduped, score-ordered, capped results.
  * a vault-ONLY hit appears in recall.
  * vault recall is warmed by ``queue_prefetch`` — ZERO inline vault calls in ``prefetch``.
  * an offline/empty vault degrades cleanly (fail-open, never raises).
And the QMD adapter's own contract (``vault_qmd.QmdVaultCache``): fail-open on a broken
subprocess, and JSON normalization into ``[{content, score}]`` with the store-band score squash.
"""

from __future__ import annotations

from typing import Any, List

import pytest

from plugins.memory.composite.provider import HermesCompositeProvider
from plugins.memory.composite.vault_qmd import QmdVaultCache
from store import ExperienceStore


# ----- fakes -------------------------------------------------------------------------


class FakeVault:
    """In-process ``VaultCache``. Counts recall() calls so we can prove prefetch does NO
    inline vault call (warm-only contract)."""

    def __init__(self, items: List[dict] | None = None):
        self._items = items or []
        self.recall_calls = 0

    def recall(self, query: str) -> List[dict[str, Any]]:
        self.recall_calls += 1
        return list(self._items)


class FakeBrain:
    """Minimal ``BrainClient`` whose prefetch returns canned scored items."""

    def __init__(self, items: List[dict] | None = None):
        self._items = items or []
        self.prefetch_calls = 0

    def prefetch(self, query: str) -> List[dict[str, Any]]:
        self.prefetch_calls += 1
        return list(self._items)

    def observe(self, record):  # pragma: no cover - unused here
        return None


# ----- fixtures ----------------------------------------------------------------------


def _provider(tmp_path, *, vault=None, brain=None) -> HermesCompositeProvider:
    store = ExperienceStore(str(tmp_path / "vault_experience.db"))
    return HermesCompositeProvider(store=store, vault=vault, brain=brain, recall_limit=5)


def _seed_store_lesson(prov: HermesCompositeProvider, text: str) -> str:
    return prov.record_fork_lesson(text, provenance="test:vault_leg", task_type="workflow")


# ----- 3-source merge ----------------------------------------------------------------


def test_three_source_merge_deduped_score_ordered_capped(tmp_path):
    """Store + brain + vault all contribute; merged output is deduped by normalized text,
    ordered by score (store authoritative band first), and capped at recall_limit."""
    vault = FakeVault(
        items=[
            {"content": "vault high relevance lesson", "score": 0.9},
            {"content": "vault low relevance lesson", "score": 0.1},
            {"content": "shared duplicate lesson", "score": 0.5},  # dup of store below
        ]
    )
    brain = FakeBrain(items=[{"content": "brain recalled lesson", "score": 0.8}])
    prov = _provider(tmp_path, vault=vault, brain=brain)
    _seed_store_lesson(prov, "store authoritative lesson about deployment")
    _seed_store_lesson(prov, "shared duplicate lesson")  # same text as a vault item

    # Warm the cache (queue_prefetch) so brain+vault items are available to prefetch.
    prov.queue_prefetch("lesson", session_id="s1")
    block = prov.prefetch("lesson", session_id="s1")

    assert block, "expected a non-empty recalled context block"
    # All three provenance markers present (S/V/B) — the merge spans all three backends.
    assert "(S)" in block and "(V)" in block and "(B)" in block
    # Dedup: the shared text appears exactly once across store+vault.
    assert block.count("shared duplicate lesson") == 1
    # Cap: never more than recall_limit recalled lines (excludes the 2 fence lines).
    body_lines = [ln for ln in block.splitlines() if ln.strip().startswith("(")]
    assert len(body_lines) <= 5

    # --- Score ORDERING: store band (authoritative, score 1.0) outranks the squashed
    # vault BM25 band (<1.0) and the brain band (0.8). The first store marker must precede
    # the first vault marker, and the first vault marker must precede the brain marker —
    # so the merged block is genuinely score-ordered, not merely "all three present".
    assert block.index("(S)") < block.index("(V)") < block.index("(B)"), (
        "expected store(S) before vault(V) before brain(B) by score band:\n" + block
    )
    # The authoritative store hit (score 1.0) is the very first recalled body line.
    assert body_lines[0].lstrip().startswith("(S)"), (
        "expected the authoritative store hit first; got: " + body_lines[0]
    )

    # --- Dedup SOURCE-WINNER: "shared duplicate lesson" is seeded into BOTH the store
    # (score 1.0, src_rank 0) and the vault (score 0.5, src_rank 1). The store wins the
    # tie via src_rank, so the single surviving line carries the STORE marker (S), NOT
    # the vault marker (V). Find the one body line for that text and assert its source.
    dup_lines = [ln for ln in body_lines if "shared duplicate lesson" in ln]
    assert len(dup_lines) == 1, f"shared dup should survive once, got {dup_lines}"
    assert dup_lines[0].lstrip().startswith("(S)"), (
        "store must win the dedup tie (src_rank) — expected (S), got: " + dup_lines[0]
    )


def test_vault_only_hit_appears_in_recall(tmp_path):
    """A hit that exists ONLY in the vault (no store/brain match) still reaches recall."""
    vault = FakeVault(items=[{"content": "vault exclusive knowledge nugget", "score": 0.7}])
    prov = _provider(tmp_path, vault=vault, brain=None)
    # No store lessons seeded, no brain — vault is the sole source of content.
    prov.queue_prefetch("nugget", session_id="s2")
    block = prov.prefetch("nugget", session_id="s2")

    assert "vault exclusive knowledge nugget" in block
    assert "(V)" in block


# ----- warm-only contract (no inline vault on the hot path) --------------------------


def test_prefetch_does_no_inline_vault_call(tmp_path):
    """``prefetch`` (hot path) must NOT call vault.recall — that work is warmed by
    ``queue_prefetch`` (background mem-sync worker). Zero inline vault calls in prefetch."""
    vault = FakeVault(items=[{"content": "warm vault item", "score": 0.6}])
    prov = _provider(tmp_path, vault=vault)
    _seed_store_lesson(prov, "a store lesson so prefetch returns content")

    # prefetch BEFORE any warm: vault must not be touched on the hot path.
    prov.prefetch("lesson", session_id="s3")
    assert vault.recall_calls == 0, "prefetch must not call vault.recall inline"

    # The warm pass is the ONLY place vault.recall fires.
    prov.queue_prefetch("lesson", session_id="s3")
    assert vault.recall_calls == 1

    # A subsequent prefetch serves the warm cache, still no new inline vault call.
    prov.prefetch("lesson", session_id="s3")
    assert vault.recall_calls == 1


# ----- fail-open degradation ---------------------------------------------------------


def test_offline_vault_degrades_cleanly(tmp_path):
    """A vault that RAISES on recall must not break queue_prefetch or prefetch — the loop
    runs store-only, fail-open (the base catches and degrades the warm to [])."""

    class RaisingVault:
        def recall(self, query):
            raise RuntimeError("vault offline")

    prov = _provider(tmp_path, vault=RaisingVault())
    _seed_store_lesson(prov, "store lesson survives a dead vault")

    prov.queue_prefetch("lesson", session_id="s4")  # must not raise
    block = prov.prefetch("lesson", session_id="s4")
    assert "store lesson survives a dead vault" in block
    assert "(S)" in block and "(V)" not in block  # store hit present, no vault hit


def test_empty_vault_contributes_nothing(tmp_path):
    """An empty (but live) vault simply adds no items — store recall is unaffected."""
    prov = _provider(tmp_path, vault=FakeVault(items=[]))
    _seed_store_lesson(prov, "only the store has this lesson")
    prov.queue_prefetch("lesson", session_id="s5")
    block = prov.prefetch("lesson", session_id="s5")
    assert "only the store has this lesson" in block
    assert "(V)" not in block


# ----- QMD adapter contract (no live QMD) --------------------------------------------


def test_qmd_adapter_fail_open_on_broken_binary():
    """``QmdVaultCache.recall`` returns [] (never raises) when the node/qmd binary is bogus."""
    vault = QmdVaultCache(qmd_js="/nonexistent/qmd.js", node_bin="definitely-not-a-real-node-bin")
    assert vault.recall("anything") == []
    # Empty query short-circuits to [] without spawning anything.
    assert vault.recall("   ") == []


def test_qmd_adapter_normalizes_and_squashes_score():
    """``_normalize_items`` maps QMD search JSON to [{content, score}] with the store-band
    squash (BM25 score s -> s/(s+1) in [0,1)) and the snippet>title text precedence."""
    vault = QmdVaultCache()
    items = vault._normalize_items(
        [
            {"docid": "#a", "score": 1.0, "title": "T1", "snippet": "snippet one"},
            {"docid": "#b", "score": 3.0, "title": "title only"},  # no snippet -> title
            {"docid": "#c", "score": 0.5},  # no text at all -> dropped
            "not-a-dict",  # malformed -> dropped
        ]
    )
    assert items == [
        {"content": "snippet one", "score": pytest.approx(0.5)},   # 1/(1+1)
        {"content": "title only", "score": pytest.approx(0.75)},   # 3/(3+1)
    ]
    # Squashed score never reaches the store's authoritative 1.0 band.
    assert all(it["score"] < 1.0 for it in items)
