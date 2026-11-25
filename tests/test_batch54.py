"""Batch 54 invariants — wallet rail activation (SRS Addendum 001,
AMD-PAY-15..20): the internal NGN ledger rail is live. Value enters only
through an authenticated rail (HMAC-signed provider callback or audited
moderation credit), withdrawals are hold-backed and two-phase with the
AMD-PAY-05 caps, transfer acceptance settles atomically, and a
moderator-only reconciliation definer proves the ledger. The AMD-PAY-02
gate is not deleted — it is re-scoped: it now covers only the external
Mojaloop/TigerBeetle rails, while the internal rail answers to the
WALLET_RAIL operational kill switch plus the unchanged definer-level GUC
gate (defence in depth).

The 306-requirement ledger stays untouched: amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md, so the traceability counts
stay 234/6/0.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "client"
EDGE = ROOT / "services/edge"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0028_wallet_activation.sql").read_text()
MIGRATION_0003 = (ROOT / "db/migrations/0003_account_deletion.sql").read_text()
MIGRATION_0027 = (ROOT / "db/migrations/0027_wallets.sql").read_text()
ALL_MIGRATIONS = "\n".join(
    p.read_text() for p in sorted((ROOT / "db/migrations").glob("*.sql"))
)
EDGE_WALLETS = (EDGE / "src/wallets.ts").read_text()
EDGE_AUTH = (EDGE / "src/auth.ts").read_text()
EDGE_ROUTES = (EDGE / "src/routes/wallets.ts").read_text()
EDGE_RAIL = (EDGE / "src/routes/walletRail.ts").read_text()
EDGE_TRANSFERS = (EDGE / "src/routes/transfers.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
EDGE_TEST = (EDGE / "test/wallets.test.ts").read_text()
CLIENT_WV = (CLIENT / "src/presence/walletView.ts").read_text()
CLIENT_TEST = (CLIENT / "test/walletView.test.ts").read_text()
COPY = (CLIENT / "src/presence/copyRegistry.ts").read_text()
README = (CLIENT / "README.md").read_text()
UX_DOC = (ROOT / "docs/ux/wallets.md").read_text()
TRANSFERS_DOC = (ROOT / "docs/ux/p2p-transfers.md").read_text()
TRACEABILITY = (ROOT / "docs/traceability.md").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()


def _imports(source: str) -> list[str]:
    """Return the module specifiers of every import statement."""
    return re.findall(r'import(?:\s+type)?[\s\S]*?from\s+"([^"]+)";', source)


def _block(source: str, start_marker: str, end_marker: str) -> str:
    """Extract source[start_marker : first end_marker after it] inclusive."""
    start = source.index(start_marker)
    end = source.index(end_marker, start) + len(end_marker)
    return source[start:end]


# ------------------------------------------------------------------ files


def test_batch54_files_exist():
    for path in (
        "db/migrations/0028_wallet_activation.sql",
        "services/edge/src/routes/walletRail.ts",
        "services/edge/test/wallets.test.ts",
        "client/test/walletView.test.ts",
        "docs/ux/wallets.md",
    ):
        assert (ROOT / path).exists(), path


# --------------------------------------------------------------- addendum


def test_addendum_records_the_rail_activation():
    for amd in ("AMD-PAY-15", "AMD-PAY-16", "AMD-PAY-17",
                "AMD-PAY-18", "AMD-PAY-19", "AMD-PAY-20"):
        assert amd in ADDENDUM, amd
    # AMD-PAY-15: rail live; kill switch; gate retained as defence in depth.
    assert "operational kill switch" in ADDENDUM
    assert "WALLET_RAIL" in ADDENDUM
    assert "defence in depth" in ADDENDUM
    # AMD-PAY-16: authenticated rail only; idempotent by provider reference.
    assert "HMAC-signed provider callback" in ADDENDUM
    assert "audited moderation credit" in ADDENDUM
    # AMD-PAY-17: two-phase hold-backed withdrawals with the pinned caps.
    assert "requested → processing → paid | failed" in ADDENDUM
    assert "requested → cancelled" in ADDENDUM
    assert "opaque provider-side payout reference" in ADDENDUM
    # AMD-PAY-19: reconciliation moves nothing.
    assert "re-derives every wallet" in ADDENDUM
    # AMD-PAY-20: DSAR inclusion; no erasure exception.
    assert "withdrawal requests inline per wallet" in ADDENDUM
    assert "MUST NOT erase or rewrite withdrawal_request or wallet_rail_event rows" in ADDENDUM
    # The footer records the batch and its verification anchor.
    assert "AMD-PAY-15..20 added alongside batch 54" in ADDENDUM
    assert "tests/test_batch54.py" in ADDENDUM
    # AMD-PAY-02 is re-scoped, not deleted: the external rails stay gated.
    assert "MUST NOT be deployed until the payments compliance programme is approved" in ADDENDUM


# --------------------------------------------------------------- migration


def test_wallet_rail_events_is_definer_only_and_idempotent_by_reference():
    # AMD-PAY-16/17: the provider reference IS the idempotency key.
    assert "CREATE TABLE wallet_rail_events (" in MIGRATION
    assert "reference    text PRIMARY KEY" in MIGRATION
    assert "CHECK (char_length(reference) BETWEEN 8 AND 128)" in MIGRATION
    assert "CHECK (kind IN ('fund', 'payout'))" in MIGRATION
    assert "ALTER TABLE wallet_rail_events ENABLE ROW LEVEL SECURITY" in MIGRATION
    # No policies and no grants — the definers are the only readers/writers.
    assert "GRANT SELECT ON wallet_rail_events" not in MIGRATION
    assert "CREATE POLICY" not in _block(
        MIGRATION, "CREATE TABLE wallet_rail_events (", "CREATE TABLE withdrawal_requests ("
    )


def test_withdrawal_requests_are_append_only_with_immutable_terms():
    # AMD-PAY-17: the FR-29 trigger discipline over the payout lifecycle.
    assert "CREATE TABLE withdrawal_requests (" in MIGRATION
    assert (
        "CHECK (state IN ('requested', 'processing', 'paid', 'failed', 'cancelled'))"
        in MIGRATION
    )
    assert "CHECK (char_length(destination_ref) BETWEEN 8 AND 128)" in MIGRATION
    assert "CREATE OR REPLACE FUNCTION withdrawal_requests_guard() RETURNS trigger" in MIGRATION
    assert "RAISE EXCEPTION 'withdrawal_requests is append-only (AMD-PAY-17)'" in MIGRATION
    assert "RAISE EXCEPTION 'withdrawal request terms are immutable (AMD-PAY-17)'" in MIGRATION
    assert "RAISE EXCEPTION 'illegal withdrawal transition (AMD-PAY-17)'" in MIGRATION
    assert "OLD.state = 'requested'  AND NEW.state IN ('processing', 'failed', 'cancelled')" in MIGRATION
    assert "OLD.state = 'processing' AND NEW.state IN ('paid', 'failed')" in MIGRATION
    assert "BEFORE UPDATE OR DELETE ON withdrawal_requests" in MIGRATION
    # Owner-scoped RLS read; the definers are the only writers.
    assert "CREATE POLICY withdrawal_requests_owner_select" in MIGRATION
    assert "GRANT SELECT ON withdrawal_requests TO presence_app;" in MIGRATION
    for banned in (
        "GRANT INSERT ON withdrawal_requests",
        "GRANT UPDATE ON withdrawal_requests",
        "GRANT DELETE ON withdrawal_requests",
    ):
        assert banned not in MIGRATION, banned


def test_every_activation_definer_keeps_the_rail_gate():
    """AMD-PAY-15: the database gate is retained as defence in depth."""
    gate = "current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'"
    for definer in ("fund_wallet", "request_withdrawal", "cancel_withdrawal",
                    "decide_withdrawal", "complete_withdrawal", "fail_withdrawal",
                    "accept_transfer_and_settle"):
        block = _block(MIGRATION, f"CREATE OR REPLACE FUNCTION {definer}(", "END $$;")
        assert gate in block, definer
    # The reconciliation definer moves nothing: moderator-only, no gate.
    recon = _block(MIGRATION, "CREATE OR REPLACE FUNCTION wallet_reconciliation(", "END $$;")
    assert "IF NOT app_moderator() THEN" in recon
    assert gate not in recon


def test_fund_wallet_is_authenticated_capped_and_idempotent():
    block = _block(MIGRATION, "CREATE OR REPLACE FUNCTION fund_wallet(", "END $$;")
    # AMD-PAY-16: the funding-callback GUC or a moderator — nothing else.
    assert "current_setting('app.funding_callback', true) IS DISTINCT FROM 'on'" in block
    assert "AND NOT app_moderator() THEN" in block
    # Per-event cap (NGN 150,000.00) and reference shape.
    assert "p_amount_minor > 15000000" in block
    assert "char_length(p_reference) NOT BETWEEN 8 AND 128" in block
    # Idempotent on the rail reference; a replay moves nothing twice.
    assert "WHERE r.reference = p_reference AND r.kind = 'fund'" in block
    assert "RETURN QUERY SELECT 'duplicate_reference'" in block
    # One fund entry and one rail event, atomically.
    assert block.count("INSERT INTO wallet_entries") == 1
    assert "'fund', p_amount_minor" in block
    assert block.count("INSERT INTO wallet_rail_events") == 1
    # The moderation credit route is audited.
    assert "'wallet.credit'" in block and "admin_audit_log(" in block
    for outcome in ("'funded'", "'forbidden'", "'invalid_amount'",
                    "'over_funding_cap'", "'invalid_reference'",
                    "'unknown_wallet'", "'wallet_not_active'"):
        assert outcome in block, outcome


def test_request_withdrawal_is_owner_only_hold_backed_and_capped():
    block = _block(MIGRATION, "CREATE OR REPLACE FUNCTION request_withdrawal(", "END $$;")
    # The definer bypasses RLS: the wallet claim MUST be the caller's own.
    assert "v_owner IS NULL OR v_owner IS DISTINCT FROM app_user()" in block
    # AMD-PAY-05 mirrored caps: per withdrawal and rolling 24 h.
    assert "p_amount_minor > 5000000" in block
    assert "v_daily + p_amount_minor > 15000000" in block
    assert "r.state IN ('requested', 'processing', 'paid')" in block
    assert "interval '24 hours'" in block
    # Hold-backed: the reservation lands in the same transaction, unnamed
    # by any transfer.
    assert "INSERT INTO wallet_holds (wallet_id, transfer_id, amount_minor)" in block
    assert "VALUES (p_wallet, NULL, p_amount_minor)" in block
    # A withdrawal may not spend reserved funds.
    assert "IF p_amount_minor > v_balance - v_held THEN" in block
    for outcome in ("'requested'", "'forbidden'", "'invalid_amount'",
                    "'over_withdrawal_cap'", "'over_daily_cap'",
                    "'invalid_destination'", "'unknown_wallet'",
                    "'wallet_not_active'", "'insufficient_funds'"):
        assert outcome in block, outcome


def test_withdrawal_lifecycle_definers_are_two_phase_and_audited():
    cancel = _block(MIGRATION, "CREATE OR REPLACE FUNCTION cancel_withdrawal(", "END $$;")
    assert "r.owner IS NULL OR r.owner IS DISTINCT FROM app_user()" in cancel
    assert "IF r.state <> 'requested' THEN" in cancel
    assert "SET state = 'cancelled'" in cancel
    assert "SET state = 'voided', resolved_at = now()" in cancel  # hold released
    decide = _block(MIGRATION, "CREATE OR REPLACE FUNCTION decide_withdrawal(", "END $$;")
    assert "IF NOT app_moderator() THEN" in decide
    assert "p_decision NOT IN ('approve', 'reject')" in decide
    assert "'wallet.withdrawal_decision'" in decide and "admin_audit_log(" in decide
    # Approve → processing; reject → failed with the hold voided.
    assert "CASE WHEN p_decision = 'approve' THEN 'processing' ELSE 'failed' END" in decide
    complete = _block(MIGRATION, "CREATE OR REPLACE FUNCTION complete_withdrawal(", "END $$;")
    assert "current_setting('app.payout_callback', true) IS DISTINCT FROM 'on'" in complete
    # The hold posts FIRST, then the ledger debit — value leaves exactly once.
    assert complete.index("SET state = 'posted'") < complete.index("wallet_move(")
    assert "wallet_move(r.wallet_id, 'withdrawal', r.amount_minor)" in complete
    assert "SET state = 'paid'" in complete
    assert "INSERT INTO wallet_rail_events" in complete
    assert "'duplicate_reference'" in complete
    fail = _block(MIGRATION, "CREATE OR REPLACE FUNCTION fail_withdrawal(", "END $$;")
    assert "SET state = 'failed'" in fail and "SET state = 'voided'" in fail
    assert "INSERT INTO wallet_rail_events" in fail


def test_acceptance_settles_atomically_or_not_at_all():
    block = _block(MIGRATION, "CREATE OR REPLACE FUNCTION accept_transfer_and_settle(", "END $$;")
    # AMD-PAY-18: the acceptor must be the recipient; the sender's wallet
    # and funds are pre-proved BEFORE any state moves.
    assert "app_user() IS NULL OR app_user() IS DISTINCT FROM t.recipient" in block
    assert "IF t.state <> 'proposed' THEN" in block
    assert "IF now() >= t.expires_at THEN" in block
    assert "has_active_suspension(t.sender, 'payment_instrument')" in block
    assert "IF t.amount_minor + t.fee_minor > v_balance - v_held THEN" in block
    assert block.index("'insufficient_funds'") < block.index("record_transfer_event(")
    # State (re-proves KYC + OPEN pair), reservation, settlement — one
    # transaction; any failure rolls everything back.
    assert "record_transfer_event(p_transfer, app_user(), 'accepted')" in block
    assert "place_wallet_hold(v_wallet, t.amount_minor + t.fee_minor, p_transfer)" in block
    assert "v_step := settle_transfer_funds(p_transfer);" in block
    assert block.index("record_transfer_event(") < block.index("place_wallet_hold(")
    assert block.index("place_wallet_hold(") < block.index("settle_transfer_funds(")


def test_reconciliation_reports_and_moves_nothing():
    block = _block(MIGRATION, "CREATE OR REPLACE FUNCTION wallet_reconciliation(", "END $$;")
    for key in ("'walletsChecked'", "'balanceMismatches'", "'platformFeeDelta'",
                "'stuckHolds'", "'openWithdrawals'"):
        assert key in block, key
    # Read-only by construction: no writes at all.
    for banned in ("INSERT INTO", "UPDATE ", "DELETE FROM", "wallet_move("):
        assert banned not in block, banned
    assert "interval '24 hours'" in block  # stuck-hold threshold


def test_activation_grants_are_exactly_the_eight_definers():
    for grant in (
        "GRANT EXECUTE ON FUNCTION fund_wallet(uuid, bigint, text) TO presence_app;",
        "GRANT EXECUTE ON FUNCTION request_withdrawal(uuid, bigint, text) TO presence_app;",
        "GRANT EXECUTE ON FUNCTION cancel_withdrawal(uuid) TO presence_app;",
        "GRANT EXECUTE ON FUNCTION decide_withdrawal(uuid, text) TO presence_app;",
        "GRANT EXECUTE ON FUNCTION complete_withdrawal(uuid, text) TO presence_app;",
        "GRANT EXECUTE ON FUNCTION fail_withdrawal(uuid, text) TO presence_app;",
        "GRANT EXECUTE ON FUNCTION accept_transfer_and_settle(uuid) TO presence_app;",
        "GRANT EXECUTE ON FUNCTION wallet_reconciliation() TO presence_app;",
    ):
        assert grant in MIGRATION, grant


# --------------------------------------------------------------- DSAR/erasure


def test_dsar_export_gains_withdrawals_with_every_prior_key_preserved():
    # AMD-PAY-20: one wholesale CREATE OR REPLACE in 0028, forward-only.
    assert "CREATE OR REPLACE FUNCTION dsar_export(uid uuid) RETURNS jsonb" in MIGRATION
    for key in (
        "'user'",
        "'identity'",
        "'interests'",
        "'pairs'",
        "'ledgerActions'",
        "'blocksFiled'",
        "'reportsFiled'",
        "'dataProcessingConsents'",
        "'transfers'",
        "'wallets'",
    ):
        assert key in MIGRATION, key
    # The wallets block carries the withdrawal history inline.
    assert "'withdrawals'" in MIGRATION
    wallets_block = _block(MIGRATION, "'wallets', COALESCE(", "FROM wallets w WHERE w.owner = uid)")
    for field in ("'requestId'", "'destinationRef'", "'resolvedAt'",
                  "'entries'", "'holds'", "'withdrawals'"):
        assert field in wallets_block, field
    assert "FROM withdrawal_requests r" in wallets_block
    # Grant discipline identical to every previous round.
    assert "REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC" in MIGRATION
    assert "GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app" in MIGRATION
    # The 0027 body stays in its file — newest wins by ordering.
    assert "'wallets'" in MIGRATION_0027 and "'withdrawals'" not in MIGRATION_0027


def test_withdrawal_and_rail_rows_are_never_erased_anywhere():
    # AMD-PAY-20: the append-only discipline has no erasure exception, not
    # even in the account-deletion path.
    for banned in (
        "DELETE FROM withdrawal_requests",
        "DELETE FROM wallet_rail_events",
        "DROP TABLE withdrawal_requests",
        "DROP TABLE wallet_rail_events",
        "TRUNCATE withdrawal_requests",
        "TRUNCATE wallet_rail_events",
    ):
        assert banned not in ALL_MIGRATIONS, banned
    # The delete_account definer makes no mention of the rail tables.
    delete_block = MIGRATION_0003[MIGRATION_0003.index(
        "CREATE OR REPLACE FUNCTION delete_account"):]
    delete_block = delete_block[: delete_block.index("END $$;")]
    assert "withdrawal" not in delete_block
    assert "rail" not in delete_block


# ------------------------------------------------------- cross-layer pins


def test_withdrawal_vocabulary_is_byte_identical_edge_and_client():
    """AMD-PAY-17: the two TS mirrors cannot drift."""
    assert _block(EDGE_WALLETS, "export const WITHDRAWAL_STATES", "as const;") == _block(
        CLIENT_WV, "export const WITHDRAWAL_STATES", "as const;"
    )
    for cap in ("MAX_WITHDRAWAL_MINOR = 5_000_000", "DAILY_WITHDRAWAL_CAP_MINOR = 15_000_000"):
        assert cap in EDGE_WALLETS and cap in CLIENT_WV, cap
    assert "MAX_FUNDING_MINOR = 15_000_000" in EDGE_WALLETS


def test_withdrawal_vocabulary_matches_the_migration():
    states = re.findall(
        r"'(\w+)'", _block(MIGRATION, "CHECK (state IN (", ")),\n    created_at")
    )
    for state in ("requested", "processing", "paid", "failed", "cancelled"):
        assert state in states, state


# ------------------------------------------------------------ edge service


def test_edge_module_surface_gained_the_rail_validators():
    for name in (
        "WITHDRAWAL_STATES",
        "isWithdrawalState",
        "MAX_WITHDRAWAL_MINOR",
        "DAILY_WITHDRAWAL_CAP_MINOR",
        "MAX_FUNDING_MINOR",
        "parseWithdrawalRequest",
        "parseFundingCallback",
        "parsePayoutCallback",
        "parseWithdrawalDecision",
        "fundingSignaturePayload",
        "payoutSignaturePayload",
    ):
        assert name in EDGE_WALLETS, name


def test_kill_switch_is_the_only_settlement_gate_writer():
    # AMD-PAY-15: exactly the two auth.ts helpers write the GUC, both
    # behind the WALLET_RAIL kill switch; nothing else in the service
    # writes it.
    assert "export class WalletRailUnavailable extends Error" in EDGE_AUTH
    assert EDGE_AUTH.count('process.env.WALLET_RAIL === "off"') == 2
    assert EDGE_AUTH.count("set_config('app.transfer_settlement'") == 2
    assert "set_config('app.transfer_settlement', 'on', true)" in EDGE_AUTH
    elsewhere = "\n".join(
        p.read_text()
        for p in (EDGE / "src").rglob("*.ts")
        if p.name != "auth.ts"
    )
    assert "set_config('app.transfer_settlement'" not in elsewhere
    assert "SET LOCAL app.transfer_settlement" not in elsewhere


def test_wallet_routes_gain_the_activation_wires():
    for path in (
        '"/v1/wallets/:walletId/withdrawals"',
        '"/v1/wallets/:walletId/withdrawals/:requestId/cancel"',
        '"/v1/moderation/wallets/:walletId/credit"',
        '"/v1/moderation/withdrawals/:requestId/decide"',
        '"/v1/moderation/wallets/reconciliation"',
    ):
        assert path in EDGE_ROUTES, path
    # The activation definers are the wires' only reach into the rail.
    for call in ("request_withdrawal($1, $2, $3)", "cancel_withdrawal($1)",
                 "fund_wallet($1, $2, $3)", "decide_withdrawal($1, $2)",
                 "wallet_reconciliation()"):
        assert call in EDGE_ROUTES, call
    # The rail-disabled answer is a 503 everywhere.
    assert EDGE_ROUTES.count("WalletRailUnavailable") >= 5
    # The moderation credit idempotency answer is a 200, not an error.
    assert "duplicate" in EDGE_ROUTES


def test_webhooks_are_hmac_authenticated_and_outside_the_authed_scope():
    for path in ('"/v1/webhooks/wallet-funding"', '"/v1/webhooks/wallet-payout"'):
        assert path in EDGE_RAIL, path
    # HMAC-SHA256 over the canonical field string, timing-safe compared.
    assert 'createHmac("sha256", secret)' in EDGE_RAIL
    assert "timingSafeEqual" in EDGE_RAIL
    assert "x-wallet-signature" in EDGE_RAIL
    assert "fundingSignaturePayload(" in EDGE_RAIL
    assert "payoutSignaturePayload(" in EDGE_RAIL
    # Unset secrets refuse closed.
    assert "WALLET_FUNDING_SECRET" in EDGE_RAIL and "WALLET_PAYOUT_SECRET" in EDGE_RAIL
    assert EDGE_RAIL.count("code(503)") >= 4
    # The callbacks run under the settlement GUC plus the matching
    # callback GUC — never a bare connection.
    assert 'withRailCallback(ctx.pg, "app.funding_callback"' in EDGE_RAIL
    assert EDGE_RAIL.count('withRailCallback(ctx.pg, "app.payout_callback"') == 2
    # The routes never decide: they map fund_wallet / complete_withdrawal /
    # fail_withdrawal outcomes.
    for call in ("fund_wallet($1, $2, $3)", "complete_withdrawal($1, $2)",
                 "fail_withdrawal($1, $2)"):
        assert call in EDGE_RAIL, call


def test_app_registers_the_webhook_surface_outside_auth():
    assert 'import { registerWalletRailRoutes } from "./routes/walletRail.js";' in EDGE_APP
    assert "registerWalletRailRoutes(app, ctx);" in EDGE_APP
    # Registered on the bare app, not the authed scope.
    assert EDGE_APP.index("registerWalletRailRoutes(app, ctx);") < EDGE_APP.index(
        "registerWalletRoutes(authed, ctx);"
    )


def test_transfer_acceptance_routes_through_the_atomic_definer():
    # AMD-PAY-18: no standalone settle route — acceptance IS settlement.
    assert "accept_transfer_and_settle($1)" in EDGE_TRANSFERS
    assert "withSettlement(ctx.pg, req.userId" in EDGE_TRANSFERS
    paths = [m.group(1) for m in re.finditer(r'"(/v1/[^"]*)"', EDGE_TRANSFERS)]
    assert not any("settle" in p for p in paths)


def test_edge_tests_cover_the_activation_validators():
    for anchor in (
        "AMD-PAY-17: the withdrawal lifecycle is pinned and closed",
        "AMD-PAY-16/17: the rail caps are pinned in minor units",
        "AMD-PAY-17: withdrawal requests are strictly {amountMinor, destinationRef}",
        "AMD-PAY-16: funding callbacks are strictly {walletId, amountMinor, reference}",
        "AMD-PAY-17: payout callbacks are strictly {requestId, outcome, reference}",
        "AMD-PAY-17: moderation decisions are strictly {decision}",
        "AMD-PAY-16/17: the signed strings are canonical and colon-joined",
    ):
        assert anchor in EDGE_TEST, anchor


# ------------------------------------------------------------------ client


def test_client_still_imports_only_the_transfer_contract():
    assert _imports(CLIENT_WV) == ["./transferCard.js"]


def test_client_module_surface_gained_the_withdrawal_planner():
    for name in (
        "WITHDRAWAL_STATES",
        "isWithdrawalState",
        "MAX_WITHDRAWAL_MINOR",
        "DAILY_WITHDRAWAL_CAP_MINOR",
        "WithdrawalPlan",
        "WithdrawalVerdict",
        "planWithdrawal",
        "copyKeyForWithdrawalState",
    ):
        assert name in CLIENT_WV, name
    # The five pinned refusal reasons.
    for reason in ('"invalid-input"', '"invalid-destination"', '"over-withdrawal-cap"',
                   '"exceeds-available"', '"over-daily-cap"'):
        assert reason in CLIENT_WV, reason


def test_client_guard_extended_and_non_vacuous():
    guard = _block(CLIENT_WV, "export function walletHonoursAmendment", "\n}")
    assert "WITHDRAWAL_STATES.length === 5" in guard
    assert "MAX_WITHDRAWAL_MINOR === 5_000_000" in guard
    assert "DAILY_WITHDRAWAL_CAP_MINOR === 15_000_000" in guard
    assert '"exceeds-available"' in guard
    assert '"over-withdrawal-cap"' in guard
    assert '"over-daily-cap"' in guard
    assert 'copyKeyForWithdrawalState("processing")' in guard


def test_copy_registry_gained_the_rail_keys():
    for key in (
        '"ui.wallet.fund"',
        '"ui.wallet.fund.pending"',
        '"ui.wallet.withdraw"',
        '"ui.wallet.withdraw.insufficient"',
        '"ui.wallet.withdraw.over-cap"',
        '"ui.wallet.withdraw.cancel"',
        '"ui.wallet.rail-disabled"',
    ):
        assert key in COPY, key
    for state in ("requested", "processing", "paid", "failed", "cancelled"):
        assert f'"ui.wallet.withdrawal.{state}"' in COPY, state


def test_client_tests_cover_the_activation_contract():
    for anchor in (
        "the withdrawal lifecycle and caps are pinned to the amendment values",
        "planWithdrawal refuses with exactly one reason, in the pinned order",
        "copy keys exist for every withdrawal state",
        "the master guard holds and is not vacuous",
    ):
        assert anchor in CLIENT_TEST, anchor


def test_readme_row_records_the_activation():
    assert "`src/presence/walletView.ts`" in README
    assert "AMD-PAY-15..20" in README
    assert "planWithdrawal" in README


# --------------------------------------------------------------------- docs


def test_ux_doc_declares_the_live_rail():
    for anchor in (
        "fund_wallet",
        "request_withdrawal",
        "cancel_withdrawal",
        "decide_withdrawal",
        "complete_withdrawal",
        "fail_withdrawal",
        "accept_transfer_and_settle",
        "wallet_reconciliation",
        "wallet_rail_events",
        "withdrawal_requests",
        "WALLET_RAIL",
        "withSettlement",
        "x-wallet-signature",
        "tests/test_batch54.py",
    ):
        assert anchor in UX_DOC, anchor
    # The standing gaps stay declared: external rails remain TECH-23-gated.
    assert "Settlement rails (Mojaloop / TigerBeetle)" in UX_DOC


def test_transfers_doc_records_atomic_acceptance():
    assert "AMD-PAY-18" in TRANSFERS_DOC
    assert "accept_transfer_and_settle" in TRANSFERS_DOC
    assert "docs/ux/wallets.md" in TRANSFERS_DOC


# ----------------------------------------------------------- traceability


def test_migration_mounted_and_routes_documented():
    # The b23 regression guard: every migration rides the initdb ConfigMap,
    # ordered after 29_wallets.sql so the withdrawal-aware export wins.
    assert "=db/migrations/0028_wallet_activation.sql" in K8S_README
    assert "30_wallet_activation.sql" in K8S_README
    assert "/docker-entrypoint-initdb.d/30_wallet_activation.sql:ro" in COMPOSE
    # TECH-14: the activation wires are in the OpenAPI contract.
    for path in (
        "/v1/wallets/{walletId}/withdrawals:",
        "/v1/wallets/{walletId}/withdrawals/{requestId}/cancel:",
        "/v1/moderation/wallets/{walletId}/credit:",
        "/v1/moderation/withdrawals/{requestId}/decide:",
        "/v1/moderation/wallets/reconciliation:",
        "/v1/webhooks/wallet-funding:",
        "/v1/webhooks/wallet-payout:",
    ):
        assert path in OPENAPI, path
    for amd in ("AMD-PAY-15", "AMD-PAY-16", "AMD-PAY-17", "AMD-PAY-19"):
        assert amd in OPENAPI, amd


def test_every_new_post_wire_declares_idempotency():
    # Every POST added in batch 54 carries the Idempotency-Key parameter,
    # matching the platform-wide write discipline.
    openapi_lines = OPENAPI.splitlines()
    for path in (
        "/v1/wallets/{walletId}/withdrawals:",
        "/v1/wallets/{walletId}/withdrawals/{requestId}/cancel:",
        "/v1/moderation/wallets/{walletId}/credit:",
        "/v1/moderation/withdrawals/{requestId}/decide:",
        "/v1/webhooks/wallet-funding:",
        "/v1/webhooks/wallet-payout:",
    ):
        start = OPENAPI.index(f"  {path}")
        end = OPENAPI.find("\n  /v1/", start + 1)
        block = OPENAPI[start:] if end == -1 else OPENAPI[start:end]
        post = block.index("    post:")
        post_block = block[post:]
        assert "#/components/parameters/IdempotencyKey" in post_block, path


def test_traceability_counts_unchanged():
    # Amendments carry AMD- identifiers in the addendum ledger — the
    # original 306-requirement counts do not move.
    assert "| implemented | 234 |" in TRACEABILITY
    assert "| partial | 6 |" in TRACEABILITY
    assert "| gap-p0 | 0 |" in TRACEABILITY
    assert "| client | 0 |" in TRACEABILITY
