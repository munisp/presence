#!/usr/bin/env python3
"""TECH-24 / TR-41 / TR-42: PostGIS integration gate for the geofence workflow.

The full-chain rehearsal (scripts/rehearse_full_chain.py) stubs every
spatial predicate — geography degrades to text, ST_IsValid is constant
true, ST_Area is constant 0, ST_Segmentize is the identity — so it can run
on a bare scratch cluster. No spatial check ever fires there. This gate is
the complement: it applies the full migration chain against REAL PostGIS
and fires known-answer polygons through every geospatial gate the chain
ships:

  * reality proof   postgis_version(), a geodesic ST_Area over a ~20 m
                    Lagos square (a stub would answer 0), and a real
                    ST_Segmentize split (a stub would return the input)
  * density gate    geofence_density_check (0017): a dense 20 m square
                    passes; a bowtie is 'polygon is not valid'; sub-4-point
                    rings are proven unreachable via WKT (the parser refuses
                    them, so the vertex branch is defensive depth); 2 m and
                    1.5 km squares hit the 10 m2 / 1 km2 area bounds; a
                    26 m edge fails the 25 m segmentisation bound while a
                    24 m edge passes it
  * overlap gate    geofence_overlap_check (0023): far away, shared edge,
                    and a ~3 m2 sliver (below the 10 m2 tolerance) are
                    silent; a ~50% overlap conflicts with the right venue
                    and a plausible m2; a venue never conflicts with itself
  * publish path    publish_geofence_draft (0017, strengthened 0023): the
                    happy path writes the canonical polygon (TR-42), bumps
                    geofence_version (0018), marks the draft published and
                    audits; a wrong reviewer, reviewer-equals-author, an
                    unapproved draft, an unknown draft, a density-failing
                    polygon and an overlapping polygon all raise their
                    named refusals; a floor target is overlap-exempt and
                    publishes over another venue's ground
  * QA report       geofence_qa_report (0023): refuses on a COLD
                    connection that never set app.venue_ops (the batch-63
                    NULL-safe GUC gate — the production case), then returns
                    the estate rows with the legacy density error and
                    symmetric overlap conflicts

Only the non-spatial extension surface is degraded: vector(n) -> text, the
taxonomy HNSW index -> btree, and the h3index domain plus the h3 surface
the chain calls (h3_cell_to_parent identity, h3_get_resolution = 9, and
the 0040 map-bundle reads: h3_is_valid_cell format check, h3_grid_disk
centre-only, h3_latlng_to_cell constant rehearsal cell, h3_cell_to_latlng
identity — the h3-pg extension is not in the postgis CI image, and this
gate asserts geofence behaviour, never h3 geometry). CREATE EXTENSION
lines are stripped — the gate pre-creates postgis and pgcrypto itself.
geography/geometry and every ST_* predicate are REAL.

Usage (CI — the geofence-gates job in .github/workflows/ci.yml):

    DATABASE_URL=postgres://postgres:rehearse@localhost:5432/postgres \
        python3 scripts/verify_geogates.py

DATABASE_URL may point at any database on a PostGIS-enabled cluster; the
gate drops and recreates its own scratch database (presence_geogates), so
it is rerunnable. Without DATABASE_URL the gate skips with a message and
exits 0 (the rehearse_migrations.py pattern).

Prints: verify_geogates: N/N checks PASS
"""
from __future__ import annotations

import os
import re
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION_DIR = ROOT / "db" / "migrations"
SCRATCH_DB = "presence_geogates"

# Lagos Island — the launch metro; every fixture polygon lives here.
LON, LAT = 3.3792, 6.5244

# Applied before the chain, INSTEAD of CREATE EXTENSION h3: the h3index
# domain plus the h3 functions the migrations call (market_for_cell in
# 0014; the AMD-MAP-05 read model in 0040 — same semantics as the
# full-chain rehearsal stubs). postgis + pgcrypto are created for real.
PRE_SQL = [
    "SET check_function_bodies = off",  # pg_dump style: forward references
    "CREATE DOMAIN h3index AS text",
    """CREATE FUNCTION h3_cell_to_parent(h3index, integer) RETURNS h3index
       LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$""",
    """CREATE FUNCTION h3_get_resolution(h3index) RETURNS integer
       LANGUAGE sql IMMUTABLE AS $$ SELECT 9 $$""",
    # AMD-MAP-05 (0040): same rehearsal semantics — centre-only disk,
    # constant centroid cell. This gate never asserts h3 geometry.
    """CREATE FUNCTION h3_is_valid_cell(h3index) RETURNS boolean
       LANGUAGE sql IMMUTABLE AS $$ SELECT $1::text ~ '^[0-9a-f]{15}$' $$""",
    """CREATE FUNCTION h3_grid_disk(h3index, integer) RETURNS SETOF h3index
       LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$""",
    """CREATE FUNCTION h3_latlng_to_cell(text, integer) RETURNS h3index
       LANGUAGE sql IMMUTABLE AS $$ SELECT '8928342e20fffff'::h3index $$""",
    """CREATE FUNCTION h3_cell_to_latlng(h3index) RETURNS text
       LANGUAGE sql IMMUTABLE AS $$ SELECT $1::text $$""",
]

# Geodesic fixture builders (gate-local, installed after the chain). The
# southwest corner sits north_m north of (lon, lat); corners are projected
# on the spheroid so edge lengths are exact to sub-millimetre at any
# latitude — the 24 m / 26 m boundary probes depend on that.
HELPER_SQL = """
CREATE FUNCTION gate_rect(lon float8, lat float8, north_m float8,
                          w_m float8, h_m float8) RETURNS geography
LANGUAGE sql IMMUTABLE AS $$
  WITH sw AS (SELECT ST_Project(
                  ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
                  north_m, 0::float8) AS p),
       se AS (SELECT ST_Project(sw.p, w_m, pi() / 2) AS p FROM sw),
       ne AS (SELECT ST_Project(se.p, h_m, 0::float8) AS p FROM se),
       nw AS (SELECT ST_Project(sw.p, h_m, 0::float8) AS p FROM sw)
  SELECT ST_MakePolygon(ST_MakeLine(ARRAY[
      sw.p::geometry, se.p::geometry, ne.p::geometry, nw.p::geometry,
      sw.p::geometry]))::geography
  FROM sw, se, ne, nw
$$;
CREATE FUNCTION gate_square(lon float8, lat float8, north_m float8,
                            side_m float8) RETURNS geography
LANGUAGE sql IMMUTABLE AS $$ SELECT gate_rect(lon, lat, north_m, side_m, side_m) $$;
"""


def transform(sql: str) -> str:
    """Strip extension loads; degrade ONLY the non-spatial surface.

    geography/geometry stay real (that is the point of this gate); vector
    and the HNSW index degrade to text/btree exactly as in the full-chain
    rehearsal.
    """
    lines = [ln for ln in sql.splitlines()
             if not re.match(r"\s*CREATE EXTENSION", ln, re.IGNORECASE)]
    sql = "\n".join(lines)
    sql = re.sub(r"vector\(\s*\d+\s*\)", "text", sql)
    sql = re.sub(r"\bvector\b", "text", sql)
    sql = sql.replace("USING hnsw (embedding vector_cosine_ops)",
                      "USING btree (embedding)")
    return sql


class Gate:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.total = 0

    def check(self, name: str, cond: bool, detail: str = "") -> None:
        self.total += 1
        if not cond:
            raise AssertionError(f"check failed: {name} {detail}")
        self.passed.append(name)


def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set — skipping PostGIS gate "
              "(needs a PostGIS-enabled cluster)")
        return 0

    import psycopg
    from psycopg import pq
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    g = Gate()

    # ------------------------------------------------ scratch database -----
    parts = conninfo_to_dict(url)
    admin_url = make_conninfo(**parts)
    parts["dbname"] = SCRATCH_DB
    scratch_url = make_conninfo(**parts)

    admin = psycopg.connect(admin_url, autocommit=True)
    admin.execute(f"DROP DATABASE IF EXISTS {SCRATCH_DB} WITH (FORCE)")
    # Roles are cluster-global: dropping the scratch database does not drop
    # the two roles 0001 creates, so a re-run would collide on CREATE ROLE.
    for role in ("presence_app", "presence_match"):
        admin.execute(f"DROP ROLE IF EXISTS {role}")
    admin.execute(f"CREATE DATABASE {SCRATCH_DB}")
    admin.close()

    conn = psycopg.connect(scratch_url, autocommit=True)

    def q(sql, params=(), **gucs):
        """Run one statement in a transaction with the given GUCs set."""
        with conn.transaction():
            for key, val in gucs.items():
                conn.execute("SELECT set_config(%s, %s, true)", (key, str(val)))
            cur = conn.execute(sql, params)
            if cur.pgresult.status == pq.ExecStatus.TUPLES_OK:
                return cur.fetchall()
            return []

    def scalar(sql, params=(), **gucs):
        rows = q(sql, params, **gucs)
        return rows[0][0] if rows else None

    def expect_raise(name, needle, sql, params=(), **gucs):
        try:
            q(sql, params, **gucs)
        except Exception as exc:  # noqa: BLE001 — the needle is the contract
            g.check(name, needle in str(exc), f"got: {exc}")
            return
        raise AssertionError(
            f"check failed: {name} — expected a raise containing {needle!r}")

    # -------------------------------------------- phase 1: chain on real ---
    conn.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    conn.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    for stmt in PRE_SQL:
        conn.execute(stmt)
    files = sorted(MIGRATION_DIR.glob("*.sql"))
    for path in files:
        res = conn.pgconn.exec_(transform(path.read_text()).encode())
        if res.status not in (pq.ExecStatus.COMMAND_OK, pq.ExecStatus.TUPLES_OK):
            raise RuntimeError(
                f"migration {path.name} failed on real PostGIS: "
                f"{res.error_message.decode()}")
    g.check("chain_applied_on_real_postgis",
            len(files) == len(list(MIGRATION_DIR.glob("*.sql"))) > 0,
            f"{len(files)} migrations")
    conn.execute(HELPER_SQL)

    # ------------------------------------- phase 2: reality proof ----------
    # These three checks fail LOUDLY if the spatial surface is ever stubbed
    # again: a stub answers 0 / identity / no postgis_version().
    version = scalar("SELECT postgis_version()")
    g.check("postgis_real",
            isinstance(version, str) and version.split()[0].startswith("3."),
            f"postgis_version() = {version!r}")
    area20 = scalar("SELECT ST_Area(gate_square(%s, %s, 0, 20))", (LON, LAT))
    g.check("geodesic_area_real", 390 < area20 < 410,
            f"20 m Lagos square = {area20} m2 (spheroid ~400)")
    seg = scalar("SELECT ST_NPoints(ST_Segmentize(gate_square(%s, %s, 0, 26), 25)::geometry)",
                 (LON, LAT))
    g.check("segmentize_real", seg == 9, f"26 m square segmentized to {seg} points")

    # ------------------------------------- phase 3: density gate (0017) ----
    def density(sql_expr):
        return scalar(f"SELECT geofence_density_check({sql_expr})")

    g.check("density_valid_passes",
            density(f"gate_square({LON}, {LAT}, 0, 20)") is None)
    g.check("density_bowtie_invalid",
            density("ST_GeogFromText('SRID=4326;POLYGON((3.37920 6.52440,"
                    " 3.37940 6.52460, 3.37940 6.52440, 3.37920 6.52460,"
                    " 3.37920 6.52440))')") == "polygon is not valid")
    # The '< 4 vertices' branch is defensive depth: the WKT parser refuses a
    # sub-4-point ring before any gate can see it. Pin that honestly.
    expect_raise("density_vertex_branch_defensive",
                 "geometry requires more points",
                 "SELECT ST_GeogFromText('SRID=4326;POLYGON((3.3792 6.5244,"
                 " 3.3793 6.5245, 3.3792 6.5244))')")
    g.check("density_too_small",
            density(f"gate_square({LON}, {LAT}, 0, 2)")
            == "polygon area must be between 10 m² and 1 km²")
    g.check("density_too_large",
            density(f"gate_square({LON}, {LAT}, 0, 1500)")
            == "polygon area must be between 10 m² and 1 km²")
    # The 25 m segmentisation boundary, probed geodesically — 24 m passes,
    # 26 m fails (never probe exactly 25.000 m; float edges are unkind).
    g.check("density_edge_24m_passes",
            density(f"gate_square({LON}, {LAT}, 0, 24)") is None)
    g.check("density_edge_26m_fails",
            density(f"gate_square({LON}, {LAT}, 0, 26)")
            == "polygon edges must be at most 25 m (densify the outline)")

    # ------------------------------------- phase 4: overlap gate (0023) ----
    # v1 owns a dense 20 m square at the base point ("legacy estate" — the
    # gate asserts the checks, the state machine is rehearsed elsewhere).
    v1 = scalar("INSERT INTO venues (name, geofence) VALUES ('gate-v1',"
                f" gate_square({LON}, {LAT}, 0, 20)) RETURNING venue_id")

    # The probes below are candidates for a NEW venue — pass a fresh would-be
    # venue id so v1 is IN scope (passing v1's own id would self-exclude it
    # and make every probe vacuous).
    probe = str(uuid.uuid4())

    def overlaps(sql_expr, venue=probe):
        return q(f"SELECT venue_id::text, intersection_m2"
                 f" FROM geofence_overlap_check({sql_expr}, %s)"
                 " ORDER BY intersection_m2 DESC", (str(venue),))

    g.check("overlap_far_zero",
            overlaps(f"gate_square({LON}, {LAT}, 500, 20)") == [])
    g.check("overlap_shared_edge_zero",
            overlaps(f"gate_square({LON}, {LAT}, 20, 20)") == [])
    # ~3 m2 sliver across v1's north edge — below the 10 m2 tolerance.
    g.check("overlap_sliver_below_tolerance",
            overlaps(f"gate_rect({LON}, {LAT}, 19.85, 20, 0.3)") == [])
    half = overlaps(f"gate_square({LON}, {LAT}, 10, 20)")
    g.check("overlap_half_conflicts",
            len(half) == 1 and half[0][0] == str(v1)
            and 150 < half[0][1] < 250,
            f"~200 m2 expected, got {half}")
    g.check("overlap_excludes_self",
            overlaps(f"gate_square({LON}, {LAT}, 0, 20)", venue=v1) == [])

    # ------------------------------------- phase 5: publish path -----------
    # Drafts are inserted directly (superuser): the draft state machine is
    # rehearsed elsewhere — this gate targets the spatial predicates inside
    # the 0023 publish definer.
    author = str(uuid.uuid4())
    reviewer = str(uuid.uuid4())
    third = str(uuid.uuid4())

    def mkdraft(target, venue, polygon_sql, status="approved",
                reviewer_id=None, author_id=None, floor=None):
        return scalar(
            "INSERT INTO geofence_drafts"
            " (target_type, venue_id, floor_id, polygon, author, reviewer, status)"
            f" VALUES (%s, %s, %s, {polygon_sql}, %s, %s, %s) RETURNING draft_id",
            (target, str(venue), floor, author_id or author,
             reviewer_id if reviewer_id is not None else reviewer, status))

    def publish(draft_id, who):
        q("SELECT publish_geofence_draft(%s, %s)", (str(draft_id), str(who)))

    # Happy path: v2 gets its polygon through the one DB-final write path.
    v2 = scalar("INSERT INTO venues (name) VALUES ('gate-v2') RETURNING venue_id")
    d_happy = mkdraft("venue", v2, f"gate_square({LON}, {LAT} + 0.01, 0, 20)")
    publish(d_happy, reviewer)
    g.check("publish_happy_path", True)
    canon = scalar("SELECT ST_Area(geofence) FROM venues WHERE venue_id = %s",
                   (str(v2),))
    g.check("publish_writes_canonical", canon is not None and 390 < canon < 410,
            f"venues.geofence area = {canon}")
    g.check("publish_marks_draft_published",
            scalar("SELECT status FROM geofence_drafts WHERE draft_id = %s",
                   (str(d_happy),)) == "published")
    g.check("publish_audits",
            scalar("SELECT count(*) FROM admin_audit"
                   " WHERE action = %s AND target_id = %s",
                   ("geofence.draft.publish", str(v2))) == 1)
    g.check("publish_bumps_version",
            scalar("SELECT geofence_version FROM venues WHERE venue_id = %s",
                   (str(v2),)) == 1)
    # A second draft in flight on v2 for the QA open_drafts count.
    mkdraft("venue", v2, f"gate_square({LON}, {LAT} + 0.01, 0, 20)",
            status="in_review")

    # Four-eyes: the publisher must be the recorded reviewer, never the author.
    v4 = scalar("INSERT INTO venues (name) VALUES ('gate-v4') RETURNING venue_id")
    d_wrong = mkdraft("venue", v4, f"gate_square({LON}, {LAT} + 0.02, 0, 20)")
    expect_raise("publish_wrong_reviewer_refused",
                 "publish requires the reviewing second person",
                 "SELECT publish_geofence_draft(%s, %s)", (str(d_wrong), third))
    d_self = mkdraft("venue", v4, f"gate_square({LON}, {LAT} + 0.02, 0, 20)",
                     reviewer_id=author)
    expect_raise("publish_reviewer_is_author_refused",
                 "publish requires the reviewing second person",
                 "SELECT publish_geofence_draft(%s, %s)", (str(d_self), author))
    d_draft = mkdraft("venue", v4, f"gate_square({LON}, {LAT} + 0.02, 0, 20)",
                      status="draft")
    expect_raise("publish_unapproved_refused", "geofence draft is not approved",
                 "SELECT publish_geofence_draft(%s, %s)", (str(d_draft), reviewer))
    expect_raise("publish_unknown_draft_refused", "geofence draft not found",
                 "SELECT publish_geofence_draft(%s, %s)",
                 (str(uuid.uuid4()), reviewer))

    # Density is re-verified inside the publish transaction (TR-41).
    d_dense = mkdraft("venue", v4, f"gate_square({LON}, {LAT} + 0.02, 0, 26)")
    expect_raise("publish_density_failure_refused",
                 "density verification failed: polygon edges must be at most"
                 " 25 m (densify the outline)",
                 "SELECT publish_geofence_draft(%s, %s)", (str(d_dense), reviewer))

    # The overlap gate: v3 owns ground at +0.03; a v4 draft overlapping it by
    # ~50% must not publish (FR-90 attribution ambiguity).
    v3 = scalar("INSERT INTO venues (name, geofence) VALUES ('gate-v3',"
                f" gate_square({LON}, {LAT} + 0.03, 0, 20)) RETURNING venue_id")
    d_overlap = mkdraft("venue", v4, f"gate_square({LON}, {LAT} + 0.03, 10, 20)")
    expect_raise("publish_overlap_refused", "geofence overlaps venue",
                 "SELECT publish_geofence_draft(%s, %s)", (str(d_overlap), reviewer))

    # Floors are exempt from the overlap gate — they nest inside their venue.
    v5 = scalar("INSERT INTO venues (name) VALUES ('gate-v5') RETURNING venue_id")
    q("INSERT INTO venue_floors (venue_id, floor_id) VALUES (%s, 'F1')",
      (str(v5),))
    d_floor = mkdraft("floor", v5, f"gate_square({LON}, {LAT} + 0.03, 10, 20)",
                      floor="F1")
    publish(d_floor, reviewer)
    g.check("publish_floor_overlap_exempt", True)
    g.check("publish_floor_writes_canonical",
            scalar("SELECT ST_Area(geofence) IS NOT NULL AND geofence_version = 1"
                   " FROM venue_floors WHERE venue_id = %s AND floor_id = 'F1'",
                   (str(v5),)) is True)

    # ------------------------------------- phase 6: QA report --------------
    # Legacy estate for the audit: v6 carries a 26 m square (fails today's
    # density gate); v7 overlaps v3 — both inserted directly, as pre-gate
    # data would have been.
    v6 = scalar("INSERT INTO venues (name, geofence) VALUES ('gate-v6',"
                f" gate_square({LON}, {LAT} + 0.04, 0, 26)) RETURNING venue_id")
    v7 = scalar("INSERT INTO venues (name, geofence) VALUES ('gate-v7',"
                f" gate_square({LON}, {LAT} + 0.03, 10, 20)) RETURNING venue_id")

    # Batch-63 NULL-safe gate: a COLD connection that never set app.venue_ops
    # must be refused (current_setting(..., true) reads NULL there).
    cold = psycopg.connect(scratch_url, autocommit=True)
    try:
        cold.execute("SELECT * FROM geofence_qa_report()").fetchall()
        raise AssertionError("check failed: qa_report_cold_refusal —"
                             " expected the venue-ops refusal on a cold connection")
    except AssertionError:
        raise
    except Exception as exc:  # noqa: BLE001 — the needle is the contract
        g.check("qa_report_cold_refusal",
                "geofence QA report requires the venue-ops role" in str(exc),
                f"got: {exc}")
    cold.execute("SELECT set_config('app.venue_ops', 'on', false)")
    rows = {r[0]: r for r in cold.execute(
        "SELECT venue_id::text, has_geofence, density_error,"
        " overlap_conflicts, geofence_version, open_drafts"
        " FROM geofence_qa_report()").fetchall()}
    cold.close()

    row2 = rows.get(str(v2))
    g.check("qa_report_rows_with_role",
            row2 is not None and row2[1] is True and row2[2] is None
            and row2[3] == 0 and row2[4] == 1 and row2[5] == 1,
            f"v2 row = {row2}")
    row6 = rows.get(str(v6))
    g.check("qa_report_flags_legacy_density",
            row6 is not None and row6[2]
            == "polygon edges must be at most 25 m (densify the outline)",
            f"v6 row = {row6}")
    row3, row7 = rows.get(str(v3)), rows.get(str(v7))
    g.check("qa_report_counts_conflicts",
            row3 is not None and row3[3] == 1
            and row7 is not None and row7[3] == 1,
            f"v3 = {row3}, v7 = {row7}")

    conn.close()
    print(f"verify_geogates: {len(g.passed)}/{g.total} checks PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
