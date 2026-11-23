#!/usr/bin/env python3
"""SEC-17/BR-03 acceptance criteria: privacy-preserving age assurance.

Pins: the re-verification columns and their declaration CHECK, the
discovery gate closing while the flag stands, the moderation resolve path
setting the flag in the same transaction as an underage/actioned
resolution, the ±1-year consistency + adult-year re-verification rule in
the declaration route, the console card exposing the loop state, and the
repo-wide absence of any identity-document storage.

Behavioural coverage of the decision function lives in
services/edge/test/recovery.test.ts; route/contract coverage is enforced
globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_age_assurance.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0016_age_assurance.sql").read_text()
ACCOUNT = (ROOT / "services/edge/src/routes/account.ts").read_text()
MODERATION = (ROOT / "services/edge/src/routes/moderation.ts").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()


def sql(text: str) -> str:
    """Migration text with line comments stripped."""
    return re.sub(r"--[^\n]*", "", text)


# ------------------------------------------------------------- schema ------

def test_sec17_columns_and_check() -> None:
    m = sql(MIGRATION)
    assert re.search(r"ADD COLUMN age_reverify_required_at timestamptz", m)
    assert re.search(r"ADD COLUMN age_reverified_at\s+timestamptz", m)
    # A flag without a declaration to verify against is a broken state.
    assert re.search(
        r"CHECK \(age_reverify_required_at IS NULL OR birth_year IS NOT NULL\)", m
    )


def test_sec17_grants() -> None:
    assert re.search(
        r"GRANT UPDATE \(age_reverify_required_at, age_reverified_at\) ON users TO presence_app",
        sql(MIGRATION),
    )


def test_sec17_compose_mount() -> None:
    assert (
        "../db/migrations/0016_age_assurance.sql:/docker-entrypoint-initdb.d/18_age_assurance.sql:ro"
        in COMPOSE
    )


# ------------------------------------------------------- discovery gate ----

def test_sec17_flag_closes_discovery() -> None:
    gate = ACCOUNT.split("export async function isDiscoveryAllowed", 1)[1]
    gate = gate.split("\n}\n", 1)[0]
    assert "age_reverify_required_at" in gate
    assert "!r.rows[0].age_reverify_required_at" in gate


# ------------------------------------------------------ moderation side ----

def test_sec17_underage_actioned_sets_flag_in_same_txn() -> None:
    # The flag is written inside the withModerator transaction body of the
    # resolve handler — there is no window between resolution and closure.
    handler = MODERATION.split('"/v1/moderation/reports/:reportId/resolve"', 1)[1]
    handler = handler.split("return reply.send", 1)[0]
    assert 'parsed.value.reasonCode === "underage" && parsed.value.outcome === "actioned"' in handler
    assert re.search(
        r"UPDATE users\s+SET age_reverify_required_at = now\(\)\s+WHERE user_id = \$1 AND age_reverify_required_at IS NULL",
        handler,
    )


def test_sec17_dismissed_reports_do_not_flag() -> None:
    # The only writer of the flag is the underage+actioned branch above.
    writers = re.findall(r"SET age_reverify_required_at = now\(\)", MODERATION)
    assert len(writers) == 1
    assert '"dismissed"' not in MODERATION.split('reasonCode === "underage"', 1)[1][:200]


def test_sec17_console_card_exposes_loop_state() -> None:
    card = MODERATION.split('"/v1/moderation/accounts/:userId"', 1)[1]
    card = card.split('"/v1/moderation/reports/:reportId/resolve"', 1)[0]
    assert "age_reverify_required_at" in card
    assert "ageReverifyRequired" in card
    assert "ageReverifiedAt" in card
    # …but never a birth date or document (none exist — pinned below).
    assert "birthDate" not in card
    assert "idDocument" not in card


# --------------------------------------------------- re-verification -------

def test_sec17_route_branches_on_flag() -> None:
    route = ACCOUNT.split('"/v1/account/age-declaration"', 1)[1]
    route = route.split("app.get(", 1)[0]
    assert "age_reverify_required_at !== null" in route
    assert "reverifyDecision(" in route
    # Success clears the flag, records the verification and unblocks.
    assert re.search(
        r"SET birth_year = \$2, age_declared_at = now\(\), age_blocked = false,\s+"
        r"age_reverify_required_at = NULL, age_reverified_at = now\(\)",
        route,
    )


def test_sec17_consistency_window_is_one_year() -> None:
    assert "export const REVERIFY_CONSISTENCY_YEARS = 1" in ACCOUNT
    assert "Math.abs(newYear - storedYear) > REVERIFY_CONSISTENCY_YEARS" in ACCOUNT
    # Adult-year requirement rides the shared isUnderage boundary rule.
    assert "isUnderage(newYear, refYear)" in ACCOUNT


def test_sec17_failing_checks_share_one_error() -> None:
    fn = ACCOUNT.split("export function reverifyDecision", 1)[1]
    fn = fn.split("\n}\n", 1)[0]
    errors = set(re.findall(r'error: "([^"]+)"', fn))
    assert errors == {"declaration could not be verified"}


def test_sec17_openapi_documents_the_loop() -> None:
    entry = OPENAPI.split("/v1/account/age-declaration:", 1)[1]
    entry = entry.split("\n  /v1/", 1)[0]
    assert "SEC-17" in entry
    assert "±1 year" in entry
    assert "No identity document is collected or stored" in entry


# ---------------------------------------------------- no-ID-storage pin ----

def test_sec17_no_identity_document_storage_repo_wide() -> None:
    """SEC-17: assurance is declaration + consistency — never documents."""
    offenders: list[str] = []
    pattern = re.compile(
        r"\b(passport|id_document|identity_document|document_scan|document_image|"
        r"nin|bvn|driver_licen[cs]e|national_id)\b",
        re.I,
    )
    for glob in ("db/**/*.sql", "services/edge/src/**/*.ts", "deploy/keycloak/*.json"):
        for path in ROOT.glob(glob):
            if pattern.search(path.read_text()):
                offenders.append(str(path.relative_to(ROOT)))
    assert offenders == []
