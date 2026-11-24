"""The curated interest graph (PRS-SRS-001 §6.4).

The graph is an acyclic hierarchy of at most five levels (TR-17) plus typed
non-hierarchical edges (rivalry, neighbour, co-occurrence). Node identifiers
are immutable and stable across releases (TR-19); deprecation is a redirect,
never a rename.

This module is the in-memory reference implementation. The production service
serves ancestor lookups from a materialised closure table in Postgres
(TR-18); the closure built here is exactly what that table holds.
"""

from __future__ import annotations

from dataclasses import dataclass, field

MAX_DEPTH = 5          # TR-17: hierarchy of at most five levels
EXPANSION_DEPTH = 4    # TR-04: closure expands at most four hops up
DECAY = 0.55           # TR-04: weight decays by 0.55 per hop up the taxonomy
LINK_WEIGHT_CAP = 0.5  # TR-07: a semantic link contributes one hop at <= 0.5


@dataclass(frozen=True)
class Node:
    """One taxonomy node. `nid` is the immutable, dotted identifier."""

    nid: str
    label: str
    parent: str | None
    kind: str          # domain | region | country | city | sport | league | club | genre | topic
    sensitive: bool = False
    redirect: str | None = None


@dataclass(frozen=True)
class Link:
    """A typed, weighted, non-hierarchical edge between two nodes."""

    a: str
    b: str
    kind: str          # rivalry | neighbour | co_occurs
    weight: float


class InterestGraph:
    """Hierarchy plus typed links, with closure expansion.

    Closure expansion (TR-04): a declared interest contributes weight 1.0 to
    itself and DECAY**hop to each ancestor, up to EXPANSION_DEPTH hops.
    Semantic links (TR-07) contribute one hop at no more than
    LINK_WEIGHT_CAP and are never part of document-frequency computation.
    """

    def __init__(self, nodes: list[Node], links: list[Link] | None = None):
        self._nodes: dict[str, Node] = {n.nid: n for n in nodes}
        self._links: dict[str, list[tuple[str, Link]]] = {}
        for link in links or []:
            for nid in (link.a, link.b):
                if nid not in self._nodes:
                    raise KeyError(f"link references unknown node {nid!r}")
            self._links.setdefault(link.a, []).append((link.b, link))
            self._links.setdefault(link.b, []).append((link.a, link))
        self._validate()

    # ------------------------------------------------------------ basics ---

    def _validate(self) -> None:
        for nid, node in self._nodes.items():
            if node.parent is not None and node.parent not in self._nodes:
                raise KeyError(f"{nid!r} has unknown parent {node.parent!r}")
        # acyclicity and depth, following parents to the root
        for nid in self._nodes:
            seen, depth, cur = set(), 0, nid
            while self._nodes[cur].parent is not None:
                if cur in seen:
                    raise ValueError(f"cycle through {nid!r}")
                seen.add(cur)
                depth += 1
                cur = self._nodes[cur].parent
            if depth > MAX_DEPTH:
                raise ValueError(f"{nid!r} exceeds hierarchy depth {MAX_DEPTH}")

    def __getitem__(self, nid: str) -> Node:
        return self._nodes[nid]

    def __contains__(self, nid: str) -> bool:
        return nid in self._nodes

    def __len__(self) -> int:
        return len(self._nodes)

    def __iter__(self):
        return iter(self._nodes.values())

    def resolve(self, nid: str) -> str:
        """TR-19: resolve a possibly-deprecated id to its live successor.

        Ids are immutable — a deprecated node keeps its id and redirects;
        the CMS prohibits chains (a redirect target must be live), and the
        hop cap is defence in depth against a bad release, nothing more.
        """
        cur = nid
        for _ in range(4):
            node = self._nodes[cur]
            if node.redirect is None:
                return cur
            cur = node.redirect
        return cur

    # ---------------------------------------------------------- hierarchy ---

    def ancestors(self, nid: str, max_depth: int = EXPANSION_DEPTH):
        """Yield (ancestor_nid, hops) walking up the hierarchy."""
        cur, hops = nid, 0
        while self._nodes[cur].parent is not None and hops < max_depth:
            cur = self._nodes[cur].parent
            hops += 1
            yield cur, hops

    def depth(self, nid: str) -> int:
        d, cur = 0, nid
        while self._nodes[cur].parent is not None:
            cur = self._nodes[cur].parent
            d += 1
        return d

    def is_ancestor(self, maybe_ancestor: str, nid: str) -> bool:
        return any(a == maybe_ancestor for a, _ in self.ancestors(nid, MAX_DEPTH))

    def lowest_common_ancestor(self, a: str, b: str) -> str | None:
        seen = {a}
        seen.update(x for x, _ in self.ancestors(a, MAX_DEPTH))
        cur: str | None = b
        while cur is not None:
            if cur in seen:
                return cur
            cur = self._nodes[cur].parent
        return None

    def links_from(self, nid: str) -> list[tuple[str, Link]]:
        """(other_nid, link) for every semantic edge touching `nid`."""
        return list(self._links.get(nid, ()))

    # ------------------------------------------------------------ closure ---

    def closure(self, nid: str, weight: float = 1.0) -> dict[str, float]:
        """The link-free taxonomy closure of one declared interest.

        {node: weight} including the node itself at `weight` and each
        ancestor at weight * DECAY**hop (TR-04). This is the shape the
        production closure table materialises (TR-18) and the only shape
        document frequency may be computed over (TR-05).
        """
        out = {nid: weight}
        for anc, hops in self.ancestors(nid):
            out[anc] = weight * (DECAY ** hops)
        return out


def resolve_profile(profile: dict[str, float], graph: InterestGraph) -> dict[str, float]:
    """TR-19: resolve declarations through deprecation redirects.

    Weights max-combine when two declared ids land on the same live node; a
    node the taxonomy no longer knows is skipped rather than raising — the
    scan path must survive a profile written against an older release.
    Insertion order is preserved (golden-parity contract).
    """
    out: dict[str, float] = {}
    for nid, w in profile.items():
        if nid not in graph:
            continue
        resolved = graph.resolve(nid)
        out[resolved] = max(out.get(resolved, 0.0), w)
    return out
