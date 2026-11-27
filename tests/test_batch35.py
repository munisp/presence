"""Batch 35 — client trust layer: TR-31 BLE rotating codes, TR-32 permission
degradation, TR-33 remotely-removable certificate pinning.

With the server side complete, the remaining workstream is the React Native
client. These invariants pin the trust layer added in this batch across all
layers — the pure-TS crypto (zero new dependencies per SEC-18), the rotation
and never-stable contract, the no-dead-ends degradation planner, the pinning
policy that fails open, the unauthenticated edge config route that makes
pinning removable without an app update, and the API contract — so a drift
in any layer fails CI.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT = ROOT / "client"

SHA256_TS = (CLIENT / "src" / "presence" / "sha256.ts").read_text()
BLE_TS = (CLIENT / "src" / "presence" / "bleCodes.ts").read_text()
PERMS_TS = (CLIENT / "src" / "presence" / "permissions.ts").read_text()
PIN_TS = (CLIENT / "src" / "presence" / "certPinning.ts").read_text()
BLE_TEST = (CLIENT / "test" / "bleCodes.test.ts").read_text()
PERMS_TEST = (CLIENT / "test" / "permissions.test.ts").read_text()
PIN_TEST = (CLIENT / "test" / "certPinning.test.ts").read_text()
APP_TSX = (CLIENT / "App.tsx").read_text()
CLIENT_README = (CLIENT / "README.md").read_text()
PKG = json.loads((CLIENT / "package.json").read_text())
EDGE_CLIENT_CONFIG = (ROOT / "services" / "edge" / "src" / "clientConfig.ts").read_text()
EDGE_APP = (ROOT / "services" / "edge" / "src" / "app.ts").read_text()
EDGE_CONFIG_TEST = (ROOT / "services" / "edge" / "test" / "clientConfig.test.ts").read_text()
OPENAPI = (ROOT / "docs" / "api" / "openapi.yaml").read_text()
ALLOWLIST = json.loads((ROOT / "docs" / "security" / "sdk-allowlist.json").read_text())

ALL_DEPS = {
    **PKG.get("dependencies", {}),
    **PKG.get("devDependencies", {}),
}


# ---------------------------------------------------------- sha256 support ---

def test_sha256_is_pure_typescript_with_no_dependencies() -> None:
    # Hermes ships no crypto; this module must not import ANY package —
    # that is what keeps the SEC-18 dependency surface flat for TR-31.
    assert not re.search(r'^import ', SHA256_TS, flags=re.M), "sha256.ts must be import-free"
    for symbol in ("export function sha256", "export function hmacSha256",
                   "export function utf8", "export function toHex", "export function fromHex"):
        assert symbol in SHA256_TS


def test_sha256_is_pinned_against_published_vectors() -> None:
    # FIPS "abc" + empty-string vectors and RFC 4231 HMAC cases 1/2, plus a
    # live cross-check against node:crypto in the test suite.
    assert "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" in BLE_TEST
    assert "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" in BLE_TEST
    assert "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7" in BLE_TEST
    assert "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843" in BLE_TEST
    assert 'from "node:crypto"' in BLE_TEST


# ------------------------------------------------------------------- TR-31 ---

def test_ble_codes_rotate_within_the_srs_cap() -> None:
    assert "BLE_ROTATION_PERIOD_S = 900" in BLE_TS
    assert "periodS <= 15 * 60" in BLE_TS
    # Derivation: HMAC-SHA256(session id, domain separator + window index),
    # truncated to 128 bits.
    assert 'CODE_INFO = "presence-ble-v1"' in BLE_TS
    assert "hmacSha256(key, msg)" in BLE_TS
    assert "BLE_CODE_BYTES = 16" in BLE_TS
    assert ".subarray(0, BLE_CODE_BYTES)" in BLE_TS
    assert "Math.floor(atS / BLE_ROTATION_PERIOD_S)" in BLE_TS


def test_ble_advertisement_never_carries_a_stable_identifier() -> None:
    assert "interface BleAdvertisement" in BLE_TS
    assert "readonly code: string" in BLE_TS
    assert "advertisementDiscardsIdentifiers" in BLE_TS
    for forbidden in ("sessionId", "deviceId", "userId"):
        assert f'"{forbidden}"' in BLE_TS
    assert "/^[0-9a-f]{32}$/" in BLE_TS
    # The receiver accepts the current window plus ONE lookback — and the
    # tests prove two windows back and future codes are rejected.
    assert "maxLookbackWindows = 1" in BLE_TS
    assert "codesEqual" in BLE_TS  # length-aware constant-time compare
    assert "2 * BLE_ROTATION_PERIOD_S), false" in BLE_TEST
    assert "A code from the FUTURE never verifies" in BLE_TEST


def test_ble_tests_prove_rotation_and_unlinkability() -> None:
    assert "deriveBleCode(SESSION, 0)" in BLE_TEST
    assert "notEqual(w0, w1)" in BLE_TEST  # codes rotate every window
    assert "notEqual(code, SESSION)" in BLE_TEST  # never the raw session id
    assert "advertisementDiscardsIdentifiers(ad), true" in BLE_TEST
    assert 'Object.keys(ad), ["code"]' in BLE_TEST


# ------------------------------------------------------------------- TR-32 ---

def test_permissions_module_models_the_three_capabilities() -> None:
    assert '"bluetooth" | "location" | "push"' in PERMS_TS
    assert 'CORE_JOURNEY = ["check-in", "discover", "connect", "chat"]' in PERMS_TS
    # The unconditional floors — this is what makes "no dead ends" a
    # construction rather than a hope.
    assert 'presenceModes.push("manual-checkin")' in PERMS_TS
    assert 'matrix.push === "granted" ? "push" : "in-app"' in PERMS_TS
    assert "assertNoDeadEnds" in PERMS_TS
    assert "resolveCapabilities" in PERMS_TS


def test_permissions_tests_cover_every_combination() -> None:
    assert "mask < 8" in PERMS_TEST  # all 2^3 permission combinations
    assert 'profile.presenceModes, ["manual-checkin"]' in PERMS_TEST
    assert 'profile.notificationChannel, "in-app"' in PERMS_TEST
    assert "assertNoDeadEnds(profile), true" in PERMS_TEST
    assert 'journey.connect, ["server-consent"]' in PERMS_TEST
    assert "recovery" in PERMS_TEST


# ------------------------------------------------------------------- TR-33 ---

def test_cert_pinning_module_contract() -> None:
    assert "PINNING_CONFIG_TTL_S = 86_400" in PIN_TS
    assert "PIN_PATTERN = /^[A-Za-z0-9+/]{43}=$/" in PIN_TS
    # Monotonic versions — an older config never overrides a newer one,
    # while a same-version revalidation refreshes the cache window.
    assert "remote.configVersion < appliedVersion" in PIN_TS
    assert "remote.configVersion === appliedVersion" in PIN_TS
    # Fail-open paths: fetch failure and malformed config unpin, never block.
    assert '"fallback-unavailable"' in PIN_TS
    assert '"fallback-invalid"' in PIN_TS
    assert "Enabled with no pins is not a config" in PIN_TS
    assert "pinChainMatches" in PIN_TS


def test_cert_pinning_tests_prove_remote_removal() -> None:
    # The TR-33 acceptance: pinned under v1, unpinned under v2 in the SAME
    # app run — no app update.
    assert "configVersion: 1" in PIN_TEST
    assert "configVersion: 2" in PIN_TEST
    assert "second.pinned, false" in PIN_TEST
    assert "second.appliedVersion, 2" in PIN_TEST
    assert '"stale-refused"' in PIN_TEST
    assert '"fallback-unavailable"' in PIN_TEST
    assert '"fallback-invalid"' in PIN_TEST


def test_edge_serves_the_client_config_unauthenticated() -> None:
    assert "resolveClientConfig" in EDGE_CLIENT_CONFIG
    assert "registerClientConfigRoute" in EDGE_CLIENT_CONFIG
    assert 'app.get(\n    "/v1/client/config"' in EDGE_CLIENT_CONFIG
    assert "CLIENT_TLS_PINS" in EDGE_CLIENT_CONFIG
    assert "CLIENT_CONFIG_VERSION" in EDGE_CLIENT_CONFIG
    # Registered BEFORE the authed scope — no bearer token required.
    register_pos = EDGE_APP.index("registerClientConfigRoute(app)")
    authed_pos = EDGE_APP.index("await app.register(async (authed)")
    assert register_pos < authed_pos
    assert 'import { registerClientConfigRoute } from "./clientConfig.js"' in EDGE_APP


def test_edge_client_config_tests_cover_env_and_route() -> None:
    assert "resolveClientConfig({})" in EDGE_CONFIG_TEST
    assert '" pinA , ,pinB ,"' in EDGE_CONFIG_TEST
    assert 'url: "/v1/client/config"' in EDGE_CONFIG_TEST
    assert "res.statusCode, 200" in EDGE_CONFIG_TEST


# ---------------------------------------------------------------- governance ---

def test_openapi_documents_the_bootstrap_config() -> None:
    assert "/v1/client/config:" in OPENAPI
    assert "Unauthenticated bootstrap config" in OPENAPI
    assert "except the\n    unauthenticated bootstrap config GET /v1/client/config (TR-33)" in OPENAPI
    assert "configVersion: { type: integer, minimum: 1 }" in OPENAPI


def test_no_new_dependencies_were_added() -> None:
    # TR-31's crypto is in-repo pure TS — the SEC-18 allowlist stays at the
    # exact batch-34 set, with no orphans in either direction.
    expected = {
        "expo", "expo-dev-client", "expo-secure-store", "expo-status-bar",
        "h3-js", "react", "react-native",
        "@types/node", "@types/react", "typescript",
        # Batch 66 (AMD-CRT-04): centrifuge admitted through the TECH-16
        # gate — pinned by tests/test_batch66.py.
        "centrifuge",
    }
    assert set(ALL_DEPS) == expected
    assert len(ALLOWLIST["sdks"]) == len(expected)


def test_client_docs_and_app_reflect_the_trust_layer() -> None:
    for module in ("bleCodes.ts", "permissions.ts", "certPinning.ts", "sha256.ts"):
        assert module in CLIENT_README
    assert "GET /v1/client/config" in CLIENT_README
    assert "BLE_ROTATION_PERIOD_S" in APP_TSX
    assert "TR-31" in APP_TSX and "TR-32" in APP_TSX and "TR-33" in APP_TSX


def test_build_config_still_compiles_the_framework_free_modules() -> None:
    build = json.loads((CLIENT / "tsconfig.build.json").read_text())
    assert build["include"] == ["src/presence/**/*.ts", "test/**/*.ts"]
    # The new modules live under src/presence — compiled and tested by the
    # existing client CI job with no config change.
    for module in ("bleCodes.ts", "permissions.ts", "certPinning.ts", "sha256.ts"):
        assert (CLIENT / "src" / "presence" / module).exists()
    for suite in ("bleCodes.test.ts", "permissions.test.ts", "certPinning.test.ts"):
        assert (CLIENT / "test" / suite).exists()
