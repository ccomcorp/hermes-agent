"""Dependency-free embedding for optional recall re-ranking.

The PRIMARY recall path is FTS5/BM25 (in store.py). The embedder is an OPTIONAL
re-rank hook: it scores already-recalled candidates against the query so a real
sentence-transformer can be swapped in later behind the same Protocol. We ship a
LexicalEmbedder (token-set / hashing-based) so the unit is testable standalone with
NO heavy third-party deps (no sentence-transformers, no numpy).

Ported from AIOS packages/memory/experience-store/embed.py
Source: commit 089213f, SHA-256 352BD22A...
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Protocol, Sequence, runtime_checkable

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_DIM = 256  # hashing-trick dimensionality; small and dependency-free


def _tokens(text: str) -> list[str]:
    return _TOKEN_RE.findall((text or "").lower())


@runtime_checkable
class Embedder(Protocol):
    """The pluggable embedding contract. A real vector model wires in here later."""

    def embed(self, text: str) -> Sequence[float]:
        """Return a fixed-length vector for `text`."""
        ...

    def similarity(self, a: Sequence[float], b: Sequence[float]) -> float:
        """Cosine similarity in [0, 1] (clamped) between two vectors."""
        ...


class LexicalEmbedder:
    """A hashing-trick bag-of-tokens embedder. No external model, no numpy.

    Each token is hashed into one of _DIM buckets; the vector is the token-count
    histogram, L2-normalized. Cosine similarity of two such vectors approximates
    token-set overlap and is good enough for a re-rank tie-break over FTS5 hits.
    """

    def __init__(self, dim: int = _DIM):
        self.dim = dim

    def embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        for tok in _tokens(text):
            h = int(hashlib.blake2b(tok.encode("utf-8"), digest_size=8).hexdigest(), 16)
            vec[h % self.dim] += 1.0
        norm = math.sqrt(sum(v * v for v in vec))
        if norm == 0.0:
            return vec
        return [v / norm for v in vec]

    def similarity(self, a: Sequence[float], b: Sequence[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        # vectors are already L2-normalized; clamp for float noise
        return max(0.0, min(1.0, dot))


__all__ = ["Embedder", "LexicalEmbedder"]
