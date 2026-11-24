"""Batch 33 — TECH-24 GeoLibre QA workflow.

TR-41 (batch 22) built the authoring half of the GeoLibre stack: drafts,
four-eyes review, density verification, one DB-final publish path. These
invariants pin the QA half: the overlap guard that stops two venues
claiming the same ground (attribution ambiguity, FR-90), its enforcement
inside the publish definer, the post-publish estate audit, the console
routes, and the deploy wiring — cross-layer, so a drift in any one layer
fails CI.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

MIGRATION_0023 = (ROOT / "db" / "migrations" / "0023_geofence_qa.sql").read_text()
MIGRATION_0017 = (ROOT / "db" / "migrations" / "0017_geofence_review.sql").read_text()
ROUTES_TS = (ROOT / "services" / "edge" / "src" / "routes" / "geofence.ts").read_text()
COMPOSE = (ROOT / "deploy" / "docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy" / "k8s" / "README.md").read_text()
QA_MD = (ROOT / "docs" / "ops" / "geofence-qa.md").read_text()
VALIDATE_DEPLOY = (ROOT / "scripts" / "validate_deploy.py").read_text()
OPENAPI = yaml.safe_load((ROOT / "docs" / "api" / "openapi.yaml").read_text())


def sql(text: str) -> str:
    """Migration text with line comments stripped."""
    return re.sub(r"--[^\n]*", "", text)


# ------------------------------------------------------------- migration ---

def test_migration_0023_shape() -> None:
    assert "BEGIN;" in MIGRATION_0023 and "COMMIT;" in MIGRATION_0023
    assert "DROP " not in MIGRATION_0023, "forward-only (INF-17 rehearsal lint)"
    for fn in ("geofence_overlap_check", "publish_geofence_draft", "geofence_qa_report"):
        assert f"CREATE OR REPLACE FUNCTION {fn}(" in MIGRATION_0023
    assert "REVOKE ALL ON FUNCTION geofence_overlap_check(geography, uuid) FROM PUBLIC" in MIGRATION_0023
    assert "GRANT EXECUTE ON FUNCTION geofence_overlap_check(geography, uuid) TO presence_app" in MIGRATION_0023
    assert "REVOKE ALL ON FUNCTION geofence_qa_report() FROM PUBLIC" in MIGRATION_0023
    assert "GRANT EXECUTE ON FUNCTION geofence_qa_report() TO presence_app" in MIGRATION_0023


def test_overlap_check_semantics() -> None:
    m = sql(MIGRATION_0023)
    fn = m.split("CREATE OR REPLACE FUNCTION geofence_overlap_check", 1)[1]
    fn = fn.split("$$", 2)[1]
    # Candidate vs every OTHER venue's live polygon only.
    assert "v.venue_id <> p_venue_id" in fn
    assert "v.geofence IS NOT NULL" in fn
    assert "ST_Intersects(v.geofence, p_polygon)" in fn
    # The 10 m² tolerance: below it is survey noise / a shared property line.
    assert "ST_Area(ST_Intersection(v.geofence, p_polygon)) > 10" in fn


def test_publish_reverified_with_the_overlap_gate() -> None:
    m = sql(MIGRATION_0023)
    fn = m.split("CREATE OR REPLACE FUNCTION publish_geofence_draft", 1)[1]
    fn = fn.split("END $$;", 1)[0]
    # The 0017 contract is preserved in the re-creation…
    assert "FOR UPDATE" in fn
    assert "IF d.status <> 'approved' THEN" in fn
    assert "IF d.reviewer IS DISTINCT FROM p_reviewer OR d.reviewer = d.author THEN" in fn
    assert "v_density := geofence_density_check(d.polygon)" in fn
    assert "UPDATE venues SET geofence = d.polygon" in fn
    assert "UPDATE venue_floors SET geofence = d.polygon" in fn
    assert "'geofence.draft.publish'" in fn
    # …plus the overlap gate, venue targets only (floors nest legitimately).
    assert "IF d.target_type = 'venue' THEN" in fn
    assert "geofence_overlap_check(d.polygon, d.venue_id)" in fn
    assert "geofence overlaps venue" in fn
    # …and the gate runs before any canonical write.
    assert fn.index("geofence_overlap_check(d.polygon, d.venue_id)") < fn.index(
        "UPDATE venues SET geofence"
    )


def test_qa_report_shape_and_gate() -> None:
    m = sql(MIGRATION_0023)
    fn = m.split("CREATE OR REPLACE FUNCTION geofence_qa_report", 1)[1]
    fn = fn.split("END $$;", 1)[0]
    # Definer reading across venues, gated on the console GUC.
    assert "SECURITY DEFINER" in fn
    assert "IF NOT app_venue_ops() THEN" in fn
    # The audit columns: coverage, density re-verification, overlap count,
    # geometry version (FR-90), drafts in flight.
    assert "v.geofence IS NOT NULL" in fn
    assert "geofence_density_check(v.geofence)" in fn
    assert "geofence_overlap_check(v.geofence, v.venue_id)" in fn
    assert "v.geofence_version" in fn
    assert "d.status IN ('draft', 'in_review', 'approved')" in fn


def test_migration_0017_untouched() -> None:
    # The original authoring migration stays byte-stable; 0023 re-creates
    # the publish function forward-only.
    assert "CREATE OR REPLACE FUNCTION publish_geofence_draft" in MIGRATION_0017
    assert "geofence_overlap_check" not in MIGRATION_0017


# ---------------------------------------------------------------- routes ---

def test_overlap_check_route() -> None:
    route = ROUTES_TS.split('"/v1/ops/geofences/overlap-check"', 1)[1]
    route = route.split("app.get", 1)[0]
    assert "preHandler: requireVenueOps" in route
    assert "withVenueOps(ctx.pg" in route
    # Parse first (422 on a bad polygon) — the DB authority runs second.
    assert "parseGeofencePolygon" in route
    assert 'reply.code(422)' in route
    assert "geofence_overlap_check(ST_GeomFromGeoJSON($1)::geography, $2)" in route
    assert route.index("parseGeofencePolygon") < route.index("geofence_overlap_check")


def test_qa_route() -> None:
    route = ROUTES_TS.split('"/v1/ops/geofences/qa"', 1)[1]
    assert "preHandler: requireVenueOps" in route
    assert "withVenueOps(ctx.pg" in route
    assert "FROM geofence_qa_report()" in route
    for field in ("hasGeofence", "densityError", "overlapConflicts", "geofenceVersion", "openDrafts"):
        assert field in route


def test_all_eight_geofence_routes_gated() -> None:
    assert ROUTES_TS.count("preHandler: requireVenueOps") == 8
    assert ROUTES_TS.count("withVenueOps(ctx.pg") == 8


# --------------------------------------------------------------- openapi ---

def test_openapi_documents_the_qa_operations() -> None:
    paths = OPENAPI["paths"]
    overlap = paths["/v1/ops/geofences/overlap-check"]["post"]
    qa = paths["/v1/ops/geofences/qa"]["get"]
    assert "TECH-24" in overlap["summary"]
    assert "TECH-24" in qa["summary"]
    # Read-only probe, but the contract pins Idempotency-Key on every POST.
    assert any(
        p.get("$ref", "").endswith("/IdempotencyKey") for p in overlap["parameters"]
    )
    body = overlap["requestBody"]["content"]["application/json"]["schema"]
    assert body["required"] == ["venueId", "polygon"]
    assert body["additionalProperties"] is False
    # The publish op documents the new gate.
    publish = paths["/v1/ops/geofences/{draftId}/publish"]["post"]
    assert "overlap" in publish["description"]


# ---------------------------------------------------------------- deploy ---

def test_migration_mounted_everywhere() -> None:
    assert (
        "../db/migrations/0023_geofence_qa.sql:/docker-entrypoint-initdb.d/25_geofence_qa.sql:ro"
        in COMPOSE
    )
    assert "25_geofence_qa.sql=db/migrations/0023_geofence_qa.sql" in K8S_README


def test_qa_runbook_documents_the_workflow() -> None:
    for needle in (
        "overlap-check",
        "geofence overlaps venue",
        "10 m²",
        "geofence_qa_report",
        "geofenceVersion",
        "only write path",
    ):
        assert needle in QA_MD


def test_validate_deploy_covers_batch33() -> None:
    assert "0023_geofence_qa.sql" in VALIDATE_DEPLOY
    assert "geofence_overlap_check" in VALIDATE_DEPLOY
    assert "geofence_qa_report" in VALIDATE_DEPLOY
    proc = subprocess.run(
        [sys.executable, "scripts/validate_deploy.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    # Name-based pins: later batches keep adding checks, so assert this
    # batch's checks run and pass rather than a global count.
    for name in (
        "TECH-24 geofence QA migration exists",
        "TECH-24 overlap gate is DB-final",
    ):
        assert any(ln.startswith("PASS") and name in ln for ln in proc.stdout.splitlines()), name
