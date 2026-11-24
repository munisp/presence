"""The matching engine (PRS-SRS-001 §6.2).

Score contract:

    sim(A,B) = sum_n idf(n) * wA(n) * wB(n) / (||vA|| * ||vB||)

where vA, vB are the weighted closure vectors and ||v|| is the
idf-weighted norm, ||v|| = sqrt( sum_n idf(n) * w(n)^2 ). An exact-overlap
bonus of 5% per node declared by both profiles rewards leaves that need no
interpretation (rater brief, worked example 2); the result is capped at 1.0.

  * TR-04  closure weights decay 0.55 per hop, max four hops (see graph.py);
           multiple declarations reaching the same ancestor combine by max
  * TR-05  document frequency over the live population, link-free closures
  * TR-06  idf(n) = sqrt(ln(1 + N / (1 + df(n)))) — square-root-compressed,
           log-smoothed; the square root caps the dynamic range so a single
           rare shared interest cannot dominate a match
  * TR-07  semantic links (rivalry, neighbour, co-occurrence) contribute one
           hop at the authored link weight and are excluded from document-
           frequency computation. Production taxonomy releases cap authored
           link weights at 0.5; the evaluation vocabulary ships legacy 0.55
           rivalry edges which are honoured as authored
  * TR-08  every match returns an ordered reason list with node identifiers,
           labels and contributions, renderable without further server calls
  * TR-09  reason text is generated deterministically from the reason path;
           no LLM is used to generate or embellish reason text
  * TR-10  scoring is deterministic for identical inputs and corpus state

The engine is pure and stateless. In production the Corpus is rebuilt from
the live presence population at least every 60 seconds (TR-05); here it is
built once per run from the reference population.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .graph import DECAY, EXPANSION_DEPTH, LINK_WEIGHT_CAP, InterestGraph, resolve_profile

EXACT_OVERLAP_BONUS = 0.05   # per node declared by both profiles
MIN_PROFILE = 2              # FR-11: fewer than two interests -> not discoverable
SUGGEST_THRESHOLD = 0.12     # FR-21: configured base threshold floor


@dataclass(frozen=True)
class Reason:
    """One ordered reason for a match (TR-08).

    kind is one of:
      same     — both profiles declare the very node
      related  — the declared nodes are joined by a semantic link
      sibling  — the declared nodes share a direct parent
      ancestor — the declared nodes share only a higher ancestor
    """

    kind: str
    node: str                         # the node the reason hangs on
    label: str
    contribution: float               # this reason's share of the numerator
    yours: str | None = None          # declaring node id on side A
    theirs: str | None = None         # declaring node id on side B
    yours_label: str = ""
    theirs_label: str = ""


@dataclass
class Match:
    score: float
    reasons: list[Reason] = field(default_factory=list)


# TR-36: the prior's influence is gone once the live corpus reaches this size.
PRIOR_FADE_N = 30


class Corpus:
    """Document frequency over link-free closures (TR-05), with idf (TR-06)."""

    def __init__(self, size: int, df: dict[str, int]):
        self.size = size
        self.df = df
        self.prior_df: dict[str, int] | None = None
        self.prior_size = 0

    @classmethod
    def from_vectors(cls, vectors: list[dict[str, float]]) -> "Corpus":
        df: dict[str, int] = {}
        for v in vectors:
            for nid in v:
                df[nid] = df.get(nid, 0) + 1
        return cls(len(vectors), df)

    def set_prior(self, prior_df: dict[str, int], prior_size: int) -> None:
        """TR-36: optional global prior over ALL profiles (not just live
        presence). While the live corpus is small the prior gently stabilises
        idf; its influence fades linearly and reaches exactly zero at
        N = PRIOR_FADE_N, so a live corpus of 30+ scores bit-identically to
        the legacy formula (well under the 2% shift bound)."""
        self.prior_df = prior_df
        self.prior_size = prior_size

    def clear_prior(self) -> None:
        self.prior_df = None
        self.prior_size = 0

    def idf(self, nid: str) -> float:
        """Square-root-compressed, log-smoothed idf (TR-06; TR-36 blended)."""
        n = self.df.get(nid, 0)
        if self.prior_df is None or self.prior_size <= 0:
            return math.sqrt(math.log(1.0 + self.size / (1.0 + n)))
        w = max(0.0, (PRIOR_FADE_N - self.size) / PRIOR_FADE_N)
        if w == 0.0:
            return math.sqrt(math.log(1.0 + self.size / (1.0 + n)))
        # Pseudo-count blend: the live df is extended with w*PRIOR_FADE_N
        # pseudo-documents distributed as the global prior. At N = 0 the
        # result is exactly the prior's own idf at size PRIOR_FADE_N.
        s = w * PRIOR_FADE_N
        p0 = self.prior_df.get(nid, 0) / self.prior_size
        return math.sqrt(math.log(1.0 + (self.size + s) / (1.0 + n + s * p0)))


class Matcher:
    """Scores two declared-interest profiles against a corpus."""

    def __init__(self, graph: InterestGraph):
        self.graph = graph

    # ------------------------------------------------------------ vectors ---

    def vector(self, profile: dict[str, float], with_links: bool = True) -> dict[str, float]:
        """Expand a profile into its weighted closure vector.

        Declarations contribute 1.0 to their node and DECAY**hop to each
        ancestor (TR-04); contributions from several declarations combine by
        max. Semantic links add the linked node at its authored weight
        (TR-07). Pass with_links=False for anything feeding document
        frequency, which must be computed over link-free closures (TR-05).
        Declarations resolve through deprecation redirects first (TR-19).
        """
        profile = resolve_profile(profile, self.graph)
        out: dict[str, float] = {}
        for nid, w in profile.items():
            if self.graph[nid].sensitive:
                continue  # TR-22 / FR-10: excluded at write time
            for c_nid, c_w in self.graph.closure(nid, w).items():
                out[c_nid] = max(out.get(c_nid, 0.0), c_w)
        if with_links:
            for nid, w in profile.items():
                if self.graph[nid].sensitive:
                    continue
                for other, link in self.graph.links_from(nid):
                    out[other] = max(out.get(other, 0.0), link.weight * w)
        return out

    # ------------------------------------------------------------ scoring ---

    def score(self, a: dict[str, float], b: dict[str, float], corpus: Corpus) -> Match:
        """Score a pair. Deterministic for identical inputs and corpus (TR-10)."""
        va = self.vector(a)
        vb = self.vector(b)
        if not va or not vb:
            return Match(0.0, [])
        num = 0.0
        for nid, wa in va.items():
            wb = vb.get(nid)
            if wb is not None:
                num += corpus.idf(nid) * wa * wb
        norm_a = math.sqrt(sum(corpus.idf(n) * w * w for n, w in va.items()))
        norm_b = math.sqrt(sum(corpus.idf(n) * w * w for n, w in vb.items()))
        if not norm_a or not norm_b:
            return Match(0.0, [])
        shared = len(set(va_declared(a, self.graph)) & set(va_declared(b, self.graph)))
        score = num / (norm_a * norm_b) * (1.0 + EXACT_OVERLAP_BONUS * shared)
        return Match(min(1.0, score), self._reasons(a, b, corpus))

    # ------------------------------------------------------------ reasons ---

    def _reasons(self, a: dict[str, float], b: dict[str, float],
                 corpus: Corpus) -> list[Reason]:
        """Ordered reason list (TR-08), deterministic (TR-09, TR-10).

        One candidate reason per node shared by the two link-expanded
        closure vectors; the candidate's contribution is that node's share of
        the score numerator, idf(n) * vA(n) * vB(n). A declared node that is
        subsumed by a more specific declaration in the same profile (you
        declared both "Serie A" and "Inter") does not anchor a reason — the
        specific interest carries the signal. Each candidate is rendered from
        the most specific declared node on each side that reaches the shared
        node. Candidates are ordered by contribution and listed by the node
        they hang on.
        """
        va = self.vector(self._reduced(a))
        vb = self.vector(self._reduced(b))
        candidates: list[Reason] = []
        for n in va:
            wb = vb.get(n)
            if wb is None:
                continue
            contribution = corpus.idf(n) * va[n] * wb
            candidates.append(self._make_reason(n, a, b, contribution))
        candidates.sort(key=lambda r: (-r.contribution, r.node))
        return candidates

    def _reduced(self, profile: dict[str, float]) -> dict[str, float]:
        """The profile with subsumed declarations removed for reasoning.

        A declared node is dropped when another declared node in the same
        profile has it as an ancestor: declaring "Serie A" adds nothing once
        you have declared "Inter". Sensitive nodes are dropped too (FR-10).
        Scoring vectors are unaffected; this shapes only the reason list.
        """
        g = self.graph
        declared = [n for n in profile if not g[n].sensitive]
        covered = set()
        for n in declared:
            for anc, _ in g.ancestors(n):
                if anc != n and anc in profile:
                    covered.add(anc)
        return {n: w for n, w in profile.items() if n in declared and n not in covered}

    def _explains(self, node: str, declared: dict[str, float]) -> str | None:
        """The most specific declared node that reaches `node`.

        A declaration reaches a node through its taxonomy closure or through
        one semantic link (TR-07). Ties between equally specific declarers
        break by profile order, so rendering is deterministic (TR-09).
        """
        g = self.graph
        best: str | None = None
        best_depth = -1
        for d in declared:
            if d == node:
                reaches = True
            elif any(a == node for a, _ in g.ancestors(d)):
                reaches = True
            else:
                reaches = any(o == node for o, _ in g.links_from(d))
            if not reaches:
                continue
            depth = g.depth(d)
            if depth > best_depth:
                best, best_depth = d, depth
        return best

    def _make_reason(self, node: str, a: dict[str, float], b: dict[str, float],
                     contribution: float) -> Reason:
        g = self.graph
        da = self._explains(node, a)
        db = self._explains(node, b)
        la, lb = g[da].label, g[db].label
        linked = any(o == db for o, _ in g.links_from(da))
        if da == db:
            return Reason("same", node, g[node].label, contribution, da, db, la, lb)
        if linked:
            return Reason("related", node, g[node].label, contribution, da, db, la, lb)
        if g[da].parent is not None and g[da].parent == g[db].parent:
            return Reason("sibling", node, g[node].label, contribution, da, db, la, lb)
        return Reason("ancestor", node, g[node].label, contribution, da, db, la, lb)


def va_declared(profile: dict[str, float], graph: InterestGraph) -> list[str]:
    """The non-sensitive declared nodes of a profile (FR-10)."""
    return [n for n in profile if not graph[n].sensitive]


def icebreaker(graph: InterestGraph, match: Match) -> str:
    """Render the top reason deterministically from its path (TR-09, FR-27).

    No LLM, no randomness: the same reason path always renders the same
    sentence.
    """
    if not match.reasons:
        return ""
    r = match.reasons[0]
    if r.kind == "same":
        return f"Both into {r.label}"
    if r.kind == "related":
        return f"{r.yours_label} and {r.theirs_label} are neighbours"
    if r.kind == "sibling":
        return f"Both follow {r.label}: {r.yours_label} vs {r.theirs_label}"
    return f"Both into {r.label}: {r.yours_label} and {r.theirs_label}"
