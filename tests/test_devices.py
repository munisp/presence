#!/usr/bin/env python3
"""FR-05/FR-07 acceptance criteria for devices and attestation dedupe.

Pins: the three-device cap enforced by trigger under a row lock (not by
application code), the refresh exemption so a re-enrolment of a live
fingerprint is never cap-blocked, the partial unique index that keeps one
active row per fingerprint platform-wide, the SECURITY DEFINER dedupe
function with its silent duplicate branch (record + audit, neutral client
response), the moderation-only RLS on the registry, the enrolment notice
that carries no fingerprint, and console surfacing of duplicates on the
account card.

Behavioural coverage of the lib lives in services/edge/test/devices.test.ts;
route/contract coverage is enforced globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_devices.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0010_devices.sql").read_text()
LIB = (ROOT / "services/edge/src/devices.ts").read_text()
ROUTE = (ROOT / "services/edge/src/routes/devices.ts").read_text()
MODERATION = (ROOT / "services/edge/src/routes/moderation.ts").read_text()
APP = (ROOT / "services/edge/src/app.ts").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()


def sql(text: str) -> str:
    """Migration text with line comments stripped."""
    return re.sub(r"--[^\n]*", "", text)


# ------------------------------------------------------------ FR-05 --------

def test_fr05_device_table_and_cap_constant() -> None:
    assert "CREATE TABLE devices" in MIGRATION
    assert re.search(r"IF n >= 3 THEN", MIGRATION), "the cap lives in the trigger"
    assert re.search(r"DEVICE_LIMIT = 3", LIB)


def test_fr05_cap_enforced_under_row_lock() -> None:
    trigger = MIGRATION.split("FUNCTION device_cap()")[1].split("END $$;")[0]
    assert "FOR UPDATE" in trigger, "cap check must lock the user row (SEC-33 idiom)"
    assert "RAISE EXCEPTION 'device limit reached (FR-05)'" in trigger


def test_fr05_refresh_is_not_cap_blocked() -> None:
    trigger = MIGRATION.split("FUNCTION device_cap()")[1].split("END $$;")[0]
    assert "key_fingerprint <> NEW.key_fingerprint" in trigger, (
        "re-enrolling a live fingerprint is a refresh, not a fourth device"
    )


def test_fr05_one_active_row_per_fingerprint() -> None:
    assert re.search(
        r"CREATE UNIQUE INDEX devices_active_fingerprint\s+ON devices \(key_fingerprint\) WHERE revoked_at IS NULL",
        MIGRATION,
    )
    insert = ROUTE.split("INSERT INTO devices")[1].split("RETURNING")[0]
    assert "ON CONFLICT (key_fingerprint) WHERE revoked_at IS NULL" in insert
    assert "DO UPDATE SET last_seen_at = now()" in insert


def test_fr05_cap_violation_maps_to_409() -> None:
    assert 'e.message.includes("device limit reached")' in ROUTE
    assert 'reply.code(409).send({ error: "device limit reached; revoke a device first (FR-05)" })' in ROUTE


def test_fr05_revocation_is_idempotent_and_own_rows_only() -> None:
    delete = ROUTE.split('"/v1/devices/:deviceId"')[1]
    assert "revoked_at = now()" in delete
    assert "revoked_at IS NULL" in delete, "second revoke is a no-op"
    assert "user_id = $2" in delete, "revocation is scoped to the caller"


def test_fr05_enrolment_notice_carries_no_fingerprint() -> None:
    # FR-58: the notice is an own-account safety event through notifyUser —
    # always delivered; the payload still carries no fingerprint material.
    publish = ROUTE.split('notifyUser(ctx, userId, "safety"')[1].split(").catch")[0]
    assert '"device_enrolled"' in publish
    assert "fingerprint" not in publish
    assert "keyHash" not in publish


def test_fr05_enrolment_requires_attestation() -> None:
    post = ROUTE.split('"/v1/devices"')[1].split("app.get(")[0]
    assert 'req.headers["x-app-attest-assertion"]' in post
    assert 'reply.code(401).send({ error: "missing app attestation" })' in post


# ------------------------------------------------------------ FR-07 --------

def test_fr07_registry_is_written_through_one_function() -> None:
    assert "CREATE OR REPLACE FUNCTION register_attestation_key(p_key_hash text, p_user uuid)" in MIGRATION
    assert "SECURITY DEFINER" in MIGRATION
    assert "GRANT EXECUTE ON FUNCTION register_attestation_key(text, uuid) TO presence_app" in MIGRATION
    assert "SELECT register_attestation_key($1, $2::uuid)" in ROUTE


def test_fr07_duplicate_branch_records_and_audits() -> None:
    fn = MIGRATION.split("FUNCTION register_attestation_key")[1].split("END $$;")[0]
    assert "INSERT INTO attestation_duplicates" in fn
    assert "'moderation.duplicate.detected'" in fn
    assert "'impersonation'" in fn
    assert "RETURN 'duplicate'" in fn
    # The key never moves to the incoming account.
    update = re.findall(r"UPDATE attestation_keys[^;]*;", fn)
    assert len(update) == 1 and "last_seen_at" in update[0] and "user_id" not in update[0]


def test_fr07_outcome_never_leaves_the_server() -> None:
    post = ROUTE.split('"/v1/devices"')[1].split("app.get(")[0]
    assert "reply.code(201)" in post
    # The registration outcome may be consumed server-side — batch 24 records
    # a duplicate into security_audit (SEC-30) — but the client response is
    # always the same neutral 201 and never references the outcome.
    for line in post.splitlines():
        if "reply." in line:
            assert "outcome" not in line and "duplicate" not in line and "refreshed" not in line
        if '"duplicate"' in line or '"refreshed"' in line:
            assert "recordSecurityEvent" in line or "outcome ===" in line, (
                "the outcome may only feed the server-side SEC-30 audit record"
            )


def test_fr07_registry_is_console_only() -> None:
    assert "CREATE POLICY attestation_keys_moderation ON attestation_keys" in MIGRATION
    assert "CREATE POLICY attestation_duplicates_moderation ON attestation_duplicates" in MIGRATION
    plain = sql(MIGRATION)
    assert not re.search(
        r"CREATE POLICY \w+ ON attestation_keys\s+FOR SELECT USING \(user_id = app_user\(\)\)", plain
    ), "consumers must never read the registry"
    # Only SELECT is granted on the registry; writes go through the function.
    grants = re.findall(r"GRANT (\w+(?:, \w+)*) ON attestation_keys TO presence_app", MIGRATION)
    assert grants == ["SELECT"]


def test_fr07_surfaces_on_the_moderation_account_card() -> None:
    card = MODERATION.split('"/v1/moderation/accounts/:userId"')[1].split("app.post(")[0]
    assert "FROM attestation_duplicates" in card
    assert "existing_user = $1 OR incoming_user = $1" in card
    assert "attestationDuplicates" in card
    assert "keyHashPrefix" in card, "the console sees a prefix, never the full hash"
    assert "key_hash," not in card.split("reply.send")[1], "full hash must not be serialised"


# ------------------------------------------------------------ wiring -------

def test_devices_routes_registered() -> None:
    assert 'import { registerDeviceRoutes } from "./routes/devices.js";' in APP
    assert "registerDeviceRoutes(authed, ctx);" in APP


def test_openapi_documents_device_paths() -> None:
    assert "/v1/devices:" in OPENAPI
    assert "/v1/devices/{deviceId}:" in OPENAPI
    post = OPENAPI.split("/v1/devices:")[1].split("/v1/devices/{deviceId}:")[0]
    assert "x-app-attest-assertion" in post
    assert "Enrol a device (FR-05, FR-07, FR-51/SEC-19)" in post
