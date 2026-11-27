#!/usr/bin/env python3
"""SEC-09 acceptance criteria: recovery phone stored as a keyed hash only.

Pins: the recovery_phones schema (keyed-hash column, no plaintext column),
the platform-wide unique index on the hash, owner-only RLS with no console
read path, the edge HMAC construction and E.164 normalisation contract, the
neutral 422 shared by malformed and unavailable numbers, the GET route that
returns existence only, the env wiring for the HMAC key in compose and K8s,
and the absence of any plaintext-phone storage anywhere in the repo.

Behavioural coverage of the lib lives in services/edge/test/recovery.test.ts;
route/contract coverage is enforced globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_recovery.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0015_recovery.sql").read_text()
LIB = (ROOT / "services/edge/src/recovery.ts").read_text()
ROUTE = (ROOT / "services/edge/src/routes/recovery.ts").read_text()
APP = (ROOT / "services/edge/src/app.ts").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_EDGE = (ROOT / "deploy/k8s/edge.yaml").read_text()
KC_README = (ROOT / "deploy/keycloak/README.md").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()


def sql(text: str) -> str:
    """Migration text with line comments stripped."""
    return re.sub(r"--[^\n]*", "", text)


# ------------------------------------------------------------- schema ------

def test_sec09_table_shape() -> None:
    m = sql(MIGRATION)
    assert re.search(r"CREATE TABLE recovery_phones \(", m)
    assert re.search(r"user_id\s+uuid PRIMARY KEY REFERENCES users \(user_id\)", m)
    assert re.search(r"phone_hash\s+text NOT NULL", m)


def test_sec09_no_plaintext_column() -> None:
    # The only phone-shaped column is the hash.
    cols = re.findall(r"^\s+(\w+)\s+(?:text|uuid|timestamptz|smallint)", sql(MIGRATION), re.M)
    assert "phone_hash" in cols
    assert "phone" not in cols
    assert "phone_number" not in cols
    assert "phone_e164" not in cols


def test_sec09_hash_unique_platform_wide() -> None:
    assert re.search(
        r"CREATE UNIQUE INDEX recovery_phones_hash_key ON recovery_phones \(phone_hash\)",
        sql(MIGRATION),
    )


def test_sec09_owner_only_rls() -> None:
    m = sql(MIGRATION)
    assert "ALTER TABLE recovery_phones ENABLE ROW LEVEL SECURITY" in m
    for verb in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert re.search(
            rf"CREATE POLICY recovery_phones_own_{verb.lower()} ON recovery_phones\s+FOR {verb}",
            m,
        ), verb
    # No moderator/taxonomist/analyst read path: the console has no use for
    # an HMAC it cannot invert, so it gets no policy at all.
    assert "app_moderator" not in m
    assert "app_taxonomist" not in m
    assert "app_analyst" not in m


def test_sec09_grants() -> None:
    m = sql(MIGRATION)
    assert "GRANT SELECT, INSERT, DELETE ON recovery_phones TO presence_app" in m
    assert re.search(r"GRANT UPDATE \(phone_hash, updated_at\) ON recovery_phones", m)


def test_sec09_compose_mount() -> None:
    assert (
        "../db/migrations/0015_recovery.sql:/docker-entrypoint-initdb.d/17_recovery.sql:ro"
        in COMPOSE
    )


# ------------------------------------------------------------ edge lib -----

def test_sec09_hmac_keyed_hash() -> None:
    assert 'createHmac("sha256"' in LIB
    assert "process.env.RECOVERY_HASH_KEY" in LIB
    assert '.digest("hex")' in LIB


def test_sec09_e164_normalisation_before_hash() -> None:
    assert re.search(r"export const E164_PATTERN = /\^\\\+\[1-9\]\\d\{6,14\}\$/", LIB)
    # The route hashes the normalised form, never the raw body string.
    assert "recoveryPhoneHash(parsed.e164)" in ROUTE
    assert "recoveryPhoneHash(req.body" not in ROUTE


def test_sec09_dev_key_is_clearly_marked() -> None:
    assert "p0-dev-recovery-key-change-me" in LIB
    assert "RECOVERY_HASH_KEY: p0-dev-recovery-key-change-me" in COMPOSE
    # K8s reads the key from the managed secret, never a literal.
    assert re.search(
        r"name: RECOVERY_HASH_KEY[^\n]*\n\s*valueFrom: \{ secretKeyRef: \{ name: presence-secrets, key: RECOVERY_HASH_KEY \} \}",
        K8S_EDGE,
    )
    assert "p0-dev-recovery-key" not in K8S_EDGE


# ------------------------------------------------------------- route -------

def test_sec09_neutral_rejection_for_collisions() -> None:
    # Malformed input and a number already bound to another account share
    # one error string — probing learns nothing.
    assert 'const NEUTRAL_ERROR = "phone number is not accepted"' in ROUTE
    assert ROUTE.count("NEUTRAL_ERROR") >= 3  # definition + both rejection paths
    assert '.code === "23505"' in ROUTE


def test_sec09_get_returns_existence_only() -> None:
    get_block = ROUTE.split('app.get("/v1/account/recovery-phone"', 1)[1]
    assert "SELECT 1 FROM recovery_phones" in get_block
    assert "phone_hash" not in get_block
    assert re.search(r"reply\.send\(\{ set: [^}]+ \}\)", get_block)


def test_sec09_delete_is_owner_scoped_and_idempotent() -> None:
    delete_block = ROUTE.split('app.delete("/v1/account/recovery-phone"', 1)[1]
    assert "DELETE FROM recovery_phones WHERE user_id = app_user()" in delete_block
    assert "reply.send({ ok: true, set: false })" in delete_block


def test_sec09_all_reads_writes_under_rls() -> None:
    assert ROUTE.count("withRls(ctx.pg, req.userId") == 3


def test_sec09_routes_registered() -> None:
    assert 'import { registerRecoveryRoutes } from "./routes/recovery.js";' in APP
    assert "registerRecoveryRoutes(authed, ctx);" in APP


def test_sec09_openapi_paths() -> None:
    assert "/v1/account/recovery-phone:" in OPENAPI
    assert "keyed hash" in OPENAPI


# --------------------------------------------------- no plaintext anywhere -

def test_sec09_no_plaintext_phone_storage_repo_wide() -> None:
    """No migration, seed or realm export may carry a plaintext phone column.

    One pinned exception (AMD-WA-03, batch 69): the phone_e164 columns in
    0039_whatsapp.sql. A WhatsApp DELIVERY address cannot be keyed-hash
    stored — Meta's Cloud API routes on the digits, so unlike the SEC-09
    recovery factor (verify-only, hashable) the channel phone must be
    retrievable to be sent to. Its exposure is bounded by construction:
    member-supplied and opt-in, RLS select-own on the opt-in row with the
    inbound ledger definer-only, masked in every projection and log,
    ON DELETE CASCADE with the account, and exported in full only in the
    member's own DSAR export. Any OTHER plaintext phone column still
    fails this test.
    """
    offenders: list[str] = []
    for pattern in ("db/**/*.sql", "deploy/keycloak/*.json"):
        for path in ROOT.glob(pattern):
            rel = str(path.relative_to(ROOT))
            if rel == "db/migrations/0039_whatsapp.sql":
                continue  # the pinned AMD-WA-03 exception above
            text = path.read_text().lower()
            if re.search(r"\bphone(?!_hash)\w*\s+(text|varchar|character varying)", text):
                offenders.append(rel)
            if re.search(r'"phone(number)?"\s*:', text) and "attributes" in text:
                offenders.append(rel)
    assert offenders == []


def test_sec09_keycloak_readme_records_the_method() -> None:
    assert "recovery_phones" in KC_README
    assert "keyed hash" in KC_README
