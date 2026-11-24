"""Batch 38 invariants — auth/session wiring (FR-01).

The client authenticates with passkeys only: the ceremony runs in the
system browser against the passkey-only consumer realm over OpenID
Connect Authorization Code + PKCE (S256), so no raw WebAuthn native
dependency exists and no password is ever set (authFlow.ts). The token
lifecycle is disciplined (session.ts): refresh ahead of the 300 s SEC-02
expiry, exactly one refresh-retry per 401, the FR-05 device id on every
authed call, and a logout pinned to withdraw-first → RP-initiated IdP
logout → TR-30 wipe. The device-reachable issuer travels on the
unauthenticated bootstrap config (GET /v1/client/config auth block), and
the second-device rule is anchored on the attestation-gated enrolment
route.

Every pin here fails loudly if a future change relaxes one of those
guarantees — module purity, the pinned constants and URIs, the
fail-closed parses, the logout order, the bootstrap schema, the deploy
env, and the reflection of the batch in the client README, the App
shell, the OpenAPI contract and the traceability matrix.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT_SRC = ROOT / "client" / "src" / "presence"
CLIENT_TEST = ROOT / "client" / "test"

AUTH_FLOW_TS = (CLIENT_SRC / "authFlow.ts").read_text(encoding="utf-8")
SESSION_TS = (CLIENT_SRC / "session.ts").read_text(encoding="utf-8")
LOCAL_STATE_TS = (CLIENT_SRC / "localState.ts").read_text(encoding="utf-8")
AUTH_FLOW_TEST = (CLIENT_TEST / "authFlow.test.ts").read_text(encoding="utf-8")
SESSION_TEST = (CLIENT_TEST / "session.test.ts").read_text(encoding="utf-8")
README = (ROOT / "client" / "README.md").read_text(encoding="utf-8")
APP_TSX = (ROOT / "client" / "App.tsx").read_text(encoding="utf-8")
OPENAPI = (ROOT / "docs" / "api" / "openapi.yaml").read_text(encoding="utf-8")
CLIENT_AUTH_DOC = (ROOT / "docs" / "security" / "client-auth.md").read_text(encoding="utf-8")
EDGE_CLIENT_CONFIG = (ROOT / "services" / "edge" / "src" / "clientConfig.ts").read_text(encoding="utf-8")
EDGE_CONFIG_TEST = (ROOT / "services" / "edge" / "test" / "clientConfig.test.ts").read_text(encoding="utf-8")
REALM = json.loads((ROOT / "deploy" / "keycloak" / "realm-consumer.json").read_text(encoding="utf-8"))
K8S_EDGE = (ROOT / "deploy" / "k8s" / "edge.yaml").read_text(encoding="utf-8")
COMPOSE = (ROOT / "deploy" / "docker-compose.yml").read_text(encoding="utf-8")
VALIDATE_DEPLOY = (ROOT / "scripts" / "validate_deploy.py").read_text(encoding="utf-8")
ALLOWLIST = json.loads((ROOT / "docs" / "security" / "sdk-allowlist.json").read_text(encoding="utf-8"))
TRACEABILITY = json.loads((ROOT / "docs" / "traceability.json").read_text(encoding="utf-8"))


def _imports_of(source: str) -> list[str]:
    return re.findall(r'^\s*import\s.*?from\s+"([^"]+)"', source, flags=re.M)


# ------------------------------------------------------------- purity ---


def test_auth_flow_imports_only_the_in_repo_sha256() -> None:
    # SEC-18 discipline: the S256 challenge reuses the in-repo pure-TS
    # SHA-256 — no native crypto package enters the dependency surface.
    assert _imports_of(AUTH_FLOW_TS) == ["./sha256.js"]
    assert "fetch(" not in AUTH_FLOW_TS
    assert "getRandomValues" not in AUTH_FLOW_TS  # injected RandomSource instead


def test_session_imports_only_local_state_and_the_lifecycle_wire() -> None:
    # The withdrawal wire is SHARED with presenceLifecycle.ts, never
    # copied — the FR-19 target cannot drift between the two modules.
    assert sorted(_imports_of(SESSION_TS)) == ["./localState.js", "./presenceLifecycle.js"]
    assert "fetch(" not in SESSION_TS


def test_dependency_allowlist_stays_exactly_ten() -> None:
    npm = sorted(e["name"] for e in ALLOWLIST["sdks"] if e["ecosystem"] == "npm")
    assert npm == sorted([
        "@types/node",
        "@types/react",
        "expo",
        "expo-dev-client",
        "expo-secure-store",
        "expo-status-bar",
        "h3-js",
        "react",
        "react-native",
        "typescript",
    ])


# ----------------------------------------------------- FR-01: auth flow ---


def test_pinned_redirect_uris_match_the_realm_export() -> None:
    assert 'APP_REDIRECT_URI = "presence://auth/callback"' in AUTH_FLOW_TS
    assert 'APP_POST_LOGOUT_REDIRECT_URI = "presence://auth/logout"' in AUTH_FLOW_TS
    app_client = next(c for c in REALM["clients"] if c["clientId"] == "presence-app")
    assert "presence://auth/callback" in app_client["redirectUris"]
    assert app_client["attributes"]["post.logout.redirect.uris"] == "presence://auth/logout"
    assert app_client["attributes"]["pkce.code.challenge.method"] == "S256"
    assert app_client["publicClient"] is True
    assert app_client["directAccessGrantsEnabled"] is False


def test_pkce_challenge_is_s256_over_the_in_repo_digest() -> None:
    assert 'PKCE_CHALLENGE_METHOD = "S256"' in AUTH_FLOW_TS
    assert "base64UrlEncode(sha256(utf8(verifier)))" in AUTH_FLOW_TS
    assert '["code_challenge_method", PKCE_CHALLENGE_METHOD]' in AUTH_FLOW_TS
    # The unit tests pin the RFC 7636 appendix-B worked example.
    assert "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" in AUTH_FLOW_TEST


def test_randomness_is_injected_never_global() -> None:
    assert "export type RandomSource = (bytes: number) => Uint8Array" in AUTH_FLOW_TS
    assert "random: RandomSource" in AUTH_FLOW_TS
    assert "Math.random" not in AUTH_FLOW_TS


def test_callback_parse_fails_closed() -> None:
    # State mismatch rejects; provider error surfaces; missing code refuses.
    assert 'params.get("state") !== expectedState' in AUTH_FLOW_TS
    assert 'return { ok: false, reason: "state-mismatch" }' in AUTH_FLOW_TS
    assert 'return { ok: false, reason: "provider-error", detail: error }' in AUTH_FLOW_TS
    assert 'return { ok: false, reason: "missing-code" }' in AUTH_FLOW_TS
    assert "state-mismatch" in AUTH_FLOW_TEST


def test_bootstrap_resolution_fails_closed_on_empty_issuer() -> None:
    assert "if (issuer.length === 0 || clientId.length === 0) return null" in AUTH_FLOW_TS
    assert 'AUTH_BOOTSTRAP_PATH = "/v1/client/config"' in AUTH_FLOW_TS
    assert "resolveAuthConfig({}), null" in AUTH_FLOW_TEST


def test_no_password_surface_anywhere_in_the_flow() -> None:
    # FR-01: no password is ever set — the authorize request carries the
    # openid scope and nothing credential-shaped; the unit suite asserts
    # the built URL never carries a password-shaped parameter.
    assert '["scope", "openid"]' in AUTH_FLOW_TS
    assert 'assert.equal(attempt.url.includes("password"), false' in AUTH_FLOW_TEST


# --------------------------------------------------- FR-01: the session ---


def test_session_timing_matches_the_realm_contract() -> None:
    assert "ACCESS_TOKEN_LIFESPAN_S = 300" in SESSION_TS  # SEC-02: 5-minute tokens
    assert "REFRESH_MARGIN_S = 30" in SESSION_TS
    assert "return tokens.expiresAtMs - REFRESH_MARGIN_S * 1000" in SESSION_TS
    assert REALM["accessTokenLifespan"] == 300


def test_refresh_token_key_is_allowlist_typed() -> None:
    # The TR-30 allowlist is the single source of truth — drift is a
    # compile error, and this pin keeps the string itself honest.
    assert 'SESSION_REFRESH_TOKEN_KEY: LocalStateKey = "presence.session.refreshToken"' in SESSION_TS
    assert '"presence.session.refreshToken"' in LOCAL_STATE_TS


def test_every_authed_call_carries_the_device_id() -> None:
    assert '"x-device-id": tokens.deviceId' in SESSION_TS
    assert 'authorization: `Bearer ${tokens.accessToken}`' in SESSION_TS


def test_a_401_earns_exactly_one_retry() -> None:
    assert 'return alreadyRetried ? "reauthenticate" : "refresh-retry"' in SESSION_TS
    assert 'onUnauthorized(true), "reauthenticate"' in SESSION_TEST


def test_refresh_rotation_never_drops_the_credential() -> None:
    assert "previous.refreshToken" in SESSION_TS
    assert "rt-1" in SESSION_TEST  # kept when the response omits a replacement


def test_logout_order_is_pinned_and_shared() -> None:
    assert (
        'LOGOUT_PIPELINE = [\n  "withdraw-presence",\n  "rp-initiated-logout",\n  "clear-local-state",\n] as const'
        in SESSION_TS
    )
    # Withdraw first (needs auth), IdP second, wipe last — in the code,
    # not just in a comment.
    assert SESSION_TS.index("await effects.withdrawPresence(authHeaders(tokens))") < SESSION_TS.index(
        "await effects.endIdpSession(logoutUrl)"
    ) < SESSION_TS.index("await clearLocalState(backend)")
    assert "LOGOUT_WITHDRAWAL_WIRE = WITHDRAWAL_WIRE" in SESSION_TS
    # The first sign-in persists the credential only after enrolment.
    assert (
        'FIRST_SIGN_IN_PIPELINE = [\n  "exchange-code",\n  "enrol-device",\n  "persist-refresh-token",\n] as const'
        in SESSION_TS
    )


def test_second_device_is_anchored_on_enrolment() -> None:
    assert 'DEVICE_ENROLMENT_WIRE = { method: "POST", path: "/v1/devices" } as const' in SESSION_TS
    assert "device_cap" in CLIENT_AUTH_DOC
    assert "SEC-09" in CLIENT_AUTH_DOC and "recovery" in CLIENT_AUTH_DOC


# ------------------------------------------------------- edge bootstrap ---


def test_client_config_carries_the_auth_block() -> None:
    assert "auth: { issuer: string; clientId: string }" in EDGE_CLIENT_CONFIG
    assert "KEYCLOAK_PUBLIC_ISSUER_URL?: string | undefined" in EDGE_CLIENT_CONFIG
    assert "KEYCLOAK_CLIENT_ID?: string | undefined" in EDGE_CLIENT_CONFIG
    # The public URL wins; the in-cluster issuer is the dev fallback.
    assert "env.KEYCLOAK_PUBLIC_ISSUER_URL ?? env.KEYCLOAK_ISSUER ??" in EDGE_CLIENT_CONFIG
    assert '|| "presence-app"' in EDGE_CLIENT_CONFIG
    assert 'auth: { issuer, clientId },' in EDGE_CLIENT_CONFIG
    # The route schema requires the block.
    assert 'required: ["configVersion", "pinning", "api", "auth"]' in EDGE_CLIENT_CONFIG


def test_client_config_tests_pin_the_auth_block() -> None:
    assert "FR-01" in EDGE_CONFIG_TEST
    assert 'auth: { issuer: "", clientId: "presence-app" }' in EDGE_CONFIG_TEST
    assert "KEYCLOAK_PUBLIC_ISSUER_URL" in EDGE_CONFIG_TEST


def test_deploy_env_is_documented_in_k8s_and_compose() -> None:
    assert "KEYCLOAK_PUBLIC_ISSUER_URL" in K8S_EDGE
    assert "KEYCLOAK_CLIENT_ID" in K8S_EDGE
    assert "KEYCLOAK_PUBLIC_ISSUER_URL" in COMPOSE
    assert "KEYCLOAK_CLIENT_ID" in COMPOSE
    assert "http://localhost:8080/realms/consumer" in COMPOSE
    assert "FR-01 auth bootstrap env is documented in k8s and compose" in VALIDATE_DEPLOY


# ----------------------------------------------------------- reflection ---


def test_client_readme_and_app_reflect_the_batch() -> None:
    assert "src/presence/authFlow.ts" in README
    assert "src/presence/session.ts" in README
    assert "FR-01" in README
    assert 'from "./src/presence/authFlow.js"' in APP_TSX
    assert 'from "./src/presence/session.js"' in APP_TSX
    assert "PKCE_CHALLENGE_METHOD" in APP_TSX
    assert "REFRESH_MARGIN_S" in APP_TSX
    assert "passkey-only sign-in" in APP_TSX


def test_openapi_reflects_the_auth_bootstrap() -> None:
    assert "required: [configVersion, pinning, api, auth]" in OPENAPI
    assert "device-reachable issuer of the passkey-only consumer realm (FR-01)" in OPENAPI
    assert "passkey-only (FR-01)" in OPENAPI
    assert "x-device-id" in OPENAPI


def test_traceability_reclassifies_fr01() -> None:
    entry = TRACEABILITY["requirements"]["FR-01"]
    assert entry["status"] == "implemented"
    assert "authFlow.ts" in entry["note"]
    assert "session.ts" in entry["note"]
    counts = TRACEABILITY["status_counts"]
    # Batch 39 moved the counts: five surface requirements
    # (FR-76/78/79/80/87) reclassified client → implemented.
    # Batch 40 moved them again: six interaction-surface requirements
    # (FR-81/82/83/84/86/SEC-35) reclassified client → implemented.
    # Batch 41 closed the four journey partials
    # (FR-03/08/41/48) partial → implemented: 219 → 223, 7 → 3.
    # Batch 42 moved them again: NFR-36 + TECH-16 client → implemented,
    # NFR-04/05/29/30/35 client → partial: 223 → 225, 3 → 8, 14 → 7.
    assert counts["implemented"] == 225
    assert counts["partial"] == 8
    assert counts["client"] == 7
