#!/usr/bin/env python3
"""TR-21 scale test: rebuild the closure for a 250,000-node taxonomy in
under ten minutes.

The synthetic graph is deterministic (seeded) and shaped like the governed
taxonomy: depth is capped at 5, every non-root has exactly one parent, and
node ids are path strings. The closure is rebuilt with the governed CTE —
the exact WITH RECURSIVE block extracted from
db/migrations/0012_taxonomy_cms.sql — so the test cannot drift away from
the function production runs.

Usage (CI — see the taxonomy-scale job in .github/workflows/ci.yml):

    DATABASE_URL=postgres://postgres:scale@localhost:5432/scale \
        python3 scripts/scale_taxonomy_closure.py

SCALE_NODES overrides the node count for smoke runs; the governed figure
is 250,000 and the budget is 600 seconds (TR-21).
"""

from __future__ import annotations

import os
import random
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "db/migrations/0012_taxonomy_cms.sql"

# TR-21: the governed scale and budget.
NODE_COUNT = 250_000
MAX_DEPTH = 5
TIME_BUDGET_S = 600
SEED = 0x7A21

# Shape: a content-taxonomy-like tree — hundreds of roots, thinning fanout
# with depth so a share of nodes sits at the governed depth cap.
ROOT_COUNT = 400
FANOUT_BY_DEPTH = (9, 7, 5, 3)  # children per node at depth 0..3


def extract_walk_cte(migration_text: str) -> str:
    """The governed walk CTE, verbatim, from rebuild_taxonomy_closure()."""
    m = re.search(
        r"WITH RECURSIVE walk \(node_id, ancestor_id, hops\) AS \(.*?\n    \)\n",
        migration_text,
        re.S,
    )
    if not m:
        raise SystemExit("walk CTE not found in 0012_taxonomy_cms.sql — has the function changed?")
    return m.group(0)


def generate(node_count: int = NODE_COUNT) -> list[tuple[str, str | None]]:
    """Deterministic synthetic taxonomy: [(node_id, parent_id)], parents first."""
    rng = random.Random(SEED)
    nodes: list[tuple[str, str | None]] = []
    frontier: list[str] = []
    for i in range(min(ROOT_COUNT, node_count)):
        nid = f"r{i:04d}"
        nodes.append((nid, None))
        frontier.append(nid)
    depth = 0
    while len(nodes) < node_count and depth < MAX_DEPTH - 1:
        fanout = FANOUT_BY_DEPTH[min(depth, len(FANOUT_BY_DEPTH) - 1)]
        nxt: list[str] = []
        for parent in frontier:
            for c in range(fanout):
                if len(nodes) >= node_count:
                    break
                nid = f"{parent}.{c}"
                nodes.append((nid, parent))
                nxt.append(nid)
        # Deterministic shuffle so sibling order doesn't correlate with cost.
        rng.shuffle(nxt)
        frontier = nxt
        depth += 1
    if len(nodes) < node_count:
        raise SystemExit(
            f"shape caps at {len(nodes)} nodes below {node_count} — adjust fanout"
        )
    return nodes


def expected_closure_rows(nodes: list[tuple[str, str | None]]) -> int:
    """Ancestors only, hops 1..4 — the same contract as the governed CTE."""
    parent = {nid: pid for nid, pid in nodes}
    total = 0
    for _nid, pid in nodes:
        hops = 0
        cur = pid
        while cur is not None and hops < 4:
            total += 1
            hops += 1
            cur = parent[cur]
    return total


def main() -> int:
    try:
        import psycopg
    except ImportError:
        raise SystemExit("pip install 'psycopg[binary]'")

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is required")
    node_count = int(os.environ.get("SCALE_NODES", NODE_COUNT))
    if node_count > NODE_COUNT:
        raise SystemExit(f"SCALE_NODES above the governed {NODE_COUNT} is not a TR-21 run")

    walk_cte = extract_walk_cte(MIGRATION.read_text())
    nodes = generate(node_count)
    expected = expected_closure_rows(nodes)
    print(f"graph: {len(nodes)} nodes, expected closure rows: {expected}")

    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("DROP TABLE IF EXISTS taxonomy_closure, taxonomy_nodes")
        # Same column shapes as 0001/0012 — the CTE only touches these.
        conn.execute(
            "CREATE TABLE taxonomy_nodes (node_id text PRIMARY KEY, parent_id text)"
        )
        conn.execute(
            """CREATE TABLE taxonomy_closure (
                   node_id text NOT NULL, ancestor_id text NOT NULL,
                   hops integer NOT NULL, decay real NOT NULL,
                   PRIMARY KEY (node_id, ancestor_id))"""
        )
        t0 = time.monotonic()
        with conn.cursor() as cur:
            with cur.copy(
                "COPY taxonomy_nodes (node_id, parent_id) FROM STDIN"
            ) as copy:
                for nid, pid in nodes:
                    copy.write_row((nid, pid))
        load_s = time.monotonic() - t0
        print(f"load: {load_s:.1f}s")

        t0 = time.monotonic()
        conn.execute(
            f"INSERT INTO taxonomy_closure (node_id, ancestor_id, hops, decay)\n"
            f"{walk_cte}    SELECT node_id, ancestor_id, hops, (0.55::double precision ^ hops)::real\n"
            f"      FROM walk"
        )
        rebuild_s = time.monotonic() - t0
        got = conn.execute("SELECT count(*) FROM taxonomy_closure").fetchone()[0]
        print(f"closure rebuild: {rebuild_s:.1f}s, rows: {got}")

    ok_rows = got == expected
    ok_time = rebuild_s < TIME_BUDGET_S
    print(f"row-count check: {'PASS' if ok_rows else 'FAIL'}")
    print(f"TR-21 budget check ({TIME_BUDGET_S}s): {'PASS' if ok_time else 'FAIL'}")
    return 0 if ok_rows and ok_time else 1


if __name__ == "__main__":
    sys.exit(main())
