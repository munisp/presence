"""Batch 25 — venue registry ops & platform wiring.

BR-14   venue self-serve suspension, effective within one presence TTL
FR-42   venue registry: geospatial cells, partner status, operating schedule
FR-06   display name defaulting to handle + 140-char bio
FR-11   non-sensitive interest floor for discoverability
TECH-06 Centrifugo with the Valkey (Redis) engine
TECH-04 h3-pg alongside PostgreSQL 17 + PostGIS (shipped in b19; reclassify)
NFR-31  X-Request-Id propagated gateway → edge → match and echoed back

SQL invariants are asserted against the migration source; edge/match wiring
against the TypeScript sources; deployment wiring against compose and k8s.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db" / "migrations" / "0020_venue_registry.sql").read_text()
VENUE_TS = (ROOT / "services" / "edge" / "src" / "routes" / "venue.ts").read_text()
PROFILE_TS = (ROOT / "services" / "edge" / "src" / "routes" / "profile.ts").read_text()
PRESENCE_TS = (ROOT / "services" / "edge" / "src" / "routes" / "presence.ts").read_text()
CONTENT_TS = (ROOT / "services" / "edge" / "src" / "routes" / "content.ts").read_text()
ATTRIBUTION_TS = (ROOT / "services" / "edge" / "src" / "attribution.ts").read_text()
SCAN_TS = (ROOT / "services" / "edge" / "src" / "routes" / "scan.ts").read_text()
APP_TS = (ROOT / "services" / "edge" / "src" / "app.ts").read_text()
EDGE_REQID = (ROOT / "services" / "edge" / "src" / "requestid.ts").read_text()
MATCH_SERVER = (ROOT / "services" / "match" / "src" / "server.ts").read_text()
MATCH_STORE = (ROOT / "services" / "match" / "src" / "store.ts").read_text()
MATCH_ENGINE = (ROOT / "services" / "match" / "src" / "engine.ts").read_text()
MATCH_REQID = (ROOT / "services" / "match" / "src" / "requestid.ts").read_text()
COMPOSE = (ROOT / "deploy" / "docker-compose.yml").read_text()
K8S_CENTRIFUGO = (ROOT / "deploy" / "k8s" / "centrifugo.yaml").read_text()
K8S_NETPOL = (ROOT / "deploy" / "k8s" / "networkpolicy.yaml").read_text()
K8S_README = (ROOT / "deploy" / "k8s" / "README.md").read_text()
PG_DOCKERFILE = (ROOT / "deploy" / "postgres" / "Dockerfile").read_text()
SPEC = yaml.safe_load((ROOT / "docs" / "api" / "openapi.yaml").read_text())

PARTNER_STATUSES = ["prospect", "active", "suspended", "offboarded"]


# ------------------------------------------------------------------ FR-42 --


def test_venues_gain_partner_status_with_the_governed_vocabulary():
    m = re.search(r"partner_status\s+text\s+NOT\s+NULL\s+DEFAULT\s+'active'\s*"
                  r"CHECK\s*\(partner_status\s+IN\s*\(([^)]*)\)\)", MIGRATION)
    assert m, "partner_status column with CHECK not found"
    statuses = re.findall(r"'([^']+)'", m.group(1))
    assert sorted(statuses) == sorted(PARTNER_STATUSES)


def test_venues_gain_operating_schedule_and_suspension_timestamp():
    assert "operating_schedule jsonb" in MIGRATION
    assert "suspended_at timestamptz" in MIGRATION


def test_operating_schedule_shape_is_enforced_in_the_data_layer():
    assert "CREATE OR REPLACE FUNCTION operating_schedule_valid" in MIGRATION
    assert "venues_operating_schedule_shape" in MIGRATION
    # days are lowercase ISO abbreviations, times 24-hour HH:MM
    assert re.search(r"day.*?~.*mon\|tue\|wed\|thu\|fri\|sat\|sun", MIGRATION, re.S)
    assert re.search(r"open.*?~.*\^", MIGRATION, re.S)
    assert re.search(r"close.*?~.*\^", MIGRATION, re.S)


def test_active_is_derived_from_partner_status_by_trigger():
    assert "CREATE TRIGGER venues_sync_active" in MIGRATION
    assert "NEW.active := (NEW.partner_status = 'active')" in MIGRATION
    # the suspension timestamp is set on entry and cleared on exit
    assert "NEW.suspended_at := now()" in MIGRATION
    assert "NEW.suspended_at := NULL" in MIGRATION


def test_registry_cells_come_from_the_attribution_projection():
    assert "FROM cell_attribution WHERE venue_id = $1" in VENUE_TS


# ------------------------------------------------------------------ BR-14 --


def test_governed_registry_mutations_are_security_definer_and_audited():
    for fn in ("venue_suspend", "venue_resume", "venue_offboard", "venue_set_schedule"):
        assert re.search(
            rf"CREATE OR REPLACE FUNCTION {fn}\(.*?\)\s*RETURNS jsonb\s*"
            rf"LANGUAGE plpgsql SECURITY DEFINER",
            MIGRATION,
            re.S,
        ), fn
        assert f"REVOKE ALL ON FUNCTION {fn}" in MIGRATION
        assert f"GRANT EXECUTE ON FUNCTION {fn}" in MIGRATION
    # every mutation writes its own admin_audit row (FR-60)
    for action in ("venue.suspend", "venue.resume", "venue.offboard", "venue.schedule"):
        assert action in MIGRATION


def test_suspend_and_offboard_purge_the_venues_live_presence():
    for route in ("/v1/venues/:venueId/suspend", "/v1/venues/:venueId/offboard"):
        assert f'"{route}"' in VENUE_TS
    assert VENUE_TS.count("purgeVenuePresence(ctx, venueId)") == 2
    assert 'writes.del(`presence:venue:${venueId}`)' in VENUE_TS
    # KEEPTTL + XX: remaining TTL preserved, no resurrection of expired keys
    assert '"KEEPTTL", "XX"' in VENUE_TS


def test_self_serve_routes_require_the_venue_claim_but_not_workforce_roles():
    assert VENUE_TS.count("venueClaimOk(req, venueId)") >= 4  # dashboard + 4 partner ops
    # offboard is console-only; suspend/resume/schedule are self-serve
    assert "preHandler: requireVenueOps" in VENUE_TS
    assert '"/v1/venues/:venueId/offboard"' in VENUE_TS


def test_suspended_venues_stop_serving_and_attributing():
    # presence publish refuses explicit claims to inactive venues
    assert "venue is not operating (BR-14)" in PRESENCE_TS
    assert "SELECT active FROM venues WHERE venue_id = $1" in PRESENCE_TS
    # polygon attribution skips inactive venues
    assert "AND v.active" in ATTRIBUTION_TS
    # offers and announcements of a suspended venue stop being served
    assert "JOIN venues v ON v.venue_id = o.venue_id AND v.active" in CONTENT_TS
    assert "AND (a.venue_id IS NULL OR (a.venue_id = $1 AND v.active))" in CONTENT_TS


# ------------------------------------------------------------------ FR-06 --


def test_identity_gains_display_name_and_bounded_bio():
    assert re.search(r"ADD COLUMN display_name text CHECK \(display_name IS NULL OR "
                     r"char_length\(display_name\) <= 80\)", MIGRATION)
    assert "ADD COLUMN bio varchar(140)" in MIGRATION


def test_display_handle_defaults_to_handle_and_still_masks_suspensions():
    assert "COALESCE(i.display_name, i.handle)" in MIGRATION
    assert "dimension = 'handle'" in MIGRATION  # FR-55 masking preserved


def test_dsar_export_carries_the_new_identity_fields():
    assert "'displayName', COALESCE(i.display_name, i.handle)" in MIGRATION
    assert "'bio', i.bio" in MIGRATION


def test_identity_routes_enforce_set_once_handle_and_screening():
    assert '"/v1/profile/identity"' in PROFILE_TS
    assert "handle is set-once (FR-06)" in PROFILE_TS
    assert "handle is required on first write (FR-06)" in PROFILE_TS
    assert PROFILE_TS.count("screenText") >= 2  # prompts + identity
    # 140-char bio bound is in the route schema too (defence in depth)
    assert re.search(r"bio:\s*\{\s*type:\s*\[\"string\", \"null\"\], maxLength: 140 \}", PROFILE_TS)
    # the wire defaults the display name to the handle
    assert PROFILE_TS.count('COALESCE(display_name, handle) AS "displayName"') >= 2


# ------------------------------------------------------------------ FR-11 --


def test_match_floor_counts_only_non_sensitive_interests():
    assert "export function nonSensitiveCount" in MATCH_ENGINE
    # all three gates (scan candidates, corpus, prior) use the floor
    assert "nonSensitiveCount(profile, store.getGraph()) < 2" in MATCH_SERVER
    assert "nonSensitiveCount(profile, this.getGraph()) >= 2" in MATCH_STORE
    assert "nonSensitiveCount(profile, this.getGraph()) < 2" in MATCH_STORE
    # stale nodes are skipped, never thrown
    assert "graph.has(nid)" in MATCH_ENGINE
    # the raw key-count gate is gone from all three sites
    assert "Object.keys(profile).length" not in MATCH_SERVER
    assert "Object.keys(profile).length" not in MATCH_STORE


def test_interests_read_explains_the_floor_to_the_editor():
    assert "discoverabilityNote" in PROFILE_TS
    assert "fewer than two non-sensitive" in PROFILE_TS
    assert "discoverable" in PROFILE_TS


# ----------------------------------------------------------------- TECH-06 --


def test_centrifugo_uses_the_valkey_engine_in_compose_and_k8s():
    for src in (COMPOSE, K8S_CENTRIFUGO):
        assert "CENTRIFUGO_ENGINE_TYPE" in src
        # compose writes KEY: value on one line; k8s env uses name/value pairs
        m = re.search(r"CENTRIFUGO_ENGINE_TYPE[^\n]*(?:\n[^\n]*)?", src)
        assert m and "redis" in m.group(0)
        assert "CENTRIFUGO_ENGINE_REDIS_ADDRESS" in src
        assert "redis://valkey:6379" in src


def test_network_policy_lets_centrifugo_reach_valkey():
    assert "centrifugo-egress-allowlist" in K8S_NETPOL
    # valkey ingress admits centrifugo pods
    m = re.search(r"name: valkey-from-workloads(.*?)---", K8S_NETPOL, re.S)
    assert m and "app: centrifugo" in m.group(1)


# ----------------------------------------------------------------- TECH-04 --


def test_postgres_image_bundles_postgis17_pgvector_and_h3():
    assert "postgis/postgis:17-" in PG_DOCKERFILE
    assert "pgvector" in PG_DOCKERFILE
    assert re.search(r"h3-pg|h3_postgis", PG_DOCKERFILE)


# ------------------------------------------------------------------ NFR-31 --


def test_edge_honors_the_gateways_request_id_and_echoes_it_back():
    assert "genReqId" in APP_TS
    assert 'resolveRequestId(req.headers["x-request-id"])' in APP_TS
    assert 'reply.header("x-request-id", req.id)' in APP_TS
    # the charset guard lives in the shared helper
    assert "^[\\x21-\\x7e]{1,128}$" in EDGE_REQID


def test_scan_path_propagates_the_trace_id_to_match():
    assert '"x-request-id": req.id' in SCAN_TS
    assert "genReqId" in MATCH_SERVER
    assert 'resolveRequestId(req.headers["x-request-id"])' in MATCH_SERVER
    assert 'reply.header("x-request-id", req.id)' in MATCH_SERVER
    assert "^[\\x21-\\x7e]{1,128}$" in MATCH_REQID


# ----------------------------------------------------------------- OpenAPI --


def _path(path: str) -> dict:
    assert path in SPEC["paths"], f"{path} missing from openapi.yaml"
    return SPEC["paths"][path]


def test_openapi_documents_the_venue_registry_surface():
    assert "get" in _path("/v1/venues/{venueId}/registry")
    assert "put" in _path("/v1/venues/{venueId}/schedule")
    assert "post" in _path("/v1/venues/{venueId}/suspend")
    assert "post" in _path("/v1/venues/{venueId}/resume")
    assert "post" in _path("/v1/venues/{venueId}/offboard")
    reg = _path("/v1/venues/{venueId}/registry")["get"]["responses"]["200"]["content"][
        "application/json"]["schema"]["properties"]
    assert reg["partnerStatus"]["enum"] == PARTNER_STATUSES
    assert "operatingSchedule" in reg and "cells" in reg


def test_openapi_documents_profile_identity_and_the_fr11_note():
    ident = _path("/v1/profile/identity")
    assert "put" in ident and "get" in ident
    props = ident["put"]["requestBody"]["content"]["application/json"]["schema"]["properties"]
    assert props["bio"]["maxLength"] == 140
    assert props["displayName"]["maxLength"] == 80
    interests = _path("/v1/profile/interests")["get"]["responses"]["200"]["content"][
        "application/json"]["schema"]["properties"]
    assert "discoverable" in interests and "discoverabilityNote" in interests


# ------------------------------------------------------------- deployment --


def test_migration_is_mounted_in_compose_and_k8s():
    assert "0020_venue_registry.sql:/docker-entrypoint-initdb.d/22_venue_registry.sql" in COMPOSE
    assert "22_venue_registry.sql=db/migrations/0020_venue_registry.sql" in K8S_README
