#!/usr/bin/env python3
"""Export the parity fixture for the TypeScript match service.

Writes services/match/test/golden.json containing:
  * taxonomy  — nodes and links exactly as the graph module sees them
  * corpus    — {size, df} of the seed-7 reference population (TR-05)
  * pairs     — profile pairs with full-precision scores and reason lists

The TS test recomputes every pair and asserts agreement to 1e-9, which pins
the port to the Python engine that reproduces the ACC-10 answer key 653/653.
"""

from __future__ import annotations

import json
import random

from presence.eval_harness import VENUES, eval_graph, leaves_by_domain, make_profile
from presence.matching import Corpus, Matcher

OUT = "services/match/test/golden.json"


def main() -> None:
    rng = random.Random(7)
    graph = eval_graph()
    matcher = Matcher(graph)
    by_domain = leaves_by_domain(graph)
    ref = [make_profile(graph, by_domain, rng.choice(VENUES), rng) for _ in range(900)]
    corpus = Corpus.from_vectors([matcher.vector(p, with_links=False) for p in ref])

    links = []
    seen = set()
    for n in graph:
        for _nbr, link in graph.links_from(n.nid):
            if (link.a, link.b, link.kind) in seen:
                continue
            seen.add((link.a, link.b, link.kind))
            links.append({"a": link.a, "b": link.b, "kind": link.kind, "weight": link.weight})

    pairs = []
    prng = random.Random(42)
    parents = {n.parent for n in graph if n.parent}
    leaves = [n.nid for n in graph if n.nid not in parents]
    for _ in range(120):
        a = {n: 1.0 for n in prng.sample(leaves, prng.randint(1, 4))}
        b = {n: 1.0 for n in prng.sample(leaves, prng.randint(1, 4))}
        m = matcher.score(a, b, corpus)
        pairs.append({
            # insertion order matters: reason ties break by profile order
            # (TR-09), so export declarations in the profile's own order
            "a": list(a), "b": list(b),
            "score": m.score,
            "reasons": [
                {"kind": r.kind, "node": r.node, "label": r.label,
                 "contribution": r.contribution}
                for r in m.reasons
            ],
        })

    fixture = {
        "taxonomy": {
            "nodes": [
                {"nid": n.nid, "label": n.label, "parent": n.parent,
                 "kind": n.kind, "sensitive": n.sensitive}
                for n in graph
            ],
            "links": links,
        },
        "corpus": {"size": corpus.size, "df": dict(sorted(corpus.df.items()))},
        "pairs": pairs,
    }
    with open(OUT, "w") as fh:
        json.dump(fixture, fh, indent=1)
    print(f"wrote {OUT}: {len(pairs)} pairs, {len(links)} links, "
          f"{len(fixture['taxonomy']['nodes'])} nodes")


if __name__ == "__main__":
    main()
