#!/usr/bin/env python3
"""ngram-hash-384.v1 — the deterministic FR-09/TECH-09 embedder.

One embedder, two implementations: this module (seed generation, tests) and
services/edge/src/linking.ts (query-time). Both must produce bit-identical
vectors; tests/golden equivalence is pinned from both sides against
services/edge/test/golden_embeddings.json.

Why a hashing embedder for P0: the linking contract (TECH-09) is pgvector
storage + cosine search over taxonomy nodes, never the match path. A
deterministic character-n-gram feature hash gives real lexical-semantics
recall with zero external dependencies and fully reproducible seeds; a
learned model can replace the embedder later without touching the schema,
the route, or the confirmation flow — only the vectors (embedder id is
versioned per row for exactly that swap).

Algorithm (the cross-language contract — change both sides or neither):
  1. lowercase; replace every [^a-z0-9]+ run with one space; split on
     whitespace (drops empties);
  2. per token, in order: the whole token, then its character bigrams
     left-to-right, then its trigrams left-to-right;
  3. per feature: sha256(feature as utf-8); index = uint32-LE(digest[0:4])
     mod 384; sign = +1 when digest[4] & 1 else -1; vec[index] += sign;
  4. L2-normalise; the zero vector (no features) stays zero.
"""

from __future__ import annotations

import hashlib
import math
import re

EMBEDDER_ID = "ngram-hash-384.v1"
DIMS = 384

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def tokens(text: str) -> list[str]:
    return [t for t in _NON_ALNUM.sub(" ", text.lower()).strip().split() if t]


def _features(token: str) -> list[str]:
    out = [token]
    for n in (2, 3):
        out.extend(token[i : i + n] for i in range(len(token) - n + 1))
    return out


def embed(text: str) -> list[float]:
    vec = [0.0] * DIMS
    for token in tokens(text):
        for feature in _features(token):
            digest = hashlib.sha256(feature.encode("utf-8")).digest()
            idx = int.from_bytes(digest[0:4], "little") % DIMS
            vec[idx] += 1.0 if digest[4] & 1 else -1.0
    norm = math.sqrt(sum(v * v for v in vec))
    return [v / norm for v in vec] if norm > 0 else vec


def node_text(node_id: str, label: str) -> str:
    """Seed-side input: the label plus the dotted path as words, so a node
    inherits its ancestors' context (music.jazz embeds as "jazz music jazz")."""
    return f"{label} {node_id.replace('.', ' ')}"
