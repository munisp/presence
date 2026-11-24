"""Batch 29 — device trust and push.

FR-51  every new account must pass device attestation before appearing in
       another user's results (verified enrolment + corpus gate)
SEC-19 attestation before discovery, with a documented fallback
SEC-02 session tokens short-lived, device-bound, revocable within 60 s
FR-56  push payloads carry only a type and an opaque identifier; APNs/FCM
       pipeline wired

Wiring invariants asserted against the sources, migration and manifests;
behavioural pins live in the node suites and validate_deploy.py.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MIGRATION = (ROOT / "db" / "migrations" / "0021_attestation_push.sql").read_text()
DEVICES = (ROOT / "services" / "edge" / "src" / "routes" / "devices.ts").read_text()
AUTH = (ROOT / "services" / "edge" / "src" / "auth.ts").read_text()
MODERATION = (ROOT / "services" / "edge" / "src" / "routes" / "moderation.ts").read_text()
NOTIFICATIONS = (ROOT / "services" / "edge" / "src" / "notifications.ts").read_text()
ATTESTATION = (ROOT / "services" / "edge" / "src" / "attestation.ts").read_text()
PUSH = (ROOT / "services" / "edge" / "src" / "push.ts").read_text()
REVOCATION = (ROOT / "services" / "edge" / "src" / "revocation.ts").read_text()
MATCH_STORE = (ROOT / "services" / "match" / "src" / "store.ts").read_text()
OPENAPI = (ROOT / "docs" / "api" / "openapi.yaml").read_text()
DOC = (ROOT / "docs" / "security" / "attestation.md").read_text()
DRILL = (ROOT / "scripts" / "revocation_drill.py").read_text()
README = (ROOT / "deploy" / "k8s" / "README.md").read_text()
COMPOSE = (ROOT / "deploy" / "docker-compose.yml").read_text()
EDGE_YAML = (ROOT / "deploy" / "k8s" / "edge.yaml").read_text()
EXTERNAL_SECRETS = (ROOT / "deploy" / "k8s" / "external-secrets.yaml").read_text()


# ---------------------------------------------------------------- FR-51 -----

def test_fr51_verified_registry_columns_and_definer():
    for col in ("platform", "public_key", "sign_count", "verified_at"):
        assert re.search(rf"ADD COLUMN {col}\b", MIGRATION), col
    assert (
        "CREATE OR REPLACE FUNCTION register_verified_attestation(" in MIGRATION
        and "SECURITY DEFINER" in MIGRATION
    )
    assert (
        "GRANT EXECUTE ON FUNCTION register_verified_attestation(text, uuid, text, text, integer) TO presence_app"
        in MIGRATION
    )
    fn = MIGRATION.split("FUNCTION register_verified_attestation")[1].split("END $$;")[0]
    assert "p_sign_count <= v_count" in fn, "the counter is monotonic"
    assert "RETURN 'counter_regressed'" in fn
    assert "INSERT INTO attestation_duplicates" in fn, "FR-07 dedupe is preserved"
    assert "verified_at = now()" in fn


def test_fr51_discovery_gate_at_the_corpus():
    assert "CREATE VIEW attested_accounts" in MIGRATION
    view = MIGRATION.split("CREATE VIEW attested_accounts")[1].split(";")[0]
    assert "verified_at IS NOT NULL" in view and "attestation_fallbacks" in view
    assert "GRANT SELECT ON attested_accounts TO presence_match" in MIGRATION
    # The match profile read joins the gate — an unattested account has no
    # profile as far as the corpus is concerned.
    assert "EXISTS (SELECT 1 FROM attested_accounts" in MATCH_STORE
    assert "profile_interests" in MATCH_STORE


def test_fr51_enrolment_keeps_the_neutral_response_contract():
    post = DEVICES.split('"/v1/devices"')[1].split("app.get(")[0]
    # The legacy header path and the verified path converge on the same 201.
    assert 'req.headers["x-app-attest-assertion"]' in post
    assert 'reply.code(401).send({ error: "missing app attestation" })' in post
    assert "reply.code(201)" in post
    for line in post.splitlines():
        if "reply." in line:
            assert "outcome" not in line and "duplicate" not in line and "refreshed" not in line
    assert "SELECT register_attestation_key($1, $2::uuid)" in post, "legacy path intact"
    assert "register_verified_attestation($1, $2::uuid, $3, $4, $5)" in post


def test_fr51_challenge_is_single_use_and_short_lived():
    assert "ATTESTATION_CHALLENGE_TTL_S = 120" in ATTESTATION
    assert "getdel(challengeKey(userId))" in DEVICES, "consumed before verification"
    assert "verifyAssertion(verified.publicKey, challenge, userId, verified.signature)" in DEVICES
    assert 'reply.code(401).send({ error: "invalid attestation" })' in DEVICES


# ---------------------------------------------------------------- SEC-19 ----

def test_sec19_fallback_table_definers_and_console_routes():
    assert "CREATE TABLE attestation_fallbacks" in MIGRATION
    assert "attestation_fallbacks_one_open" in MIGRATION, "one open waiver per account"
    for fn in ("approve_attestation_fallback", "revoke_attestation_fallback"):
        body = MIGRATION.split(f"FUNCTION {fn}")[1].split("END $$;")[0]
        assert "IF NOT app_moderator()" in body, f"{fn} is moderator-gated"
        assert "admin_audit_log(" in body, f"{fn} is audited (FR-60)"
    assert 'app.post(\n    "/v1/moderation/attestation-fallbacks/:userId"' in MODERATION
    assert 'app.delete(\n    "/v1/moderation/attestation-fallbacks/:userId"' in MODERATION
    assert MODERATION.count("requireModerator") >= 2


def test_sec19_fallback_is_documented():
    for anchor in ("Protocol", "Discovery gate", "Fallback (SEC-19)", "Session revocation (SEC-02)"):
        assert anchor in DOC, anchor
    assert "cannot attest" in DOC
    assert "attestation-fallbacks" in DOC, "the console route is the documented procedure"


def test_sec19_registry_stays_console_only():
    assert "CREATE POLICY attestation_fallbacks_moderation" in MIGRATION
    plain = re.sub(r"--[^\n]*", "", MIGRATION)
    assert not re.search(
        r"CREATE POLICY \w+ ON attestation_fallbacks\s+FOR SELECT USING \(user_id = app_user\(\)\)",
        plain,
    ), "consumers never read the waiver registry"


# ---------------------------------------------------------------- SEC-02 ----

def test_sec02_revocation_budget_and_denylist():
    assert "REVOCATION_PROPAGATION_S = 60" in REVOCATION
    assert 'revokedDeviceKey(deviceId), "1", "EX"' in REVOCATION
    assert "isDeviceAccessRevoked" in REVOCATION


def test_sec02_revocation_writes_before_reply_and_auth_checks_every_request():
    delete = DEVICES.split('app.delete("/v1/devices/:deviceId"')[1].split("app.put(")[0]
    assert "RETURNING device_id" in delete
    assert delete.index("RETURNING device_id") < delete.index("revokeDeviceAccess"), (
        "the deny write precedes the reply"
    )
    assert "revokeDeviceAccess(ctx, req.userId, deviceId)" in delete
    auth_fn = AUTH.split("export async function authenticate")[1].split("export async function")[0]
    assert 'req.headers["x-device-id"]' in auth_fn
    assert "isDeviceAccessRevoked(ctx, deviceId)" in auth_fn
    assert '"session revoked"' in auth_fn


def test_sec02_drill_measures_against_the_60s_budget():
    assert 'DRILL_BUDGET_S", "60"' in DRILL
    assert "BUDGET_S > 60" in DRILL, "the budget may not be relaxed"
    assert '"/v1/devices"' in DRILL and "x-device-id" in DRILL
    assert "time.monotonic()" in DRILL and "PASS" in DRILL


# ---------------------------------------------------------------- FR-56 -----

def test_fr56_payload_minimalism_contract():
    assert 'PUSH_PAYLOAD_KEYS = ["type", "ref"]' in PUSH
    assert "assertMinimalPayload" in PUSH
    for banned in ("handle", "reason", "label", "cell"):
        assert banned not in PUSH.split("export function buildPushPayload")[1].split("export function")[0], (
            f"buildPushPayload never touches {banned}"
        )


def test_fr56_pipeline_tables_and_definers():
    assert "CREATE TABLE device_push_tokens" in MIGRATION
    assert "platform   text NOT NULL CHECK (platform IN ('ios', 'android'))" in MIGRATION
    assert "CREATE OR REPLACE FUNCTION push_tokens_for(p_user uuid)" in MIGRATION
    assert "CREATE OR REPLACE FUNCTION drop_push_token(p_token text)" in MIGRATION
    assert "SECURITY DEFINER" in MIGRATION
    for fn in ("push_tokens_for(uuid)", "drop_push_token(text)"):
        assert f"REVOKE ALL ON FUNCTION {fn} FROM PUBLIC" in MIGRATION
        assert f"GRANT EXECUTE ON FUNCTION {fn} TO presence_app" in MIGRATION
    assert "CREATE POLICY device_push_tokens_own" in MIGRATION


def test_fr56_dispatch_wiring_and_token_route():
    assert 'app.put(\n    "/v1/devices/:deviceId/push-token"' in DEVICES
    assert "PUSH_TOKEN_RE.test(token)" in DEVICES
    assert "buildPushPayload(event)" in NOTIFICATIONS
    assert "dispatchPush(ctx, pushProviderList(), userId, payload)" in NOTIFICATIONS
    body = NOTIFICATIONS.split("export async function notifyUser")[1]
    assert body.index("await publishRealtime(ctx") < body.index("dispatchPush"), (
        "realtime first; push is best-effort alongside"
    )
    assert "push_tokens_for($1)" in PUSH and "drop_push_token($1)" in PUSH
    assert '"unregistered"' in PUSH, "dead tokens are dropped"


def test_fr56_credentials_only_in_the_managed_store():
    for key in ("APNS_TEAM_ID", "APNS_KEY_ID", "APNS_KEY_P8", "APNS_TOPIC", "FCM_PROJECT_ID", "FCM_ACCESS_TOKEN"):
        assert f"secretKey: {key}" in EXTERNAL_SECRETS, key
        assert f"key: {key}, optional: true" in EDGE_YAML, f"{key} ref is optional (dormant pipeline)"
    # No provider credential literals anywhere in the service sources.
    for src in (ATTESTATION, PUSH, DEVICES, NOTIFICATIONS):
        assert "BEGIN PRIVATE KEY" not in src


# ---------------------------------------------------------------- wiring ----

def test_migration_0021_is_deployed_everywhere():
    assert "0021_attestation_push.sql:/docker-entrypoint-initdb.d/23_attestation_push.sql" in COMPOSE
    assert "23_attestation_push.sql=db/migrations/0021_attestation_push.sql" in README


def test_openapi_documents_the_new_paths():
    for path in (
        "/v1/devices/attestation-challenge:",
        "/v1/devices/{deviceId}/push-token:",
        "/v1/moderation/attestation-fallbacks/{userId}:",
    ):
        assert path in OPENAPI, path


def test_no_new_security_event_kinds():
    # SEC-30's kind CHECK is pinned in batch 24/27 — batch 29 must not add one.
    kinds = re.search(r"SECURITY_EVENT_KINDS = \[([^\]]+)\]", (ROOT / "services" / "edge" / "src" / "security.ts").read_text())
    assert kinds is not None
    assert kinds.group(1).count('"') // 2 == 6, "still the six pinned kinds"
