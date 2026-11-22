#!/usr/bin/env python3
"""Export an InterestGraph as SQL seed for the taxonomy tables.

Materializes the ancestor closure (TR-18) at import time so the match
service never walks parents at query time. Usage:

    python3 scripts/export_taxonomy_sql.py > db/seed/taxonomy.sql
    psql $DATABASE_URL -f db/migrations/0001_init.sql -f db/seed/taxonomy.sql
"""

from __future__ import annotations

import sys

from presence.eval_harness import eval_graph


def esc(s: str) -> str:
    return s.replace("'", "''")


def main() -> None:
    graph = eval_graph()
    out = ["BEGIN;",
           "-- taxonomy_nodes"]
    # parents must land before children for the FK; sort by id depth
    nodes = sorted(graph, key=lambda n: (n.nid.count("."), n.nid))
    for n in nodes:
        depth = n.nid.count(".")
        redirect = f"'{n.redirect}'" if n.redirect else "NULL"
        parent = f"'{n.parent}'" if n.parent else "NULL"
        out.append(
            "INSERT INTO taxonomy_nodes (node_id, label, parent_id, kind, sensitive, redirect_to, depth)"
            f" VALUES ('{esc(n.nid)}', '{esc(n.label)}', {parent}, '{n.kind}',"
            f" {'true' if n.sensitive else 'false'}, {redirect}, {depth})"
            " ON CONFLICT (node_id) DO NOTHING;")

    out.append("\n-- taxonomy_closure (TR-18, TR-04 decay 0.55^hops)")
    for n in nodes:
        for ancestor, hops in graph.ancestors(n.nid):
            out.append(
                "INSERT INTO taxonomy_closure (node_id, ancestor_id, hops, decay)"
                f" VALUES ('{n.nid}', '{ancestor}', {hops}, {0.55 ** hops:.6f})"
                " ON CONFLICT DO NOTHING;")

    out.append("\n-- taxonomy_links (TR-07)")
    seen = set()
    for n in nodes:
        for _neighbor, link in graph.links_from(n.nid):
            key = (link.a, link.b, link.kind)
            if key in seen:
                continue
            seen.add(key)
            out.append(
                "INSERT INTO taxonomy_links (a_id, b_id, kind, weight)"
                f" VALUES ('{link.a}', '{link.b}', '{link.kind}', {link.weight})"
                " ON CONFLICT DO NOTHING;")

    out.append("COMMIT;")
    sys.stdout.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
