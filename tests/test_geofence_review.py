#!/usr/bin/env python3
"""TR-41 acceptance criteria: geofence authoring + second-person review +
density verification (GeoLibre console workflow).

Pins: the draft state machine with its targeting rules (venue vs floor,
composite FK), the density gate in SQL (valid, >=4 vertices, area band,
no edge longer than 25 m via the ST_Segmentize point-count identity), the
publish function as the only path to live geometry (re-verifies the second
person and the gate in one transaction, writes the canonical record,
audits), the venue-ops GUC + RLS, the edge mirror with the same constants,
the four-eyes review transitions, the console auth pattern, and the
deploy wiring.

Behavioural coverage of the TS mirror lives in
services/edge/test/geofence.test.ts; route/contract coverage is enforced
globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_geofence_review.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0017_geofence_review.sql").read_text()
LIB = (ROOT / "services/edge/src/geofence.ts").read_text()
ROUTE = (ROOT / "services/edge/src/routes/geofence.ts").read_text()
AUTH = (ROOT / "services/edge/src/auth.ts").read_text()
APP = (ROOT / "services/edge/src/app.ts").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
REALM = (ROOT / "deploy/keycloak/realm-workforce.json").read_text()


def sql(text: str) -> str:
    """Migration text with line comments stripped."""
    return re.sub(r"--[^\n]*", "", text)


# ------------------------------------------------------------- drafts ------

def test_tr41_draft_state_machine() -> None:
    m = sql(MIGRATION)
    assert re.search(r"CREATE TABLE geofence_drafts \(", m)
    assert re.search(
        r"CHECK \(status IN \('draft', 'in_review', 'approved', 'published', 'rejected'\)\)", m
    )


def test_tr41_targeting_rules() -> None:
    m = sql(MIGRATION)
    assert re.search(r"target_type text NOT NULL CHECK \(target_type IN \('venue', 'floor'\)\)", m)
    # Floor drafts target a floor row via the composite key; venue drafts
    # carry no floor id.
    assert "FOREIGN KEY (venue_id, floor_id) REFERENCES venue_floors (venue_id, floor_id)" in m
    assert "CHECK (target_type = 'venue' OR floor_id IS NOT NULL)" in m
    assert "CHECK (target_type = 'floor' OR floor_id IS NULL)" in m
    # Polygon is canonical PostGIS geography (TR-42/ADR-0008).
    assert re.search(r"polygon\s+geography\(Polygon, 4326\) NOT NULL", m)


def test_tr41_author_and_reviewer_are_workforce_subjects() -> None:
    m = sql(MIGRATION)
    assert re.search(r"author\s+uuid NOT NULL", m)
    assert re.search(r"reviewer\s+uuid,", m)
    # No FK to users — the workforce lives in the IdP (taxonomy precedent).
    assert not re.search(r"author\s+uuid NOT NULL REFERENCES", m)


# ---------------------------------------------------------- density gate ---

def test_tr41_density_gate_sql() -> None:
    m = sql(MIGRATION)
    fn = m.split("CREATE OR REPLACE FUNCTION geofence_density_check", 1)[1]
    fn = fn.split("END $$;", 1)[0]
    assert "ST_IsValid" in fn
    assert "ST_NPoints(p::geometry)" in fn
    assert "n_points < 4" in fn
    assert "area_m2 < 10 OR area_m2 > 1000000" in fn
    # The 25 m rule is the segmentize identity: a dense polygon gains no
    # points when resegmentized at 25 m.
    assert "ST_NPoints(ST_Segmentize(p, 25)::geometry)" in fn
    assert "IF n_dense <> n_points THEN" in fn


def test_tr41_density_gate_ts_mirror_same_constants() -> None:
    assert "GEOFENCE_MIN_VERTICES = 4" in LIB
    assert "GEOFENCE_MIN_AREA_M2 = 10" in LIB
    assert "GEOFENCE_MAX_AREA_M2 = 1_000_000" in LIB
    assert "GEOFENCE_MAX_SEGMENT_M = 25" in LIB
    assert "len > GEOFENCE_MAX_SEGMENT_M" in LIB


# ------------------------------------------------------------- publish -----

def test_tr41_publish_is_the_only_write_path() -> None:
    m = sql(MIGRATION)
    fn = m.split("CREATE OR REPLACE FUNCTION publish_geofence_draft", 1)[1]
    # FOR UPDATE row lock, state check, four-eyes, gate, write, audit.
    assert "FOR UPDATE" in fn
    assert "IF d.status <> 'approved' THEN" in fn
    assert "IF d.reviewer IS DISTINCT FROM p_reviewer OR d.reviewer = d.author THEN" in fn
    assert "v_density := geofence_density_check(d.polygon)" in fn
    assert "UPDATE venues SET geofence = d.polygon" in fn
    assert "UPDATE venue_floors SET geofence = d.polygon" in fn
    assert "'geofence.draft.publish'" in fn
    # …and the function is locked down to the app role.
    assert "REVOKE ALL ON FUNCTION publish_geofence_draft(uuid, uuid) FROM PUBLIC" in m
    assert "GRANT EXECUTE ON FUNCTION publish_geofence_draft(uuid, uuid) TO presence_app" in m


def test_tr41_no_direct_geofence_grant_to_app_role() -> None:
    """venues.geofence and venue_floors.geofence change only via publish."""
    for migration in (ROOT / "db/migrations").glob("*.sql"):
        text = re.sub(r"--[^\n]*", "", migration.read_text())
        grants = re.findall(r"GRANT[^;]*", text)
        for grant in grants:
            if re.search(r"\bUPDATE\b", grant) and re.search(r"\bvenues\b", grant):
                assert "geofence" not in grant, f"{migration.name}: {grant}"
            if "venue_floors" in grant:
                assert "UPDATE" not in grant, f"{migration.name}: {grant}"


# ----------------------------------------------------------- console -------
def test_tr41_venue_ops_guc_and_rls() -> None:
    m = sql(MIGRATION)
    assert "current_setting('app.venue_ops', true) = 'on'" in m
    assert "ALTER TABLE geofence_drafts ENABLE ROW LEVEL SECURITY" in m
    assert re.search(
        r"CREATE POLICY geofence_drafts_console ON geofence_drafts\s+"
        r"FOR ALL USING \(app_venue_ops\(\)\) WITH CHECK \(app_venue_ops\(\)\)",
        m,
    )


def test_tr41_console_auth_pattern() -> None:
    assert 'await requireWorkforceRole(req, reply, "venue-ops")' in AUTH
    assert 'withGuc(pool, "app.venue_ops", fn)' in AUTH
    assert '"venue-ops"' in REALM
    # Every route is gated.
    assert ROUTE.count("preHandler: requireVenueOps") == 6
    # Every DB touch runs under the GUC.
    assert ROUTE.count("withVenueOps(ctx.pg") == 6


def test_tr41_four_eyes_in_the_edge_transitions() -> None:
    approve = ROUTE.split('"/v1/ops/geofences/:draftId/approve"', 1)[1]
    approve = approve.split("app.post", 1)[0]
    assert "status = 'in_review' AND author <> $2" in approve
    assert "reviewer = $2, reviewed_at = now()" in approve
    submit = ROUTE.split('"/v1/ops/geofences/:draftId/submit"', 1)[1]
    submit = submit.split("app.post", 1)[0]
    assert "status = 'draft' AND author = $2" in submit


def test_tr41_routes_registered_and_mounted() -> None:
    assert 'import { registerGeofenceRoutes } from "./routes/geofence.js";' in APP
    assert "registerGeofenceRoutes(authed, ctx);" in APP
    assert (
        "../db/migrations/0017_geofence_review.sql:/docker-entrypoint-initdb.d/19_geofence_review.sql:ro"
        in COMPOSE
    )


def test_tr41_adr_0008_records_geolibre_as_editor() -> None:
    adr = re.sub(r"\s+", " ", (ROOT / "docs/adr/0008-maplibre-geolibre-postgis.md").read_text())
    assert "GeoLibre as the polygon editor" in adr
    assert "geofences are editable by venue staff" in adr
