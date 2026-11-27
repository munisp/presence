#!/usr/bin/env python3
"""INF-17: migration rehearsal against a production-sized snapshot.

Migrations are forward-only (lint, below), reviewed (docs/ops/migrations.md
checklist), and — this script — rehearsed: a fresh database is migrated to
the previous release, populated with a synthetic snapshot at production
scale, then the pending migration is applied under a stopwatch and the data
is asserted intact afterwards.

Usage (CI — see the migration-rehearsal job in .github/workflows/ci.yml):

    DATABASE_URL=postgres://postgres:rehearse@localhost:5432/rehearse \
        python3 scripts/rehearse_migrations.py

Knobs:
    REHEARSAL_SCALE   multiplier on every population figure (default 1.0;
                      smoke runs can drop to 0.01)
    REHEARSAL_NEWEST  how many trailing migrations count as "the release"
                      (default 1)
    REHEARSAL_BUDGET_S  total budget (default 900)

The lint half (lint_forward_only) needs no database and is pinned by pytest.

Stub semantics (same as scripts/rehearse_full_chain.py): the CI service
image is vanilla Postgres, so CREATE EXTENSION lines are stripped and the
extension surface (postgis / h3 / pgvector / pgcrypto) is replaced by the
shared STUB_SQL + transform() layer. What this rehearsal still proves on
every push: every migration parses and applies in order, forward-only,
against a production-sized snapshot, with data survival, FK validation and
RLS coverage asserted afterwards. Real-PostGIS geofence behaviour is gated
separately by the geofence-gates job (postgis/postgis image).
"""

from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = ROOT / "db" / "migrations"

SCALE = float(os.environ.get("REHEARSAL_SCALE", "1.0"))
NEWEST = int(os.environ.get("REHEARSAL_NEWEST", "1"))
BUDGET_S = int(os.environ.get("REHEARSAL_BUDGET_S", "900"))

# ---------------------------------------------------------------- lint -----

_COMMENT = re.compile(r"--[^\n]*|/\*.*?\*/", re.S)
# Data-destroying statements that may never appear in a forward-only
# migration. Row-level retention DELETEs inside governed functions
# (NFR-19/20/22) are allowed — they delete rows by design, never schema.
DESTRUCTIVE = re.compile(
    r"\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDROP\s+COLUMN\b|\bDROP\s+SCHEMA\b|\bDROP\s+EXTENSION\b",
    re.I,
)


def lint_forward_only(paths: list[Path]) -> list[str]:
    """Return a violation string per data-destroying statement found."""
    violations: list[str] = []
    for p in paths:
        body = _COMMENT.sub("", p.read_text())
        for m in DESTRUCTIVE.finditer(body):
            line = body[: m.start()].count("\n") + 1
            violations.append(f"{p.name}:{line}: {m.group(0).upper()}")
    return violations


# ------------------------------------------------------- synthetic data -----
# Base-column inserts only: every column added since 0001 is nullable or
# defaulted (verified against the ALTER TABLE statements), so the snapshot
# stays valid as the schema grows. FK dependency order is respected.

def snapshot_statements(scale: float) -> list[tuple[str, str]]:
    """(label, SQL) pairs populating the production-shaped spine. One
    statement per entry (psycopg execute() is single-statement); temp tables
    live for the session, which the rehearsal uses end to end."""
    users = int(100_000 * scale)
    venues = int(1_000 * scale)
    nodes = int(1_000 * scale)
    interests = int(500_000 * scale)
    matches = int(200_000 * scale)
    messages = int(600_000 * scale)
    ledger = int(400_000 * scale)
    reports = int(50_000 * scale)
    events = int(2_000 * scale)

    stmts: list[tuple[str, str]] = [
        ("taxonomy roots", """
            INSERT INTO taxonomy_nodes (node_id, label, kind, sensitive, depth)
            SELECT 'root' || g, 'Root ' || g, 'domain', false, 0
              FROM generate_series(1, 10) AS g
        """),
        ("taxonomy nodes", f"""
            INSERT INTO taxonomy_nodes (node_id, label, parent_id, kind, sensitive, depth)
            SELECT 'n' || g, 'Node ' || g, 'root' || (1 + g % 10), 'leaf', false, 1
              FROM generate_series(1, {nodes}) AS g
        """),
        ("users staging", f"""
            CREATE TEMP TABLE rehearsal_users AS
            SELECT gen_random_uuid() AS uid, row_number() OVER () AS rn
              FROM generate_series(1, {users})
        """),
        ("users", """
            INSERT INTO users (user_id) SELECT uid FROM rehearsal_users
        """),
        ("profile interests", f"""
            INSERT INTO profile_interests (user_id, node_id, weight)
            SELECT uid, 'n' || (1 + (rn + k) % {nodes}), 0.5 + (k % 5)::real / 10
              FROM rehearsal_users CROSS JOIN generate_series(0, 4) AS k
             LIMIT {interests}
        """),
        ("venues staging", f"""
            CREATE TEMP TABLE rehearsal_venues AS
            SELECT gen_random_uuid() AS vid FROM generate_series(1, {venues})
        """),
        ("venues", """
            INSERT INTO venues (venue_id, name) SELECT vid, 'Venue ' || vid FROM rehearsal_venues
        """),
        ("events", f"""
            INSERT INTO events (venue_id, name, starts_at, ends_at)
            SELECT vid, 'Event', now() - interval '1 hour', now() + interval '3 hours'
              FROM (SELECT vid, row_number() OVER () AS rn FROM rehearsal_venues) v
                   CROSS JOIN generate_series(1, {max(events // max(venues, 1), 1)}) AS k
             LIMIT {events}
        """),
        ("pairs staging", f"""
            -- Adjacent and skip-one pairings over the ordered user list give
            -- unique (lo, hi) pairs without a cross product.
            CREATE TEMP TABLE rehearsal_pairs AS
            SELECT a.uid AS lo, b.uid AS hi
              FROM (SELECT uid, rn FROM rehearsal_users) a
              JOIN (SELECT uid, rn FROM rehearsal_users) b
                ON b.rn = a.rn + 1 OR b.rn = a.rn + 2
             WHERE a.uid < b.uid
             LIMIT {matches}
        """),
        ("matches", """
            INSERT INTO matches (user_lo, user_hi)
            SELECT least(lo, hi), greatest(lo, hi) FROM rehearsal_pairs
        """),
        ("messages", f"""
            INSERT INTO messages (pair_id, sender, envelope)
            SELECT m.pair_id, m.user_lo, decode(md5(m.pair_id::text || k), 'hex')
              FROM matches m CROSS JOIN generate_series(1, 3) AS k
             LIMIT {messages}
        """),
        ("consent ledger", f"""
            -- Mirrors the real write path (0030): pairs are born with
            -- matches.state = 'DETECTED'; the ledger opens DETECTED->EXPRESSED
            -- and continues EXPRESSED->MUTUAL (FR-29 legal transitions only).
            INSERT INTO consent_ledger (pair_id, actor, from_state, to_state)
            SELECT pair_id, user_lo, 'DETECTED'::consent_state, 'EXPRESSED'::consent_state FROM matches
            UNION ALL
            SELECT pair_id, user_hi, 'EXPRESSED'::consent_state, 'MUTUAL'::consent_state FROM matches
             LIMIT {ledger}
        """),
        ("reports", f"""
            INSERT INTO reports (reporter, reported, reason, category)
            SELECT a.uid, b.uid, 'rehearsal report', 'other'
              FROM (SELECT uid, rn FROM rehearsal_users) a
              JOIN (SELECT uid, rn FROM rehearsal_users) b ON b.rn = a.rn + 3
             LIMIT {reports}
        """),
    ]
    return stmts


# ------------------------------------------------------------- rehearsal ----

def main() -> int:
    migrations = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if len(migrations) <= NEWEST:
        print("nothing to rehearse")
        return 0

    violations = lint_forward_only(migrations)
    if violations:
        print("FORWARD-ONLY VIOLATIONS:")
        for v in violations:
            print(" ", v)
        return 1
    print(f"forward-only lint clean across {len(migrations)} migrations")

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set — lint only (rehearsal needs a database)")
        return 0

    import psycopg

    from rehearse_full_chain import STUB_SQL, transform

    baseline, release = migrations[:-NEWEST], migrations[-NEWEST:]
    started_all = time.monotonic()

    def apply(conn, path: Path) -> float:
        t = time.monotonic()
        with conn.cursor() as cur:
            cur.execute(transform(path.read_text()))
        return time.monotonic() - t

    populated = [
        "taxonomy_nodes", "users", "profile_interests", "venues", "events",
        "matches", "messages", "consent_ledger", "reports",
    ]

    with psycopg.connect(url, autocommit=True) as conn:
        # 0. Stub the extension surface (postgis/h3/vector/pgcrypto) — see
        #    the module docstring; transform() strips the CREATE EXTENSIONs.
        with conn.cursor() as cur:
            for stmt in STUB_SQL:
                cur.execute(stmt)

        # 1. Bring the database to the previous release.
        t0 = time.monotonic()
        for m in baseline:
            apply(conn, m)
        print(f"baseline {baseline[0].name}..{baseline[-1].name} applied in {time.monotonic() - t0:.1f}s")

        # 2. Production-sized synthetic snapshot.
        with conn.cursor() as cur:
            t0 = time.monotonic()
            for label, sql in snapshot_statements(SCALE):
                t = time.monotonic()
                cur.execute(sql)
                print(f"  snapshot: {label} ({time.monotonic() - t:.1f}s)")
            print(f"snapshot populated in {time.monotonic() - t0:.1f}s")

            before = {}
            for table in populated:
                cur.execute(f"SELECT count(*) FROM {table}")
                before[table] = cur.fetchone()[0]

        # 3. Apply the release under rehearsal, timed per migration.
        for m in release:
            dt = apply(conn, m)
            print(f"release migration {m.name} applied in {dt:.1f}s")
            if dt > 120:
                print(f"WARN: {m.name} took {dt:.0f}s on production-sized data — review its lock profile")

        # 4. Assert the data survived intact and the schema is sound.
        with conn.cursor() as cur:
            failures = 0
            for table in populated:
                cur.execute(f"SELECT count(*) FROM {table}")
                after = cur.fetchone()[0]
                if after < before[table]:
                    print(f"FAIL: {table} lost rows ({before[table]} -> {after})")
                    failures += 1
            cur.execute("SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated")
            if cur.fetchone()[0] != 0:
                print("FAIL: unvalidated foreign keys after migration")
                failures += 1

            # RLS coverage derived from the migrations themselves.
            rls_tables = {
                t
                for m in migrations
                for t in re.findall(
                    r"ALTER TABLE (\w+)\s+ENABLE ROW LEVEL SECURITY",
                    m.read_text(),
                )
            }
            cur.execute(
                "SELECT relname FROM pg_class WHERE relname = ANY(%s) AND NOT relrowsecurity",
                (sorted(rls_tables),),
            )
            missing = [r[0] for r in cur.fetchall()]
            if missing:
                print(f"FAIL: RLS disabled on {missing}")
                failures += 1

            # Smoke: the heaviest production join shape still resolves.
            cur.execute(
                "SELECT count(*) FROM messages m JOIN matches p ON p.pair_id = m.pair_id LIMIT 1"
            )

        elapsed = time.monotonic() - started_all
        print(f"rehearsal complete in {elapsed:.1f}s (budget {BUDGET_S}s)")
        if failures:
            return 1
        if elapsed > BUDGET_S:
            print("FAIL: rehearsal exceeded its budget")
            return 1
        print("REHEARSAL PASS")
        return 0


if __name__ == "__main__":
    sys.exit(main())
