"""Batch 62 invariants — stakeholder onboarding workflows (SRS Addendum
001, AMD-ONB-01..06):

  AMD-ONB-01  onboarding_applications: the governed entry point for the
              venue_partner and provider kinds — per-kind payload
              validation in the storage layer, one open application per
              (applicant, kind), four-eyes unrepresentable by CHECK.
  AMD-ONB-02  submit_onboarding_application: KYC-verified prerequisite,
              idempotent on an open application, audited.
  AMD-ONB-03  withdraw_onboarding_application: applicant-only, pending
              only, audited.
  AMD-ONB-04  decide_onboarding_application: moderation-only, four-eyes
              in the definer as well as the CHECK, mandatory rejection
              reason; venue approval provisions a PROSPECT venue and binds
              the operator in venue_accounts.
  AMD-ONB-05  venue_accounts is the venue<->operator source of truth the
              BR-12 venue_ids claim replays from; venue_activate is the
              separate venue-ops prospect->active act; venue_offboard
              revokes the bindings.
  AMD-ONB-06  the consumer loop: request_kyc_review lets a pending or
              rejected member initiate review; record_kyc_decision clears
              the stamp; kyc_review_queue is the worklist;
              onboarding_status() is the stepper read model; the FR-62
              export gains the onboarding record.

The 306-requirement ledger stays untouched; amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md.
"""

from __future__ import annotations

import re

import yaml
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / "services/edge"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0037_onboarding.sql").read_text()
EDGE_MODULE = (EDGE / "src/onboarding.ts").read_text()
EDGE_ROUTES = (EDGE / "src/routes/onboarding.ts").read_text()
EDGE_VENUE = (EDGE / "src/routes/venue.ts").read_text()
EDGE_KC = (EDGE / "src/keycloakAdmin.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
CLIENT = (ROOT / "client/src/presence/stakeholderOnboarding.ts").read_text()
COPY = (ROOT / "client/src/presence/copyRegistry.ts").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
UX_DOC = (ROOT / "docs/ux/stakeholder-onboarding.md").read_text()
REHEARSAL = (ROOT / "scripts/rehearse_full_chain.py").read_text()

PUBLIC_DEFINERS = (
    "submit_onboarding_application", "withdraw_onboarding_application",
    "decide_onboarding_application", "onboarding_review_queue",
    "onboarding_payload_valid", "venue_activate", "request_kyc_review",
    "kyc_review_queue", "onboarding_status",
)


def _fn_body(src: str, name: str) -> str:
    start = src.index(f"CREATE OR REPLACE FUNCTION {name}(")
    end = src.index("END $$;", start)
    return src[start:end]


# --------------------------------------------------------------- addendum ---

def test_addendum_carries_the_six_amendments():
    assert "## AMD-ONB — Stakeholder onboarding" in ADDENDUM
    for amd in ("AMD-ONB-01", "AMD-ONB-02", "AMD-ONB-03", "AMD-ONB-04",
                "AMD-ONB-05", "AMD-ONB-06"):
        assert f"**{amd} " in ADDENDUM, amd
    assert "AMD-ONB-01..06 added alongside batch 62" in ADDENDUM
    assert "tests/test_batch62.py` pins the stakeholder onboarding" in ADDENDUM


def test_addendum_pinned_numbers_match_the_migration():
    # 4..64 polygon points, 2..80 name, 10..500 statement/reason.
    assert "4–64" in ADDENDUM and "2–80" in ADDENDUM and "10–500" in ADDENDUM
    assert "BETWEEN 4 AND 64" in MIGRATION
    assert "BETWEEN 2 AND 80" in MIGRATION
    assert MIGRATION.count("BETWEEN 10 AND 500") >= 2  # statement + reason


# -------------------------------------------------------------- migration ---

def test_migration_declares_the_two_tables_with_rls():
    for table in ("onboarding_applications", "venue_accounts"):
        assert f"CREATE TABLE {table}" in MIGRATION, table
        assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in MIGRATION, table


def test_application_record_contract():
    assert re.search(r"CHECK \(kind IN \('venue_partner', 'provider'\)\)", MIGRATION)
    assert re.search(
        r"CHECK \(status IN \('pending', 'approved', 'rejected', 'withdrawn'\)\)",
        MIGRATION)
    # Four-eyes is unrepresentable; a rejection always carries the reason.
    assert "CHECK (decided_by IS NULL OR decided_by <> applicant)" in MIGRATION
    assert "CHECK (status <> 'rejected' OR decision_reason IS NOT NULL)" in MIGRATION
    # One open application per applicant and kind.
    assert re.search(r"CREATE UNIQUE INDEX onboarding_applications_one_open\s+"
                     r"ON onboarding_applications \(applicant, kind\)"
                     r" WHERE status = 'pending'", MIGRATION)
    # Reads: the applicant's own rows, the console under the moderator GUC.
    assert "CREATE POLICY onboarding_applications_select_own" in MIGRATION
    assert "CREATE POLICY onboarding_applications_moderation" in MIGRATION


def test_payload_validator_contract():
    body = _fn_body(MIGRATION, "onboarding_payload_valid")
    assert "LANGUAGE sql IMMUTABLE" in body
    # Keys are whitelisted per kind.
    assert "'name', 'polygon', 'schedule', 'statement'" in body
    assert "'termsVersion', 'statement'" in body
    # The venue polygon: 4..64 [lon, lat] pairs inside valid ranges.
    assert "jsonb_array_length(p_payload->'polygon') BETWEEN 4 AND 64" in body
    assert "(pt->0)::float8 NOT BETWEEN -180 AND 180" in body
    assert "(pt->1)::float8 NOT BETWEEN -90 AND 90" in body
    # The schedule reuses the 0020 registry validator.
    assert "operating_schedule_valid(p_payload->'schedule')" in body
    # The provider terms version is shaped.
    assert "'^v[0-9]+\\.[0-9]+$'" in body


def test_submit_definer_contract():
    body = _fn_body(MIGRATION, "submit_onboarding_application")
    assert "SECURITY DEFINER" in body
    # KYC-verified is the prerequisite for BOTH kinds.
    assert "u.kyc_state = 'verified'" in body
    for outcome in ("'forbidden'", "'unknown_kind'", "'kyc_required'",
                    "'invalid_payload'", "'already_open'", "'submitted'"):
        assert outcome in body, outcome
    assert "'onboarding.submitted'" in body


def test_withdraw_definer_contract():
    body = _fn_body(MIGRATION, "withdraw_onboarding_application")
    assert "IF v_app.applicant <> v_user THEN" in body
    assert "IF v_app.status <> 'pending' THEN" in body
    assert "'onboarding.withdrawn'" in body


def test_decide_definer_contract():
    body = _fn_body(MIGRATION, "decide_onboarding_application")
    assert "app_moderator()" in body
    # Four-eyes in the definer as well as the table CHECK.
    assert "IF v_app.applicant = v_actor THEN" in body
    assert "'four_eyes'" in body
    assert "'reason_required'" in body
    # A venue approval provisions a prospect and binds the operator.
    assert "'prospect'" in body
    assert "INSERT INTO venue_accounts (venue_id, user_id, role, granted_by)" in body
    assert "'venue.provisioned'" in body
    assert "'onboarding.' || p_decision" in body


def test_venue_activation_and_offboard_revocation():
    body = _fn_body(MIGRATION, "venue_activate")
    assert "venue is not a prospect" in body
    assert "'venue.activate'" in body
    offboard = _fn_body(MIGRATION, "venue_offboard")
    # The 0020 anchors survive the extension…
    assert "venue is already offboarded" in offboard
    assert "'venue.offboard'" in offboard
    # …and the binding revocation is new.
    assert "DELETE FROM venue_accounts WHERE venue_id = p_venue" in offboard
    assert "'venue.bindings_revoked'" in offboard
    # The console can read the bindings for the replay.
    assert "CREATE POLICY venue_accounts_console" in MIGRATION
    assert "app_venue_ops() OR app_moderator()" in MIGRATION


def test_consumer_kyc_loop_and_stepper():
    assert "ADD COLUMN kyc_review_requested_at timestamptz" in MIGRATION
    req = _fn_body(MIGRATION, "request_kyc_review")
    assert "v_state NOT IN ('pending', 'rejected')" in req
    assert "'already_requested'" in req and "'not_requestable'" in req
    # A decision clears the stamp so the loop closes.
    decision = _fn_body(MIGRATION, "record_kyc_decision")
    assert "kyc_review_requested_at = NULL" in decision
    # The 0024 anchors survive the extension.
    assert "app_moderator() OR current_setting('app.kyc_callback', true) = 'on'" in decision
    queue = _fn_body(MIGRATION, "kyc_review_queue")
    assert "app_moderator()" in queue
    status = _fn_body(MIGRATION, "onboarding_status")
    for key in ("'ageDeclared'", "'kycState'", "'kycReviewRequested'",
                "'avatarSet'", "'verticalsChosen'", "'complete'"):
        assert key in status, key


def test_dsar_export_carries_the_onboarding_record():
    # dsar_export is LANGUAGE sql — it ends at "$$;", not "END $$;".
    start = MIGRATION.index("CREATE OR REPLACE FUNCTION dsar_export(")
    body = MIGRATION[start:MIGRATION.index("$$;", start)]
    assert "'onboardingApplications'" in body
    assert "'kycReviewRequestedAt'" in body
    # The b61 anchors survive the extension.
    assert "'services'" in body


def test_definer_grants_and_revokes():
    for fn in PUBLIC_DEFINERS:
        assert f"REVOKE ALL ON FUNCTION {fn}" in MIGRATION, fn
    for fn in PUBLIC_DEFINERS:
        if fn == "onboarding_payload_valid":
            continue  # definer-internal: revoked, never granted
        assert f"GRANT EXECUTE ON FUNCTION {fn}" in MIGRATION, fn
    assert "GRANT SELECT ON onboarding_applications TO presence_app" in MIGRATION
    assert "GRANT SELECT ON venue_accounts TO presence_app" in MIGRATION


def test_no_banned_vocabulary():
    # FR-17: the word "intent" never appears in SQL.
    assert "intent" not in MIGRATION.lower()
    # SEC-17: no government-identifier vocabulary in the migration.
    assert not re.search(r"passport|\bnin\b|\bbvn\b", MIGRATION.lower())


# -------------------------------------------------------------------- edge ---

def test_edge_module_mirrors_the_migration():
    assert 'APPLICATION_KINDS = ["venue_partner", "provider"]' in EDGE_MODULE
    for const in ("VENUE_NAME_MAX = 80", "POLYGON_MIN_POINTS = 4",
                  "POLYGON_MAX_POINTS = 64", "STATEMENT_MIN = 10",
                  "STATEMENT_MAX = 500"):
        assert const in EDGE_MODULE, const
    assert "TERMS_VERSION_PATTERN" in EDGE_MODULE
    for fn in ("parseApplicationBody", "parseStatusDoc"):
        assert f"export function {fn}" in EDGE_MODULE, fn


def test_edge_routes_cover_both_surfaces():
    for route in (
        '"/v1/onboarding/applications"',
        '"/v1/onboarding/applications/mine"',
        '"/v1/onboarding/applications/:applicationId/withdraw"',
        '"/v1/account/onboarding"',
        '"/v1/identity/kyc/request"',
        '"/v1/moderation/onboarding"',
        '"/v1/moderation/onboarding/:applicationId/approve"',
        '"/v1/moderation/onboarding/:applicationId/reject"',
        '"/v1/moderation/kyc-queue"',
    ):
        assert route in EDGE_ROUTES, route
    # The decision surface is moderator-gated and runs under the GUC.
    assert EDGE_ROUTES.count("requireModerator") >= 4
    assert "withModerator" in EDGE_ROUTES
    # The applicant surface runs on plain RLS.
    assert "withRls" in EDGE_ROUTES
    # Registration.
    assert "registerOnboardingRoutes(authed, ctx);" in EDGE_APP


def test_venue_activation_route_and_keycloak_replay():
    assert '"/v1/venues/:venueId/activate"' in EDGE_VENUE
    assert "venue_activate($1::uuid, $2::uuid)" in EDGE_VENUE
    # Offboard replays the binding removal.
    assert 'bindVenueId(keycloakConfig(), "remove"' in EDGE_VENUE
    assert "addVenueId" in EDGE_KC and "removeVenueId" in EDGE_KC
    assert "bindVenueId" in EDGE_KC
    assert 'KEYCLOAK_ADMIN_VENUE_REALM' in EDGE_KC
    # The approve route replays the binding fire-and-forget.
    assert 'void bindVenueId(keycloakConfig(), "add"' in EDGE_ROUTES


# ------------------------------------------------------------------ client ---

def test_client_contract_and_copy():
    assert 'APPLICATION_KINDS = ["venue_partner", "provider"]' in CLIENT
    for fn in ("buildVenuePartnerPayload", "buildProviderPayload",
               "parseApplicationList", "parseOnboardingStatus",
               "onboardingSteps"):
        assert f"export function {fn}" in CLIENT, fn
    for key in ("ui.onboarding.step.age", "ui.onboarding.step.kyc",
                "ui.onboarding.step.avatar", "ui.onboarding.step.verticals",
                "ui.onboarding.kyc.under-review", "ui.onboarding.kyc.rejected",
                "ui.onboarding.application.state.pending",
                "ui.onboarding.application.state.approved",
                "ui.onboarding.application.state.rejected",
                "ui.onboarding.application.state.withdrawn"):
        assert f'"{key}"' in COPY, key


# ------------------------------------------------------------------ openapi ---

def test_openapi_documents_every_new_route():
    spec = yaml.safe_load(OPENAPI)
    for path, methods in {
        "/v1/onboarding/applications": {"post"},
        "/v1/onboarding/applications/mine": {"get"},
        "/v1/onboarding/applications/{applicationId}/withdraw": {"post"},
        "/v1/account/onboarding": {"get"},
        "/v1/identity/kyc/request": {"post"},
        "/v1/moderation/onboarding": {"get"},
        "/v1/moderation/onboarding/{applicationId}/approve": {"post"},
        "/v1/moderation/onboarding/{applicationId}/reject": {"post"},
        "/v1/moderation/kyc-queue": {"get"},
        "/v1/venues/{venueId}/activate": {"post"},
    }.items():
        assert path in spec["paths"], path
        assert methods <= set(spec["paths"][path].keys()), path
    # Mutating operations carry the Idempotency-Key parameter (TR-24).
    for path, methods in {
        "/v1/onboarding/applications": {"post"},
        "/v1/onboarding/applications/{applicationId}/withdraw": {"post"},
        "/v1/identity/kyc/request": {"post"},
        "/v1/moderation/onboarding/{applicationId}/approve": {"post"},
        "/v1/moderation/onboarding/{applicationId}/reject": {"post"},
        "/v1/venues/{venueId}/activate": {"post"},
    }.items():
        params = spec["paths"][path]["post"].get("parameters", [])
        assert any("IdempotencyKey" in str(prm) for prm in params), path


# ------------------------------------------------------------------- deploy ---

def test_migration_rides_both_initdb_mounts():
    assert "39_onboarding.sql=db/migrations/0037_onboarding.sql" in K8S_README
    assert ("0037_onboarding.sql:/docker-entrypoint-initdb.d/39_onboarding.sql:ro"
            in COMPOSE)


def test_ux_doc_maps_the_journeys():
    for anchor in ("The consumer journey", "Becoming a venue partner",
                   "Becoming a provider", "The moderation console",
                   "Record-keeping"):
        assert anchor in UX_DOC, anchor


# ---------------------------------------------------------------- rehearsal ---

def test_rehearsal_gains_phase_8e():
    assert "phase 8e: stakeholder onboarding" in REHEARSAL
    for check in ("onb_unverified_refused", "onb_submitted",
                  "onb_resubmit_idempotent", "onb_bad_polygon",
                  "onb_four_eyes", "onb_reject_needs_reason",
                  "onb_venue_prospect", "onb_owner_bound",
                  "onb_activate_twice_refused", "onb_kyc_requested",
                  "onb_kyc_stamp_cleared", "onb_kyc_rerequest",
                  "onb_status_shape", "onb_complete", "onb_withdrawn",
                  "onb_offboard_revokes_bindings", "onb_audit_trail",
                  "onb_dsar_inclusion"):
        assert f'r.check("{check}"' in REHEARSAL, check
    assert '"venue_ops": "app.venue_ops"' in REHEARSAL
