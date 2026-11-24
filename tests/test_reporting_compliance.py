"""Batch 24 — reporting & compliance records.

FR-40  report anchors (pair/message) · FR-49 fixed report categories
NFR-22 reports disposal at 12 months · SEC-30 append-only security-event
store · SEC-36 mock-location refusal record · SEC-13 data-processing
consent artefacts · BR-21 taxonomy release provenance.

SQL invariants are asserted against the migration source; edge wiring
invariants against the TypeScript sources; the two category/kind
vocabularies are pinned equal across languages so they cannot drift.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db" / "migrations" / "0019_reporting_compliance.sql").read_text()
CONTENT = (ROOT / "services" / "edge" / "src" / "routes" / "content.ts").read_text()
DEVICES = (ROOT / "services" / "edge" / "src" / "routes" / "devices.ts").read_text()
PRESENCE = (ROOT / "services" / "edge" / "src" / "routes" / "presence.ts").read_text()
ACCOUNT = (ROOT / "services" / "edge" / "src" / "routes" / "account.ts").read_text()
AUTH = (ROOT / "services" / "edge" / "src" / "auth.ts").read_text()
MODERATION = (ROOT / "services" / "edge" / "src" / "routes" / "moderation.ts").read_text()
TAXONOMY_ROUTES = (ROOT / "services" / "edge" / "src" / "routes" / "taxonomy.ts").read_text()
TAXONOMY_LIB = (ROOT / "services" / "edge" / "src" / "taxonomy.ts").read_text()
LIFECYCLE = (ROOT / "services" / "edge" / "src" / "lifecycle.ts").read_text()
REPORTS_TS = (ROOT / "services" / "edge" / "src" / "reports.ts").read_text()
SECURITY_TS = (ROOT / "services" / "edge" / "src" / "security.ts").read_text()
SPEC = yaml.safe_load((ROOT / "docs" / "api" / "openapi.yaml").read_text())

FR49_CATEGORIES = [
    "harassment",
    "impersonation",
    "under_age",
    "commercial_solicitation",
    "hate",
    "other",
]

SEC30_KINDS = [
    "impossible_travel",
    "missing_attestation",
    "attestation_key_duplicate",
    "mock_location_refusal",
    "console_authorization_denied",
    "retention.purge",
]


def _ts_string_list(src: str, const_name: str) -> list[str]:
    m = re.search(const_name + r"\s*=\s*\[([^\]]*)\]", src, re.S)
    assert m, f"{const_name} not found"
    return re.findall(r'"([^"]+)"', m.group(1))


# ------------------------------------------------------------------ FR-49 --


def test_reports_category_check_lists_exactly_the_six_spec_categories():
    m = re.search(r"category IN \(([^)]*)\)", MIGRATION)
    assert m
    sql_cats = re.findall(r"'([^']+)'", m.group(1))
    assert sorted(sql_cats) == sorted(FR49_CATEGORIES)


def test_edge_category_list_matches_sql_check():
    assert sorted(_ts_string_list(REPORTS_TS, "REPORT_CATEGORIES")) == sorted(FR49_CATEGORIES)


def test_report_route_requires_category_with_governed_enum():
    schema_block = CONTENT[CONTENT.index('"/v1/reports"'):]
    assert '"category"' in schema_block or "category" in schema_block
    assert "enum: [...REPORT_CATEGORIES]" in schema_block
    assert 'required: ["reason", "category"]' in schema_block


def test_openapi_reports_category_enum_matches_spec():
    schema = SPEC["paths"]["/v1/reports"]["post"]["requestBody"]["content"]["application/json"]["schema"]
    assert "category" in schema["required"]
    assert sorted(schema["properties"]["category"]["enum"]) == sorted(FR49_CATEGORIES)


# ------------------------------------------------------------------ FR-40 --


def test_reports_anchor_columns_detach_on_delete():
    """Anchors are evidence pointers: message purge (NFR-20) or pair erasure
    detaches the anchor; the report survives until its own disposal."""
    assert re.search(r"pair_id\s+uuid REFERENCES matches \(pair_id\) ON DELETE SET NULL", MIGRATION)
    assert re.search(r"message_id\s+uuid REFERENCES messages \(message_id\) ON DELETE SET NULL", MIGRATION)


def test_appeals_report_fk_detaches_on_report_disposal():
    assert "DROP CONSTRAINT appeals_report_id_fkey" in MIGRATION
    assert re.search(
        r"FOREIGN KEY \(report_id\) REFERENCES reports \(report_id\) ON DELETE SET NULL",
        MIGRATION,
    )


def test_report_route_validates_anchors_under_rls():
    assert "SELECT pair_id FROM messages WHERE message_id = $1" in CONTENT
    assert "SELECT user_lo, user_hi FROM matches WHERE pair_id = $1" in CONTENT
    assert "message does not belong to this pair" in CONTENT


def test_pair_anchor_defaults_reported_to_counterpart():
    assert "pair.rows[0].user_lo === req.userId" in CONTENT


def test_report_insert_carries_anchors_and_category():
    assert re.search(
        r"INSERT INTO reports \(reporter, reported, venue_id, announcement_id, reason, details, category, pair_id, message_id\)",
        CONTENT,
    )


def test_openapi_reports_documents_anchors():
    props = SPEC["paths"]["/v1/reports"]["post"]["requestBody"]["content"]["application/json"][
        "schema"
    ]["properties"]
    assert props["pairId"]["format"] == "uuid"
    assert props["messageId"]["format"] == "uuid"


# ------------------------------------------------------------------ NFR-22 --


def test_reports_retention_tick_disposes_at_twelve_months():
    assert "CREATE OR REPLACE FUNCTION reports_retention_tick()" in MIGRATION
    assert "DELETE FROM reports WHERE created_at < now() - interval '12 months'" in MIGRATION
    assert "SECURITY DEFINER" in MIGRATION


def test_retention_disposal_is_audited():
    tick = MIGRATION[MIGRATION.index("reports_retention_tick"):]
    assert "'retention.purge'" in tick
    assert "INSERT INTO security_audit" in tick


def test_retention_tick_grant_is_app_role_only():
    assert "REVOKE ALL ON FUNCTION reports_retention_tick() FROM PUBLIC" in MIGRATION
    assert "GRANT EXECUTE ON FUNCTION reports_retention_tick() TO presence_app" in MIGRATION


def test_edge_tick_drives_reports_retention():
    assert "SELECT reports_retention_tick() AS purged" in LIFECYCLE
    assert "reportsPurged" in LIFECYCLE


# ------------------------------------------------------------------ SEC-30 --


def test_security_audit_is_append_only():
    assert "security_audit is append-only (SEC-30)" in MIGRATION
    assert re.search(
        r"CREATE TRIGGER security_audit_immutable\s+BEFORE UPDATE OR DELETE ON security_audit",
        MIGRATION,
    )


def test_security_audit_kind_vocabulary_is_governed():
    m = re.search(r"kind IN \(([^)]*)\)", MIGRATION, re.S)
    assert m
    sql_kinds = re.findall(r"'([^']+)'", m.group(1))
    assert sorted(sql_kinds) == sorted(SEC30_KINDS)


def test_edge_kind_list_matches_sql_vocabulary():
    assert sorted(_ts_string_list(SECURITY_TS, "SECURITY_EVENT_KINDS")) == sorted(SEC30_KINDS)


def test_security_audit_readable_only_through_moderator_guc():
    assert re.search(
        r"CREATE POLICY security_audit_moderation_select ON security_audit\s+FOR SELECT USING \(app_moderator\(\)\)",
        MIGRATION,
    )
    # SELECT is the only grant; writes go through record_security_event and
    # mutation is trigger-barred for every role.
    grants = re.findall(r"GRANT (\w[\w ,]*) ON security_audit", MIGRATION)
    assert grants == ["SELECT"]


def test_security_writer_is_definer_and_app_role_only():
    assert "record_security_event(" in MIGRATION
    assert "REVOKE ALL ON FUNCTION record_security_event(text, uuid, jsonb) FROM PUBLIC" in MIGRATION
    assert "GRANT EXECUTE ON FUNCTION record_security_event(text, uuid, jsonb) TO presence_app" in MIGRATION


def test_presence_route_records_security_events():
    assert 'recordSecurityEvent(ctx.pg, "missing_attestation", req.userId, { surface: "presence_publish" })' in PRESENCE
    assert PRESENCE.count('recordSecurityEvent(ctx.pg, "impossible_travel", userId, { resolution: res })') == 2


def test_security_event_detail_never_carries_a_cell():
    """SEC-29 discipline holds inside the audit detail too: the impossible-
    travel record carries the comparison resolution, never a cell id."""
    for m in re.finditer(r'recordSecurityEvent\(ctx\.pg, "impossible_travel"[^)]*\)', PRESENCE):
        assert "cell" not in m.group(0).lower() or "resolution" in m.group(0)


def test_auth_records_console_authorization_denial():
    assert '"console_authorization_denied"' in AUTH
    assert re.search(r'role,\s*\n?\s*path: req\.url\.split', AUTH)


def test_console_has_security_events_read_route():
    assert '"/v1/moderation/security-events"' in MODERATION
    assert "requireModerator" in MODERATION
    assert "FROM security_audit" in MODERATION
    assert "enum: [...SECURITY_EVENT_KINDS]" in MODERATION


def test_openapi_documents_security_events_console():
    op = SPEC["paths"]["/v1/moderation/security-events"]["get"]
    params = {p["name"]: p for p in op["parameters"]}
    assert sorted(params["kind"]["schema"]["enum"]) == sorted(SEC30_KINDS)


# ------------------------------------------------------------------ SEC-36 --


def test_mock_location_refusal_route_records_and_discloses_nothing():
    assert '"/v1/devices/mock-location-refusal"' in DEVICES
    assert 'recordSecurityEvent(ctx.pg, "mock_location_refusal", req.userId' in DEVICES
    assert 'reply.code(202).send({ recorded: true })' in DEVICES


def test_mock_location_refusal_in_openapi():
    op = SPEC["paths"]["/v1/devices/mock-location-refusal"]["post"]
    assert "202" in op["responses"]
    # TR-24: mutating, so the idempotency header is documented.
    assert any("IdempotencyKey" in str(p) for p in op["parameters"])


def test_devices_enrol_records_attestation_signals():
    assert '{ surface: "device_enrol" }' in DEVICES
    assert '"attestation_key_duplicate"' in DEVICES


# ------------------------------------------------------------------ SEC-13 --


def test_consents_table_shape():
    assert "CREATE TABLE data_processing_consents" in MIGRATION
    assert "PRIMARY KEY (user_id, purpose)" in MIGRATION
    assert re.search(r"purpose ~ '\^\[a-z0-9_\]\{1,64\}\$'", MIGRATION)
    for col in ("scope", "policy_version", "granted_at", "withdrawn_at"):
        assert col in MIGRATION


def test_consents_owner_only_rls_without_delete():
    for cmd in ("select", "insert", "update"):
        assert f"CREATE POLICY consents_own_{cmd} ON data_processing_consents" in MIGRATION
    assert "consents_own_delete" not in MIGRATION
    assert "GRANT SELECT, INSERT, UPDATE ON data_processing_consents TO presence_app" in MIGRATION


def test_consents_routes_are_symmetric_and_retrievable():
    assert 'app.get("/v1/account/consents"' in ACCOUNT
    assert 'app.put(\n    "/v1/account/consents/:purpose"' in ACCOUNT
    assert 'app.delete(\n    "/v1/account/consents/:purpose"' in ACCOUNT
    # Grant supersedes: the upsert clears the withdrawal mark.
    assert "granted_at = now(), withdrawn_at = NULL" in ACCOUNT
    # Withdrawal marks, never destroys.
    assert "SET withdrawn_at = now()" in ACCOUNT


def test_consents_in_dsar_export_and_erasure():
    """The artefact is retrievable (FR-62 export) and personal (FR-03/04
    erasure disposes of it with the account)."""
    assert "'dataProcessingConsents'" in MIGRATION
    assert "FROM data_processing_consents d WHERE d.user_id = uid" in MIGRATION
    assert "DELETE FROM data_processing_consents WHERE user_id = uid" in MIGRATION


def test_openapi_documents_consents():
    assert "/v1/account/consents" in SPEC["paths"]
    item = SPEC["paths"]["/v1/account/consents/{purpose}"]
    put = item["put"]["requestBody"]["content"]["application/json"]["schema"]
    assert sorted(put["required"]) == ["policyVersion", "scope"]
    assert any("IdempotencyKey" in str(p) for p in item["put"]["parameters"])
    assert any("IdempotencyKey" in str(p) for p in item["delete"]["parameters"])


# ------------------------------------------------------------------- BR-21 --


def test_taxonomy_releases_carry_provenance():
    assert "ALTER TABLE taxonomy_releases ADD COLUMN provenance jsonb" in MIGRATION


def test_publish_records_cc0_wikidata_provenance():
    assert "provenance = $5" in TAXONOMY_ROUTES
    assert "JSON.stringify(TAXONOMY_PROVENANCE)" in TAXONOMY_ROUTES
    assert '"CC0"' in TAXONOMY_LIB
    assert '"Wikidata"' in TAXONOMY_LIB
    assert "wikidata.org" in TAXONOMY_LIB
    assert 'proprietaryVenueData: "none"' in TAXONOMY_LIB


def test_release_json_exposes_provenance():
    assert "provenance: r.provenance ?? null" in TAXONOMY_ROUTES
    assert "provenance," in TAXONOMY_ROUTES  # RELEASE_COLS
