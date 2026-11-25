"""Batch 55 invariants — core improvements and gap closure (SRS Addendum
001, AMD-PAY-21/22/23 + AMD-OPS-01/02/03):

  AMD-PAY-21  rail risk signals: velocity rules inside the funding and
              withdrawal definers raise append-only, definer-only signals;
              a moderator queue acknowledges or dismisses, audited.
  AMD-PAY-22  webhook freshness: the provider timestamp leads the signed
              string; freshness (300 s) is checked BEFORE the signature;
              every verdict is counted for alerting.
  AMD-PAY-23  four-eyes moderation credits: a manual credit above
              5,000,000 minor opens a pending approval instead of moving
              value; a SECOND moderator executes; self-approval refuses.
  AMD-OPS-01  rail alerting: webhook rejections, rail-unavailable 503s and
              payout definer refusals all alert.
  AMD-OPS-02  restore drill: a weekly CI workflow proves pg_dump →
              pg_restore round-trips through the real compose wiring.
  AMD-OPS-03  every value-touching POST route declares a per-route rate
              limit keyed by the authenticated identity.

The 306-requirement ledger stays untouched; amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / "services/edge"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0029_rail_hardening.sql").read_text()
MIGRATION_0028 = (ROOT / "db/migrations/0028_wallet_activation.sql").read_text()
EDGE_WALLETS = (EDGE / "src/wallets.ts").read_text()
EDGE_ROUTES = (EDGE / "src/routes/wallets.ts").read_text()
EDGE_RAIL = (EDGE / "src/routes/walletRail.ts").read_text()
EDGE_GOV = (EDGE / "src/routes/walletGovernance.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
EDGE_METRICS = (EDGE / "src/metrics.ts").read_text()
EDGE_TEST = (EDGE / "test/wallets.test.ts").read_text()
ALERTS = (ROOT / "deploy/k8s/prometheusrules.yaml").read_text()
RESTORE_DRILL = (ROOT / ".github/workflows/restore-drill.yml").read_text()
UX_DOC = (ROOT / "docs/ux/wallets.md").read_text()
OPS_DOC = (ROOT / "docs/ops/backup-restore.md").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()


# ----------------------------------------------------------- migration ---

def test_rail_risk_signals_table():
    assert "CREATE TABLE rail_risk_signals" in MIGRATION
    for key in ("fund_velocity_1h", "fund_daily_volume", "withdrawal_velocity_1h"):
        assert f"'{key}'" in MIGRATION
    assert "'open', 'acknowledged', 'dismissed'" in MIGRATION
    assert "ALTER TABLE rail_risk_signals ENABLE ROW LEVEL SECURITY;" in MIGRATION
    # Definer-only: no application-role grant on the table itself.
    assert not re.search(r"GRANT .*ON rail_risk_signals", MIGRATION)


def test_rail_risk_signals_guard_messages():
    assert "rail_risk_signals is append-only (AMD-PAY-21)" in MIGRATION
    assert "risk signal terms are immutable (AMD-PAY-21)" in MIGRATION
    assert "illegal risk signal transition (AMD-PAY-21)" in MIGRATION


def test_credit_approvals_table():
    assert "CREATE TABLE wallet_credit_approvals" in MIGRATION
    assert "amount_minor bigint NOT NULL CHECK (amount_minor > 5000000)" in MIGRATION
    assert "'pending', 'approved', 'rejected'" in MIGRATION
    assert "ALTER TABLE wallet_credit_approvals ENABLE ROW LEVEL SECURITY;" in MIGRATION
    assert not re.search(r"GRANT.*ON wallet_credit_approvals", MIGRATION)
    assert "wallet_credit_approvals is append-only (AMD-PAY-23)" in MIGRATION
    assert "credit approval terms are immutable (AMD-PAY-23)" in MIGRATION
    assert "illegal credit approval transition (AMD-PAY-23)" in MIGRATION


def test_fund_wallet_keeps_0028_gates_and_gains_four_eyes():
    # Every 0028 gate survives the CREATE OR REPLACE verbatim.
    assert "current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'" in MIGRATION
    assert "current_setting('app.funding_callback', true) IS DISTINCT FROM 'on'" in MIGRATION
    assert "p_amount_minor > 15000000" in MIGRATION
    assert "char_length(p_reference) NOT BETWEEN 8 AND 128" in MIGRATION
    assert "'duplicate_reference'" in MIGRATION
    # The four-eyes branch: moderator path above the threshold opens an
    # approval and answers 'approval_required' — value has not moved.
    assert "p_amount_minor > 5000000 THEN" in MIGRATION
    assert "INSERT INTO wallet_credit_approvals (wallet_id, amount_minor, reference, proposed_by)" in MIGRATION
    assert "'approval_required'" in MIGRATION
    assert "'approval_proposed'" in MIGRATION
    # The 0028 body stays byte-identical in its own file (forward-only).
    assert "'approval_required'" not in MIGRATION_0028


def test_velocity_signals_raise_inside_the_definers():
    # Funding velocity: >5 events/hour, >30,000,000 minor/day, deduped
    # against open signals.
    assert MIGRATION.count("'fund_velocity_1h'") >= 3  # CHECK + insert + test context
    assert "now() - interval '1 hour') > 5" in MIGRATION
    assert "now() - interval '24 hours') > 30000000" in MIGRATION
    assert "now() - interval '1 hour') > 3" in MIGRATION  # withdrawals
    # Signals never block: no RETURN of a refusal follows a signal insert.
    for m in re.finditer(r"INSERT INTO rail_risk_signals[^;]*;", MIGRATION):
        tail = MIGRATION[m.end():m.end() + 400]
        assert "RETURN QUERY SELECT 'forbidden'" not in tail


def test_approve_wallet_credit_is_four_eyes():
    assert "CREATE OR REPLACE FUNCTION approve_wallet_credit(p_approval uuid)" in MIGRATION
    assert "app_user() IS NOT DISTINCT FROM a.proposed_by" in MIGRATION
    assert "'self_approval'" in MIGRATION
    assert "'approval_executed'" in MIGRATION
    # Execution lands through the standard funding path.
    assert "INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)\n    VALUES (a.wallet_id, 'fund', a.amount_minor, v_balance);" in MIGRATION
    assert "VALUES (a.reference, 'fund', a.wallet_id, a.amount_minor, 'funded');" in MIGRATION
    # The rail gate stands on the executor.
    assert MIGRATION.count("app.transfer_settlement") >= 3


def test_review_queues_are_moderator_gated():
    for definer in ("list_rail_risk_signals()", "ack_rail_risk_signal(p_signal uuid, p_decision text)",
                    "list_credit_approvals()", "reject_wallet_credit(p_approval uuid)"):
        assert definer in MIGRATION
    assert MIGRATION.count("IF NOT app_moderator() THEN") >= 4
    assert "'wallet.risk_signal'" in MIGRATION
    assert "ack_rail_risk_signal(uuid, text) TO presence_app;" in MIGRATION
    assert "approve_wallet_credit(uuid) TO presence_app;" in MIGRATION


def test_reconciliation_gains_the_governance_queues():
    assert "CREATE OR REPLACE FUNCTION wallet_reconciliation()" in MIGRATION
    # The five 0028 keys survive verbatim…
    for key in ("walletsChecked", "balanceMismatches", "platformFeeDelta", "stuckHolds", "openWithdrawals"):
        assert f"'{key}'" in MIGRATION
    # …plus the two governance keys.
    assert "'openRiskSignals'" in MIGRATION
    assert "'pendingCreditApprovals'" in MIGRATION


def test_dsar_unchanged_by_signals_and_approvals():
    # Internal risk data is not exported: the 0028 export body stands and
    # 0029 never touches dsar_export.
    assert "dsar_export" not in MIGRATION


# ------------------------------------------------------------- edge TS ---

def test_webhook_freshness_pinned():
    assert "RAIL_SIGNATURE_SKEW_S = 300" in EDGE_WALLETS
    assert "parseRailTimestamp" in EDGE_WALLETS
    assert "`${at}:${walletId}:${amountMinor}:${reference}`" in EDGE_WALLETS
    assert "`${at}:${requestId}:${outcome}:${reference}`" in EDGE_WALLETS
    # Freshness is checked BEFORE the signature on both webhooks.
    assert EDGE_RAIL.count('"x-wallet-timestamp"') >= 2
    assert EDGE_RAIL.count("stale or missing timestamp (AMD-PAY-22)") == 2
    for m in re.finditer(r"timestampFresh\(req\.headers", EDGE_RAIL):
        window = EDGE_RAIL[m.start():m.start() + 700]
        assert "signatureValid(" in window  # the signature check comes after


def test_webhook_results_metric():
    assert "walletWebhookResults" in EDGE_METRICS
    assert "presence_wallet_webhook_results_total" in EDGE_METRICS
    assert EDGE_RAIL.count("walletWebhookResults().inc") >= 8
    assert 'result: "accepted"' in EDGE_RAIL
    assert 'result: "rejected"' in EDGE_RAIL


def test_credit_route_handles_approval_required():
    assert 'approval_id AS "approvalId"' in EDGE_ROUTES
    assert 'out.outcome === "approval_required"' in EDGE_ROUTES
    assert "reply.code(202).send({ walletId, approvalId: out.approvalId })" in EDGE_ROUTES


def test_governance_routes():
    assert '"/v1/moderation/rail-risk-signals"' in EDGE_GOV
    assert '"/v1/moderation/rail-risk-signals/:signalId/ack"' in EDGE_GOV
    assert '"/v1/moderation/credit-approvals"' in EDGE_GOV
    assert '"/v1/moderation/credit-approvals/:approvalId/approve"' in EDGE_GOV
    assert '"/v1/moderation/credit-approvals/:approvalId/reject"' in EDGE_GOV
    assert EDGE_GOV.count("preHandler: requireModerator") == 5
    assert "FROM list_rail_risk_signals()" in EDGE_GOV
    assert "ack_rail_risk_signal($1, $2)" in EDGE_GOV
    assert "FROM list_credit_approvals()" in EDGE_GOV
    assert "FROM approve_wallet_credit($1)" in EDGE_GOV
    assert "reject_wallet_credit($1)" in EDGE_GOV
    # The approve route is the only value mover and runs under
    # withSettlement; the kill switch answers 503.
    assert EDGE_GOV.count("withSettlement(") == 1
    assert '"app.moderator"' in EDGE_GOV
    assert "WalletRailUnavailable" in EDGE_GOV
    # Strict empty body on the value-moving and reject routes.
    assert EDGE_GOV.count("parseEmptyBody(") == 2
    # Registration: inside the authed scope, after the wallet routes.
    assert 'import { registerWalletGovernanceRoutes } from "./routes/walletGovernance.js";' in EDGE_APP
    assert "registerWalletGovernanceRoutes(authed, ctx);" in EDGE_APP
    assert EDGE_APP.index("registerWalletRoutes(authed, ctx);") < EDGE_APP.index(
        "registerWalletGovernanceRoutes(authed, ctx);"
    )


def test_amd_ops_03_every_value_post_declares_a_rate_limit():
    """AMD-OPS-03: every POST in the wallet route files declares
    config.rateLimit — the global limiter stays off, so an undeclared
    POST is an unlimited POST."""
    for name, source in (
        ("wallets.ts", EDGE_ROUTES),
        ("walletRail.ts", EDGE_RAIL),
        ("walletGovernance.ts", EDGE_GOV),
    ):
        posts = list(re.finditer(r"app\.post\(", source))
        assert posts, name
        for m in posts:
            window = source[m.start():m.start() + 900]
            assert "rateLimit" in window, f"{name}: POST at offset {m.start()} declares no rate limit"
    # The limiter keys on the authenticated identity.
    assert 'keyGenerator: (req: { userId: string }) => req.userId' in EDGE_ROUTES
    assert 'keyGenerator: (req: { userId: string }) => req.userId' in EDGE_GOV


# ----------------------------------------------------------------- ops ---

def test_amd_ops_01_alerts():
    for alert in ("PresenceWalletWebhookRejections", "PresenceWalletRailUnavailable",
                  "PresenceWalletPayoutFailures"):
        assert f"- alert: {alert}" in ALERTS
    assert "presence_wallet_webhook_results_total" in ALERTS
    assert ALERTS.count("owner: payments-oncall") >= 3


def test_amd_ops_02_restore_drill():
    assert "name: restore-drill" in RESTORE_DRILL
    assert "workflow_dispatch" in RESTORE_DRILL
    assert re.search(r"cron: \"[^\"]+\"", RESTORE_DRILL)
    # The drill boots through the real compose wiring — no duplicated
    # mount list to drift.
    assert "docker compose -f deploy/docker-compose.yml up -d --build postgres" in RESTORE_DRILL
    assert "pg_dump" in RESTORE_DRILL
    assert "ON_ERROR_STOP=1" in RESTORE_DRILL
    assert "00000000-0000-0000-0000-00000000fee1" in RESTORE_DRILL


def test_migration_is_mounted():
    assert "0029_rail_hardening.sql:/docker-entrypoint-initdb.d/31_rail_hardening.sql:ro" in COMPOSE
    assert "--from-file=31_rail_hardening.sql=db/migrations/0029_rail_hardening.sql" in K8S_README


# ---------------------------------------------------------------- docs ---

def test_addendum_carries_the_amendments():
    for anchor in (
        "AMD-PAY-21 (rail risk signals)",
        "AMD-PAY-22 (webhook freshness)",
        "AMD-PAY-23 (four-eyes moderation credits)",
        "AMD-OPS-01 (rail alerting)",
        "AMD-OPS-02 (restore drill)",
        "AMD-OPS-03 (rate limits on value routes)",
    ):
        assert anchor in ADDENDUM
    # AMD-PAY-16/17 carry the freshness amendment.
    assert "outside the freshness window is refused before the signature is even checked" in ADDENDUM
    assert "signed-timestamp freshness discipline as funding callbacks (AMD-PAY-22)" in ADDENDUM
    # The verification footer names this file.
    assert "tests/test_batch55.py" in ADDENDUM


def test_docs_and_openapi_cover_the_governance_surface():
    assert "rail_risk_signals` (migration 0029)" in UX_DOC
    assert "wallet_credit_approvals` (migration 0029)" in UX_DOC
    assert "restore-drill.yml` (AMD-OPS-02)" in UX_DOC
    assert "AMD-OPS-02" in OPS_DOC
    for path in (
        "/v1/moderation/rail-risk-signals:",
        "/v1/moderation/rail-risk-signals/{signalId}/ack:",
        "/v1/moderation/credit-approvals:",
        "/v1/moderation/credit-approvals/{approvalId}/approve:",
        "/v1/moderation/credit-approvals/{approvalId}/reject:",
    ):
        assert path in OPENAPI
    assert "x-wallet-timestamp" in OPENAPI
    # Every new governance POST carries the idempotency key.
    for section_start, section_end in (
        ("/v1/moderation/rail-risk-signals/{signalId}/ack:", "/v1/moderation/credit-approvals:"),
        ("/v1/moderation/credit-approvals/{approvalId}/approve:", "/v1/moderation/credit-approvals/{approvalId}/reject:"),
        ("/v1/moderation/credit-approvals/{approvalId}/reject:", "/v1/moderation/withdrawals/{requestId}/decide:"),
    ):
        section = OPENAPI[OPENAPI.index(section_start):OPENAPI.index(section_end)]
        assert "IdempotencyKey" in section, section_start
    # The credit route documents the 202.
    assert '"202": { description: Above the four-eyes threshold' in OPENAPI


def test_edge_tests_cover_the_new_validators():
    for anchor in (
        "AMD-PAY-22: the freshness window and timestamp parser are pinned",
        "AMD-PAY-21: signal vocabularies and the ack decision parser are pinned",
        "AMD-PAY-23: the four-eyes threshold and empty-body parser are pinned",
        "parseSignalDecision",
        "parseEmptyBody",
        "parseRailTimestamp",
        '"1764100000:11111111-2222-4333-8444-555555555555:2500000:PSP_fund_01234567"',
    ):
        assert anchor in EDGE_TEST, anchor
