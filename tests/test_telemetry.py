#!/usr/bin/env python3
"""NFR-32/TR-34 acceptance criteria for product telemetry.

Pins: the governed event keys enforced by a DB CHECK; the four §2.5 metric
keys; synchronous in-request writes (no queue, no batch — the five-minute
computability budget is met by construction); the privacy shape (aggregate
dims only — no user ids, pair ids or cells anywhere in the telemetry path);
the versioned CSV contract (version line + stable columns); the analyst
console gating (workforce role + GUC + RLS, mirroring moderation/taxonomy);
every funnel emission point wired; and the deploy wiring.

Behavioural coverage lives in services/edge/test/telemetry.test.ts;
route/contract coverage is enforced globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_telemetry.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0013_telemetry.sql").read_text()
LIB = (ROOT / "services/edge/src/telemetry.ts").read_text()
ROUTE = (ROOT / "services/edge/src/routes/telemetry.ts").read_text()
SCAN = (ROOT / "services/edge/src/routes/scan.ts").read_text()
CONSENT = (ROOT / "services/edge/src/routes/consent.ts").read_text()
MESSAGES = (ROOT / "services/edge/src/routes/messages.ts").read_text()
AUTH = (ROOT / "services/edge/src/auth.ts").read_text()
APP = (ROOT / "services/edge/src/app.ts").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
REALM = (ROOT / "deploy/keycloak/realm-workforce.json").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()


# ------------------------------------------------------------ TR-34 --------

def test_tr34_event_keys_match_db_check() -> None:
    db_keys = re.findall(r"'([a-z._]+)'", MIGRATION.split("CHECK (event_key IN (")[1].split("))")[0])
    ts_keys = re.findall(r'"([a-z._]+)"', LIB.split("TELEMETRY_EVENT_KEYS = [")[1].split("] as const")[0])
    assert db_keys == ts_keys == ["scan.completed", "consent.transitioned", "pair.first_message"]


def test_tr34_versioned_csv_contract() -> None:
    assert 'TELEMETRY_CSV_VERSION = "presence-telemetry/v1"' in LIB
    cols = LIB.split("TELEMETRY_CSV_COLUMNS = [")[1].split("] as const")[0]
    assert re.findall(r'"(\w+)"', cols) == [
        "metric_key", "window_start", "window_end", "value", "numerator", "denominator",
    ]
    assert '`# ${TELEMETRY_CSV_VERSION}`' in LIB
    csv_block = OPENAPI.split("/v1/telemetry/export.csv:")[1].split("/v1/venues/")[0]
    assert "presence-telemetry/v1" in csv_block


def test_tr34_stable_metric_keys() -> None:
    keys = re.findall(r'"([a-z._]+)"', LIB.split("PRODUCT_METRIC_KEYS = [")[1].split("] as const")[0])
    assert keys == ["scan.surfaced_rate", "surfacing.express_rate", "mutual.open_rate", "open.first_message_rate"]


# ------------------------------------------------------------ NFR-32 --------

def test_nfr32_writes_are_synchronous_never_queued() -> None:
    record = LIB.split("export function recordTelemetry")[1].split("export interface")[0]
    assert "ctx.pg" in record and ".query(" in record, "direct write in the causing request"
    assert "queue" not in record.lower() and "batch" not in record.lower() and "setInterval" not in LIB
    assert ".catch(" in record, "telemetry never fails a user request"


def test_nfr32_metrics_computed_from_events_with_freshness_evidence() -> None:
    assert "FROM telemetry_events" in LIB
    assert "max(occurred_at)" in LIB
    assert "newestEventAgeSeconds" in ROUTE


def test_nfr32_zero_denominator_is_null_not_fake_zero() -> None:
    assert "denominator === 0 ? null : numerator / denominator" in LIB


def test_nfr32_privacy_shape_aggregate_dims_only() -> None:
    emissions = re.findall(r'recordTelemetry\(ctx, "([a-z._]+)"(?:, \{[^}]*\})?\)', SCAN + CONSENT + MESSAGES)
    assert len(emissions) >= 6, f"expected emissions at every funnel point, found {emissions}"
    payloads = re.findall(r'recordTelemetry\(ctx, "[a-z._]+", \{([^}]*)\}\)', SCAN + CONSENT + MESSAGES)
    for payload in payloads:
        assert "userId" not in payload and "pairId" not in payload and "cell" not in payload, payload
    # The migration forbids free-form columns; dims is the only payload.
    assert re.search(r"dims\s+jsonb NOT NULL DEFAULT '\{\}'", MIGRATION)
    for forbidden in ("user_id", "pair_id", "h3", "cell"):
        assert not re.search(rf"\b{forbidden}\b", MIGRATION.split("dims")[0].split("CREATE TABLE telemetry_events")[1]), forbidden


def test_nfr32_emission_points_cover_the_funnel() -> None:
    assert 'recordTelemetry(ctx, "scan.completed", { band: budget.band, surfaced: detected.length })' in SCAN
    assert 'recordTelemetry(ctx, "consent.transitioned", { to: "DETECTED" })' in SCAN
    assert 'recordTelemetry(ctx, "consent.transitioned", { to: state.to })' in CONSENT
    assert 'recordTelemetry(ctx, "consent.transitioned", { to: "NUDGED" })' in CONSENT
    assert 'recordTelemetry(ctx, "consent.transitioned", { to: "OPEN" })' in CONSENT
    assert 'recordTelemetry(ctx, "pair.first_message")' in MESSAGES
    assert "pairPrior" in MESSAGES, "first message is pair-level, not sender-level"


# ------------------------------------------------------------ console -------

def test_analyst_console_gating() -> None:
    assert "export async function requireAnalyst" in AUTH
    assert 'requireWorkforceRole(req, reply, "analyst")' in AUTH
    assert 'withGuc(pool, "app.analyst", fn)' in AUTH
    assert "CREATE OR REPLACE FUNCTION app_analyst()" in MIGRATION
    assert "FOR SELECT USING (app_analyst())" in MIGRATION
    assert '"name": "analyst"' in REALM
    assert ROUTE.count("preHandler: requireAnalyst") == 2


def test_telemetry_routes_registered() -> None:
    assert 'import { registerTelemetryRoutes } from "./routes/telemetry.js";' in APP
    assert "registerTelemetryRoutes(authed, ctx);" in APP


def test_openapi_documents_telemetry() -> None:
    assert "/v1/telemetry/metrics:" in OPENAPI
    assert "/v1/telemetry/export.csv:" in OPENAPI


def test_deploy_mounts_telemetry_migration() -> None:
    assert "15_telemetry.sql" in COMPOSE and "0013_telemetry.sql" in COMPOSE
    assert "15_telemetry.sql=db/migrations/0013_telemetry.sql" in K8S_README
