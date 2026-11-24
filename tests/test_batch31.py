"""Batch 31 — SEC-03 JIT elevation, SEC-01 AAL2 evidence, TECH-07 passkey flow.

These invariants pin the just-in-time workforce elevation workflow (migration
0022 + console routes + lifecycle expiry + the env-gated Keycloak role
binding), the AAL2 conformance of the consumer realm, and the imported
passkey-only browser flow — cross-layer, so a drift in any one layer fails CI.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

MIGRATION_0022 = (ROOT / "db" / "migrations" / "0022_jit_elevation.sql").read_text()
ELEVATION_TS = (ROOT / "services" / "edge" / "src" / "elevation.ts").read_text()
KEYCLOAK_ADMIN_TS = (ROOT / "services" / "edge" / "src" / "keycloakAdmin.ts").read_text()
ROUTES_TS = (ROOT / "services" / "edge" / "src" / "routes" / "elevation.ts").read_text()
LIFECYCLE_TS = (ROOT / "services" / "edge" / "src" / "lifecycle.ts").read_text()
APP_TS = (ROOT / "services" / "edge" / "src" / "app.ts").read_text()
EDGE_TEST = (ROOT / "services" / "edge" / "test" / "elevation.test.ts").read_text()

REALM_CONSUMER = json.loads((ROOT / "deploy" / "keycloak" / "realm-consumer.json").read_text())
REALM_WORKFORCE = json.loads((ROOT / "deploy" / "keycloak" / "realm-workforce.json").read_text())
KC_README = (ROOT / "deploy" / "keycloak" / "README.md").read_text()

K8S_README = (ROOT / "deploy" / "k8s" / "README.md").read_text()
EDGE_YAML = (ROOT / "deploy" / "k8s" / "edge.yaml").read_text()
EXT_SECRETS = (ROOT / "deploy" / "k8s" / "external-secrets.yaml").read_text()

ELEVATION_MD = (ROOT / "docs" / "security" / "elevation.md").read_text()
AAL2_MD = (ROOT / "docs" / "security" / "aal2.md").read_text()
OPENAPI = yaml.safe_load((ROOT / "docs" / "api" / "openapi.yaml").read_text())

ELEVATION_DEFINERS = [
    "request_elevation",
    "my_elevations",
    "approve_elevation",
    "reject_elevation",
    "revoke_elevation",
    "expire_elevations",
]


# ------------------------------------------------------------- SEC-03 SQL ---

def test_migration_0022_shape() -> None:
    assert "BEGIN;" in MIGRATION_0022 and "COMMIT;" in MIGRATION_0022
    assert "DROP " not in MIGRATION_0022, "forward-only (INF-17 rehearsal lint)"
    assert "CREATE TABLE elevation_requests" in MIGRATION_0022
    for fn in ELEVATION_DEFINERS:
        assert f"CREATE OR REPLACE FUNCTION {fn}(" in MIGRATION_0022
        assert f"GRANT EXECUTE ON FUNCTION {fn}" in MIGRATION_0022
        assert f"REVOKE ALL ON FUNCTION {fn}" in MIGRATION_0022
    assert "ALTER TABLE elevation_requests ENABLE ROW LEVEL SECURITY" in MIGRATION_0022
    assert "CREATE POLICY elevation_requests_moderation" in MIGRATION_0022
    assert "USING (app_moderator())" in MIGRATION_0022


def test_four_eyes_enforced_at_two_layers() -> None:
    # The definer raises a clean error…
    assert "four-eyes: approver must differ from requester" in MIGRATION_0022
    # …and the storage layer makes a direct-write bypass impossible.
    assert "CHECK (decided_by IS NULL OR decided_by <> subject)" in MIGRATION_0022
    # app_moderator() gates every decision definer (request/self-read are
    # edge-gated like register_verified_attestation).
    for fn in ("approve_elevation", "reject_elevation", "revoke_elevation"):
        body = MIGRATION_0022.split(f"FUNCTION {fn}(", 1)[1]
        assert "app_moderator()" in body.split("END $$;", 1)[0]


def test_grant_ttl_pinned_to_session_ceiling() -> None:
    assert "interval '4 hours'" in MIGRATION_0022
    assert REALM_WORKFORCE["ssoSessionMaxLifespan"] == 14400
    assert "4 * 60 * 60 * 1000" in ELEVATION_TS
    assert "ELEVATION_GRANT_TTL_MS" in ELEVATION_TS
    # Stale pending requests lapse after 24 hours, same pin in both layers.
    assert "interval '24 hours'" in MIGRATION_0022
    assert "24 * 60 * 60 * 1000" in ELEVATION_TS


def test_state_machine_and_one_open_index() -> None:
    m = re.search(
        r"CHECK \(status IN \('pending', 'approved', 'rejected', 'revoked', 'expired'\)\)",
        MIGRATION_0022,
    )
    assert m, "the five-state machine is pinned in the CHECK"
    assert (
        "CREATE UNIQUE INDEX elevation_requests_one_open" in MIGRATION_0022
        and "WHERE status IN ('pending', 'approved')" in MIGRATION_0022
    )
    # An approved row must carry decider, decision time and expiry.
    assert "status <> 'approved' OR (decided_by IS NOT NULL" in MIGRATION_0022
    assert "AND expires_at IS NOT NULL))" in MIGRATION_0022
    # Every transition is audited in-transaction with the governed code.
    for action in ("requested", "approved", "rejected", "revoked", "expired"):
        assert f"'elevation.{action}'" in MIGRATION_0022
    assert MIGRATION_0022.count("'jit_elevation'") >= 5


def test_expiry_returns_subjects_for_role_unbind() -> None:
    assert "RETURNS TABLE(subject uuid, request_id uuid)" in MIGRATION_0022
    # The tick drives it after the retention pass, and unbinds each subject.
    assert "reports_retention_tick" in LIFECYCLE_TS
    assert "expire_elevations()" in LIFECYCLE_TS
    assert LIFECYCLE_TS.index("reports_retention_tick") < LIFECYCLE_TS.index("expire_elevations()")
    assert 'bindModeratorRole(admin, "revoke", row.subject)' in LIFECYCLE_TS
    assert "elevationsExpired" in LIFECYCLE_TS
    assert "keycloakAdminFromEnv()" in LIFECYCLE_TS


# --------------------------------------------------------- SEC-03 routes ---

def test_routes_registered_and_gated() -> None:
    assert "registerElevationRoutes" in APP_TS
    for path in (
        "/v1/console/elevation/requests",
        "/v1/console/elevation/requests/mine",
        "/v1/moderation/elevation",
        "/v1/moderation/elevation/:requestId/approve",
        "/v1/moderation/elevation/:requestId/reject",
        "/v1/moderation/elevation/:requestId/revoke",
    ):
        assert f'"{path}"' in ROUTES_TS, f"missing route {path}"
    # Requester surface is gated on elevation-eligible — NOT moderator; that
    # is the whole point of JIT access.
    assert ROUTES_TS.count("requireElevationEligible") >= 3  # import + 2 preHandlers
    assert '"elevation-eligible"' in ELEVATION_TS
    # Decision surface runs under the moderator GUC.
    assert ROUTES_TS.count("requireModerator") >= 4  # import + 3 preHandlers
    assert ROUTES_TS.count("withModerator") >= 4  # import + queue + 3 decisions
    # Approval binds the role, revocation unbinds it.
    assert 'bindModeratorRole(keycloakConfig(), "grant", subject)' in ROUTES_TS
    assert 'bindModeratorRole(keycloakConfig(), "revoke", rows.rows[0].subject)' in ROUTES_TS


def test_justification_screened_and_bounded() -> None:
    assert "char_length(justification) BETWEEN 10 AND 500" in MIGRATION_0022
    assert "screenText(justification)" in ELEVATION_TS
    assert "minLength: 10" in ROUTES_TS and "maxLength: 500" in ROUTES_TS


# ------------------------------------------------- SEC-03 keycloak binding ---

def test_keycloak_admin_client_is_env_gated_and_idempotent() -> None:
    for var in ("KEYCLOAK_ADMIN_BASE_URL", "KEYCLOAK_ADMIN_CLIENT_ID", "KEYCLOAK_ADMIN_CLIENT_SECRET"):
        assert var in KEYCLOAK_ADMIN_TS
    assert "client_credentials" in KEYCLOAK_ADMIN_TS
    assert "role-mappings/realm" in KEYCLOAK_ADMIN_TS
    assert 'method: "DELETE"' in KEYCLOAK_ADMIN_TS  # unbind path
    assert "body.expires_in - 30" in KEYCLOAK_ADMIN_TS  # early token refresh
    assert "if (!cfg) return;" in KEYCLOAK_ADMIN_TS  # documented no-op
    # bindModeratorRole never lets a binding failure escape into a request.
    assert re.search(r"catch \(err\) \{\s*console\.error", KEYCLOAK_ADMIN_TS)
    # k8s: env wired, credentials optional from the managed store only.
    assert "- name: KEYCLOAK_ADMIN_BASE_URL" in EDGE_YAML
    assert "key: KEYCLOAK_ADMIN_CLIENT_ID, optional: true" in EDGE_YAML
    assert "key: KEYCLOAK_ADMIN_CLIENT_SECRET, optional: true" in EDGE_YAML
    assert "property: ADMIN_CLIENT_ID" in EXT_SECRETS
    assert "property: ADMIN_CLIENT_SECRET" in EXT_SECRETS


def test_migration_mounted_and_docs_present() -> None:
    assert "24_jit_elevation.sql=db/migrations/0022_jit_elevation.sql" in K8S_README
    # Every migration is mounted (the b23 regression guard, kept honest).
    for path in sorted((ROOT / "db" / "migrations").glob("*.sql")):
        assert f"=db/migrations/{path.name}" in K8S_README, f"{path.name} not mounted"
    for text in ("four-eyes", "4-hour", "KEYCLOAK_ADMIN_CLIENT_ID", "lifecycle tick"):
        assert text in ELEVATION_MD, f"elevation.md missing {text}"
    assert "kcadm.sh create clients" in KC_README


# ------------------------------------------------------------- TECH-07 -----

def test_consumer_browser_flow_is_passkey_only() -> None:
    assert REALM_CONSUMER["browserFlow"] == "consumer passkey browser"
    flows = {f["alias"]: f for f in REALM_CONSUMER["authenticationFlows"]}
    flow = flows["consumer passkey browser"]
    executions = {
        e["authenticator"]: e["requirement"] for e in flow["authenticationExecutions"]
    }
    assert executions == {
        "auth-cookie": "ALTERNATIVE",
        "webauthn-authenticator-passwordless": "REQUIRED",
    }
    # No password path anywhere in the realm — there is nothing to
    # downgrade to (AAL2).
    assert "auth-username-password-form" not in json.dumps(REALM_CONSUMER)
    actions = {a["alias"]: a for a in REALM_CONSUMER["requiredActions"]}
    enrol = actions["webauthn-register-passwordless"]
    assert enrol["enabled"] is True and enrol["defaultAction"] is True
    # The README no longer defers the flow; the SMS contract is documented.
    assert "custom flow is wired when" not in KC_README
    assert "SMS recovery contract (TECH-07)" in KC_README
    assert "SPI" in KC_README


# --------------------------------------------------------------- SEC-01 ----

def test_aal2_realm_assertions() -> None:
    r = REALM_CONSUMER
    assert r["webAuthnPolicyPasswordlessUserVerificationRequirement"] == "required"
    assert r["webAuthnPolicyPasswordlessAuthenticatorAttachment"] == "platform"
    assert r["webAuthnPolicyPasswordlessRequireResidentKey"] == "Yes"
    assert r["webAuthnPolicyPasswordlessSignatureAlgorithms"] == ["ES256", "RS256"]
    assert r["resetPasswordAllowed"] is False
    assert r["bruteForceProtected"] is True
    assert r["accessTokenLifespan"] <= 300  # 5-minute tokens (SEC-02)
    app_client = next(c for c in r["clients"] if c["clientId"] == "presence-app")
    assert app_client["attributes"]["pkce.code.challenge.method"] == "S256"
    assert app_client["directAccessGrantsEnabled"] is False
    # The evidence document maps every control family.
    for text in ("NIST SP 800-63B", "AAL2", "User verification", "JWKS", "PKCE", "Phishing-resistant"):
        assert text in AAL2_MD, f"aal2.md missing {text}"


# --------------------------------------------------------------- contract --

def test_openapi_documents_the_elevation_surface() -> None:
    paths = OPENAPI["paths"]
    assert "post" in paths["/v1/console/elevation/requests"]
    assert "get" in paths["/v1/console/elevation/requests/mine"]
    assert "get" in paths["/v1/moderation/elevation"]
    for op in ("approve", "reject", "revoke"):
        assert "post" in paths[f"/v1/moderation/elevation/{{requestId}}/{op}"]


def test_edge_tests_cover_the_binding() -> None:
    assert "ELEVATION_GRANT_TTL_MS" in EDGE_TEST
    assert "bindModeratorRole" in EDGE_TEST
    assert "role-mappings/realm" in EDGE_TEST
