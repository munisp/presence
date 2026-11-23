#!/usr/bin/env python3
"""TR-21 acceptance criteria: 250k-node closure rebuild under ten minutes.

The absolute timing is enforced where a real Postgres exists — the
taxonomy-scale CI job runs scripts/scale_taxonomy_closure.py against a
postgres:17 service on every PR and push to main. These tests pin the
harness contract (governed scale and budget, CTE extracted verbatim from
migration 0012, deterministic 250k-node graph, exact expected row count)
and execute the walk CTE functionally against SQLite so the semantics —
ancestors only, hops 1..4 — are verified here, not just in CI.

Run: python3 -m pytest tests/test_closure_scale.py
"""

from __future__ import annotations

import importlib.util
import re
import sqlite3
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0012_taxonomy_cms.sql").read_text()
CI = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())


def _harness():
    spec = importlib.util.spec_from_file_location(
        "scale_taxonomy_closure", ROOT / "scripts/scale_taxonomy_closure.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["scale_taxonomy_closure"] = module
    spec.loader.exec_module(module)
    return module


harness = _harness()


# ------------------------------------------------------------ contract -----

def test_tr21_governed_scale_and_budget() -> None:
    assert harness.NODE_COUNT == 250_000
    assert harness.TIME_BUDGET_S == 600
    assert harness.MAX_DEPTH == 5


def test_tr21_cte_extracted_verbatim_from_migration() -> None:
    cte = harness.extract_walk_cte(MIGRATION)
    # The extracted block is exactly what migration 0012 ships — the harness
    # cannot drift from the governed function.
    assert cte in MIGRATION
    assert "WITH RECURSIVE walk (node_id, ancestor_id, hops)" in cte
    assert "w.hops < 4" in cte
    assert "WHERE n.parent_id IS NOT NULL" in cte


def test_tr21_harness_uses_extracted_cte_not_a_copy() -> None:
    source = (ROOT / "scripts/scale_taxonomy_closure.py").read_text()
    assert "walk_cte = extract_walk_cte(MIGRATION.read_text())" in source
    assert "{walk_cte}" in source


def test_tr21_generator_reaches_the_governed_scale() -> None:
    nodes = harness.generate()
    assert len(nodes) == 250_000
    # Deterministic: same seed, same graph.
    again = harness.generate()
    assert nodes[:100] == again[:100]
    assert nodes[-100:] == again[-100:]
    # Parents always precede children (safe for COPY + FK-free checks).
    position = {nid: i for i, (nid, _pid) in enumerate(nodes)}
    for i, (_nid, pid) in enumerate(nodes):
        if pid is not None:
            assert position[pid] < i
    # Depth respects the taxonomy cap (roots are depth 0).
    assert max(nid.count(".") for nid, _ in nodes) <= harness.MAX_DEPTH - 1


def test_tr21_expected_row_count_contract() -> None:
    # Ancestors only, hops 1..4 — cross-checked functionally below.
    nodes = [
        ("a", None),
        ("a.b", "a"),
        ("a.b.c", "a.b"),
        ("a.b.c.d", "a.b.c"),
        ("a.b.c.d.e", "a.b.c.d"),
        ("a.b.c.d.e.f", "a.b.c.d.e"),   # depth 5 — beyond the cap but the
    ]                                    # walker must stop at 4 hops
    # a.b:1, a.b.c:2, a.b.c.d:3, e:4, f:4 (a is out of range at hop 5)
    assert harness.expected_closure_rows(nodes) == 1 + 2 + 3 + 4 + 4


# ------------------------------------------------ functional (SQLite) ------

def _run_walk_sqlite(nodes: list[tuple[str, str | None]]) -> list[tuple[str, str, int]]:
    cte = harness.extract_walk_cte(MIGRATION)
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE taxonomy_nodes (node_id TEXT PRIMARY KEY, parent_id TEXT)")
    conn.executemany("INSERT INTO taxonomy_nodes VALUES (?, ?)", nodes)
    rows = conn.execute(
        f"{cte} SELECT node_id, ancestor_id, hops FROM walk"
    ).fetchall()
    conn.close()
    return sorted(rows)


def test_tr21_walk_cte_semantics_match_python_model() -> None:
    nodes = [
        ("a", None),
        ("a.b", "a"),
        ("a.b.c", "a.b"),
        ("a.b.c.d", "a.b.c"),
        ("a.b.c.d.e", "a.b.c.d"),
        ("a.b.c.d.e.f", "a.b.c.d.e"),
        ("x", None),
        ("x.y", "x"),
    ]
    sql_rows = _run_walk_sqlite(nodes)
    parent = {nid: pid for nid, pid in nodes}
    expected: list[tuple[str, str, int]] = []
    for nid, pid in nodes:
        hops = 0
        cur = pid
        while cur is not None and hops < 4:
            hops += 1
            expected.append((nid, cur, hops))
            cur = parent[cur]
    assert sql_rows == sorted(expected)
    # The deep node stops at hop 4 — the fifth ancestor is out of range.
    deep = [r for r in sql_rows if r[0] == "a.b.c.d.e.f"]
    assert len(deep) == 4
    assert ("a.b.c.d.e.f", "a", 5) not in sql_rows


def test_tr21_full_graph_sqlite_spot_check() -> None:
    # A deterministic slice of the real 250k graph, executed end to end.
    nodes = harness.generate()[:5_000]
    # Close the slice: drop children whose parent fell outside it.
    ids = {nid for nid, _ in nodes}
    closed = [(nid, pid if pid in ids else None) for nid, pid in nodes]
    sql_count = len(_run_walk_sqlite(closed))
    assert sql_count == harness.expected_closure_rows(closed)
    assert sql_count > 5_000  # the closure is denser than the node set


# ------------------------------------------------------------------- CI ----

def test_tr21_ci_job_enforces_the_budget_against_real_postgres() -> None:
    job = CI["jobs"]["taxonomy-scale"]
    service = job["services"]["postgres"]
    assert "postgres:17" in service["image"]
    runs = "\n".join(str(s.get("run", "")) for s in job["steps"])
    assert "python3 scripts/scale_taxonomy_closure.py" in runs
    env = {k: v for s in job["steps"] for k, v in (s.get("env") or {}).items()}
    assert env["DATABASE_URL"].startswith("postgres://")
    # The harness itself asserts the 600-s budget and the exact row count.
    source = (ROOT / "scripts/scale_taxonomy_closure.py").read_text()
    assert "rebuild_s < TIME_BUDGET_S" in source
    assert "got == expected" in source
