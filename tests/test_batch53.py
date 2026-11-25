"""Batch 53 invariants — the wallet contract layer (SRS Addendum 001,
AMD-PAY-10..14): ledger accounts, the append-only value ledger with
database-enforced solvency, two-phase holds with immutable terms, atomic
settlement with the fee split, moderation freezing, DSAR inclusion, and
the AMD-PAY-08 rail gate extended over every value-moving definer.

The 306-requirement ledger stays untouched: amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md, so the traceability counts
stay 234/6/0. AMD-PAY-02: the Mojaloop/TigerBeetle deployment gate
(TECH-23) stands for the external rails. Batch 54 (AMD-PAY-15..20)
activated the internal NGN rail behind the WALLET_RAIL kill switch —
test_no_raw_value_mover_route_exists and the requireModerator count in
test_edge_routes_are_the_wallet_wires carry that amendment.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "client"
EDGE = ROOT / "services/edge"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0027_wallets.sql").read_text()
MIGRATION_0003 = (ROOT / "db/migrations/0003_account_deletion.sql").read_text()
MIGRATION_0026 = (ROOT / "db/migrations/0026_dsar_transfers.sql").read_text()
ALL_MIGRATIONS = "\n".join(
    p.read_text() for p in sorted((ROOT / "db/migrations").glob("*.sql"))
)
EDGE_WALLETS = (EDGE / "src/wallets.ts").read_text()
EDGE_ROUTES = (EDGE / "src/routes/wallets.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
EDGE_TEST = (EDGE / "test/wallets.test.ts").read_text()
CLIENT_WV = (CLIENT / "src/presence/walletView.ts").read_text()
CLIENT_TEST = (CLIENT / "test/walletView.test.ts").read_text()
COPY = (CLIENT / "src/presence/copyRegistry.ts").read_text()
APP_TSX = (CLIENT / "App.tsx").read_text()
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


def test_batch53_files_exist():
    for path in (
        "db/migrations/0027_wallets.sql",
        "services/edge/src/wallets.ts",
        "services/edge/src/routes/wallets.ts",
        "services/edge/test/wallets.test.ts",
        "client/src/presence/walletView.ts",
        "client/test/walletView.test.ts",
        "docs/ux/wallets.md",
    ):
        assert (ROOT / path).exists(), path


# --------------------------------------------------------------- addendum


def test_addendum_records_the_wallet_contracts():
    for amd in ("AMD-PAY-10", "AMD-PAY-11", "AMD-PAY-12", "AMD-PAY-13", "AMD-PAY-14"):
        assert amd in ADDENDUM, amd
    # AMD-PAY-10: one wallet per user per currency; the platform fee wallet.
    assert "one wallet per currency" in ADDENDUM
    assert "platform fee wallet" in ADDENDUM
    assert "unfunded wallet is inert by construction" in ADDENDUM
    # AMD-PAY-11: append-only, solvency as a CHECK.
    assert "solvency is a CHECK, not a convention" in ADDENDUM
    # AMD-PAY-12: hold terms immutable.
    assert "pending → posted | voided" in ADDENDUM
    assert "MUST be immutable once placed" in ADDENDUM
    # AMD-PAY-13: atomic settlement; the gate extended over the surface.
    assert "value and state can never diverge" in ADDENDUM
    assert "the AMD-PAY-08 gate extended over the whole wallet surface" in ADDENDUM
    # AMD-PAY-14: DSAR inclusion; no erasure exception.
    assert "MUST include the subject's wallets" in ADDENDUM
    assert "MUST NOT erase or rewrite wallet, wallet_entry or wallet_hold rows" in ADDENDUM
    # The footer records the batch and its verification anchor.
    assert "AMD-PAY-10..14 added alongside batch 53" in ADDENDUM
    assert "tests/test_batch53.py" in ADDENDUM
    # The standing gate is untouched.
    assert "MUST NOT be deployed until the payments compliance programme is approved" in ADDENDUM


# --------------------------------------------------------------- migration


def test_wallets_table_is_structured_only():
    # AMD-PAY-10: identifier, currency, status — nothing free-form.
    assert "CREATE TABLE wallets (" in MIGRATION
    assert "CHECK (currency = 'NGN')" in MIGRATION
    assert "CHECK (status IN ('active', 'frozen', 'closed'))" in MIGRATION
    assert "CHECK (kind IN ('user', 'platform'))" in MIGRATION
    assert "CREATE UNIQUE INDEX wallets_owner_currency" in MIGRATION
    assert "CREATE UNIQUE INDEX wallets_platform_currency" in MIGRATION
    table_block = _block(MIGRATION, "CREATE TABLE wallets (", "created_at timestamptz NOT NULL DEFAULT now()")
    for banned in ("memo", "note", "message", "description", "comment", "label"):
        assert banned not in table_block, banned


def test_platform_fee_wallet_is_pinned():
    # AMD-PAY-10/13: the fee revenue account is a fixed, well-known row.
    assert "'00000000-0000-0000-0000-00000000fee1'" in MIGRATION
    platform_block = _block(
        MIGRATION, "INSERT INTO wallets (wallet_id, owner, kind, currency)", "'NGN');"
    )
    assert "NULL, 'platform'" in platform_block


def test_wallet_entries_ledger_is_append_only_and_solvency_checked():
    # AMD-PAY-11: trigger raises, no write grants, balance_after non-negative.
    assert "CREATE TABLE wallet_entries (" in MIGRATION
    assert "balance_after bigint NOT NULL CHECK (balance_after >= 0)" in MIGRATION
    for kind in ("'fund'", "'withdrawal'", "'transfer_out'", "'transfer_in'",
                 "'fee_charge'", "'fee_revenue'"):
        assert kind in MIGRATION, kind
    assert "CREATE OR REPLACE FUNCTION wallet_entries_append_only() RETURNS trigger" in MIGRATION
    assert "RAISE EXCEPTION 'wallet_entries is append-only (AMD-PAY-11)'" in MIGRATION
    assert "BEFORE UPDATE OR DELETE ON wallet_entries" in MIGRATION
    assert "GRANT SELECT ON wallet_entries TO presence_app;" in MIGRATION
    for banned in (
        "GRANT UPDATE ON wallet_entries",
        "GRANT DELETE ON wallet_entries",
        "GRANT INSERT ON wallet_entries",
        "GRANT INSERT ON wallets",
        "GRANT UPDATE ON wallets",
        "GRANT DELETE ON wallets",
        "GRANT INSERT ON wallet_holds",
        "GRANT UPDATE ON wallet_holds",
        "GRANT DELETE ON wallet_holds",
    ):
        assert banned not in MIGRATION, banned


def test_wallet_holds_have_immutable_terms_and_a_legal_lifecycle():
    # AMD-PAY-12: pending → posted | voided only; terms never change.
    assert "CREATE TABLE wallet_holds (" in MIGRATION
    assert "CHECK (state IN ('pending', 'posted', 'voided'))" in MIGRATION
    assert "CREATE OR REPLACE FUNCTION wallet_holds_guard() RETURNS trigger" in MIGRATION
    assert "RAISE EXCEPTION 'wallet_holds is append-only (AMD-PAY-12)'" in MIGRATION
    assert "RAISE EXCEPTION 'wallet hold terms are immutable (AMD-PAY-12)'" in MIGRATION
    assert "RAISE EXCEPTION 'illegal hold transition (AMD-PAY-12)'" in MIGRATION
    assert "OLD.state <> 'pending' OR NEW.state NOT IN ('posted', 'voided')" in MIGRATION
    assert "BEFORE UPDATE OR DELETE ON wallet_holds" in MIGRATION


def test_balances_are_derived_through_a_security_invoker_view():
    assert "CREATE VIEW wallet_balances WITH (security_invoker = true) AS" in MIGRATION
    assert "available_minor" in MIGRATION and "held_minor" in MIGRATION
    assert "GRANT SELECT ON wallet_balances TO presence_app;" in MIGRATION
    # Owner-scoped RLS on all three tables.
    for policy in ("wallets_owner_select", "wallet_entries_owner_select",
                   "wallet_holds_owner_select"):
        assert f"CREATE POLICY {policy}" in MIGRATION, policy
    assert MIGRATION.count("ENABLE ROW LEVEL SECURITY") >= 3


def test_create_wallet_is_self_serve_kyc_gated_and_idempotent():
    assert "CREATE OR REPLACE FUNCTION create_wallet(p_owner uuid)" in MIGRATION
    assert "LANGUAGE plpgsql SECURITY DEFINER SET search_path = public" in MIGRATION
    # The definer bypasses RLS — the owner claim must be the caller's own.
    assert "p_owner IS DISTINCT FROM app_user()" in MIGRATION
    assert "SELECT 1 FROM kyc_verified_accounts WHERE user_id = p_owner" in MIGRATION
    for outcome in ("'created'", "'exists'", "'forbidden'", "'not_kyc_verified'"):
        assert outcome in MIGRATION, outcome
    assert "GRANT EXECUTE ON FUNCTION create_wallet(uuid) TO presence_app;" in MIGRATION


def test_every_value_moving_definer_is_rail_gated():
    """AMD-PAY-13: the AMD-PAY-08 gate extended over the wallet surface."""
    gate = "current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'"
    for definer in ("wallet_move", "place_wallet_hold", "void_wallet_hold",
                    "settle_transfer_funds"):
        block = _block(MIGRATION, f"CREATE OR REPLACE FUNCTION {definer}(", "END $$;")
        assert gate in block, definer
    # The moderation definer is NOT rail-gated — it moves no value.
    status_block = _block(MIGRATION, "CREATE OR REPLACE FUNCTION set_wallet_status(", "END $$;")
    assert gate not in status_block
    assert "IF NOT app_moderator() THEN" in status_block
    assert "'wallet.status'" in status_block and "admin_audit_log(" in status_block
    assert "IF v.kind <> 'user' THEN" in status_block  # platform wallet untouchable


def test_settlement_is_atomic_idempotent_and_fee_split():
    block = _block(MIGRATION, "CREATE OR REPLACE FUNCTION settle_transfer_funds(", "END $$;")
    assert "FOR UPDATE" in block
    # Idempotency and state discipline.
    assert "RETURN 'already_settled'" in block
    assert "RETURN 'illegal_state'" in block
    assert "FROM wallet_entries e WHERE e.transfer_id = p_transfer" in block
    # Eligibility re-proved at the third moment.
    assert "has_active_suspension(t.sender, 'payment_instrument')" in block
    assert "has_active_suspension(t.recipient, 'payment_instrument')" in block
    assert "RETURN 'no_wallet'" in block
    assert "RETURN 'wallet_not_active'" in block
    # The hold must cover amount + fee exactly; else availability is checked.
    assert "h.amount_minor = v_need" in block
    assert "RETURN 'hold_mismatch'" in block
    assert "RETURN 'insufficient_funds'" in block
    assert "v_need := t.amount_minor + t.fee_minor" in block
    # The four-entry fee split, each kind exactly once in this definer.
    assert "'transfer_out'" in block and "'fee_charge'" in block
    assert "'transfer_in'" in block and "'fee_revenue'" in block
    assert block.count("INSERT INTO wallet_entries") == 4
    # Deadlock discipline: the three wallets lock in id order.
    assert "ORDER BY w.wallet_id FOR UPDATE" in block
    # Value and state move in one transaction.
    assert "PERFORM record_transfer_event(" in block
    assert "'settled', jsonb_build_object('rail', 'wallet')" in block


# ------------------------------------------------------- cross-layer pins


def test_wallet_vocabularies_are_byte_identical_edge_and_client():
    """AMD-PAY-10..12: the two TS mirrors cannot drift."""
    for const, end in (
        ("export const WALLET_STATUSES", "as const;"),
        ("export const WALLET_ENTRY_KINDS", "as const;"),
        ("export const WALLET_HOLD_STATES", "as const;"),
    ):
        assert _block(EDGE_WALLETS, const, end) == _block(CLIENT_WV, const, end), const
    pinned = 'export const PLATFORM_WALLET_ID = "00000000-0000-0000-0000-00000000fee1";'
    assert pinned in EDGE_WALLETS and pinned in CLIENT_WV
    assert 'export const WALLET_CURRENCY = "NGN";' in EDGE_WALLETS


def test_wallet_vocabularies_match_the_migration():
    kinds = re.findall(r"'(\w+)'", _block(MIGRATION, "CREATE TABLE wallet_entries (", "amount_minor bigint"))
    for kind in ("fund", "withdrawal", "transfer_out", "transfer_in",
                 "fee_charge", "fee_revenue"):
        assert kind in kinds, kind
    states = re.findall(r"'(\w+)'", _block(MIGRATION, "CREATE TABLE wallet_holds (", "created_at"))
    for state in ("pending", "posted", "voided"):
        assert state in states, state


# ------------------------------------------------------------ edge service


def test_edge_module_surface():
    for name in (
        "WALLET_CURRENCY",
        "WALLET_STATUSES",
        "WALLET_ENTRY_KINDS",
        "WALLET_HOLD_STATES",
        "isWalletStatus",
        "isWalletEntryKind",
        "isWalletHoldState",
        "PLATFORM_WALLET_ID",
        "parseWalletCreation",
    ):
        assert name in EDGE_WALLETS, name


def test_edge_routes_are_the_wallet_wires():
    # Amended in batch 54 (AMD-PAY-15..17): the rail is live, so the wire
    # set grew — withdrawal request/list/cancel, moderation credit, the
    # withdrawal decision and reconciliation ride alongside the five
    # batch-53 wires.
    assert 'app.post(\n    "/v1/wallets"' in EDGE_ROUTES
    assert 'app.get("/v1/wallets"' in EDGE_ROUTES
    assert '"/v1/wallets/:walletId/entries"' in EDGE_ROUTES
    assert '"/v1/moderation/wallets/:walletId/freeze"' in EDGE_ROUTES
    assert '"/v1/moderation/wallets/:walletId/unfreeze"' in EDGE_ROUTES
    # The definers decide; the routes only map outcomes.
    assert "FROM create_wallet($1)" in EDGE_ROUTES
    assert "FROM wallets w\n           JOIN wallet_balances b" in EDGE_ROUTES
    assert "set_wallet_status($1, 'frozen')" in EDGE_ROUTES
    assert "set_wallet_status($1, 'active')" in EDGE_ROUTES
    # freeze, unfreeze, credit, decide — moderation wires are preHandled.
    assert EDGE_ROUTES.count("preHandler: requireModerator") == 5
    # A wallet the caller does not own answers 404 — existence is not leaked.
    assert '"wallet not found"' in EDGE_ROUTES
    # TR-23 strict bodies.
    assert "additionalProperties: false" in EDGE_ROUTES


def test_no_raw_value_mover_route_exists():
    """AMD-PAY-13/15: the rail gate made tangible — no raw mover, no GUC write.

    Amended in batch 54: routes may reach the ACTIVATION definers
    (fund_wallet, request_withdrawal, accept_transfer_and_settle, the
    withdrawal lifecycle definers) but never the raw movement primitives
    — wallet_move, place_wallet_hold, void_wallet_hold and
    settle_transfer_funds have no route caller — and no route file ever
    writes the settlement GUC: the auth.ts helpers are the only writers.
    """
    rail_routes = (EDGE / "src/routes/walletRail.ts").read_text()
    transfer_routes = (EDGE / "src/routes/transfers.ts").read_text()
    # Batch 55: the governance routes are in scope for the same scan.
    governance_routes = (EDGE / "src/routes/walletGovernance.ts").read_text()
    for source in (EDGE_ROUTES, rail_routes, transfer_routes, governance_routes):
        for definer in ("wallet_move(", "place_wallet_hold(", "void_wallet_hold(",
                        "settle_transfer_funds("):
            assert definer not in source, definer
        assert "set_config(" not in source
        assert "SET LOCAL app.transfer_settlement" not in source
        assert "SET app.transfer_settlement" not in source
    # Raw settle/hold paths exist nowhere; funding and payouts enter only
    # through the dedicated webhook surface.
    for source in (EDGE_ROUTES, rail_routes, transfer_routes, governance_routes):
        paths = [m.group(1) for m in re.finditer(r'"(/v1/[^"]*)"', source)]
        for banned in ("hold", "settle"):
            assert not any(banned in p for p in paths), banned


def test_edge_app_registers_the_routes():
    assert 'import { registerWalletRoutes } from "./routes/wallets.js";' in EDGE_APP
    assert "registerWalletRoutes(authed, ctx);" in EDGE_APP


def test_edge_tests_cover_the_validators():
    for anchor in (
        "AMD-PAY-10: statuses, currency and the platform wallet are pinned",
        "AMD-PAY-11: the six ledger kinds are pinned and closed",
        "AMD-PAY-12: the hold lifecycle is pending → posted | voided",
        "AMD-PAY-10: creation takes a strictly empty body",
        "parseWalletCreation",
        "00000000-0000-0000-0000-00000000fee1",
    ):
        assert anchor in EDGE_TEST, anchor


# ------------------------------------------------------------------ client


def test_client_module_imports_only_the_transfer_contract():
    assert _imports(CLIENT_WV) == ["./transferCard.js"]


def test_client_module_surface():
    for name in (
        "WALLET_CURRENCY",
        "WALLET_STATUSES",
        "WALLET_ENTRY_KINDS",
        "WALLET_HOLD_STATES",
        "PLATFORM_WALLET_ID",
        "WalletSummary",
        "WALLET_SUMMARY_FIELDS",
        "buildWalletSummary",
        "planWalletCreation",
        "formatWalletAmount",
        "copyKeyForWalletStatus",
        "copyKeyForEntryKind",
        "copyKeyForHoldState",
        "walletHonoursAmendment",
    ):
        assert name in CLIENT_WV, name
    # The three pinned refusal reasons.
    for reason in ('"invalid-input"', '"not-kyc-verified"', '"wallet-exists"'):
        assert reason in CLIENT_WV, reason


def test_wallet_summary_has_no_free_text_by_construction():
    # AMD-PAY-10/11: six structured fields; a seventh refuses.
    card_block = _block(CLIENT_WV, "export interface WalletSummary", "\n}")
    assert "walletId: string;" in card_block
    assert "status: WalletStatus;" in card_block
    assert "balanceMinor: number;" in card_block
    assert "heldMinor: number;" in card_block
    assert "availableMinor: number;" in card_block
    for banned in ("note", "memo", "message", "label"):
        assert banned not in card_block, banned
    assert (
        "WALLET_SUMMARY_FIELDS = [" in CLIENT_WV
        and '"availableMinor",\n] as const' in CLIENT_WV
    )


def test_client_guard_is_non_vacuous():
    guard = _block(CLIENT_WV, "export function walletHonoursAmendment", "\n}")
    assert "WALLET_ENTRY_KINDS.length !== 6" in guard
    assert 'PLATFORM_WALLET_ID !== "00000000-0000-0000-0000-00000000fee1"' in guard
    assert 'note: "savings"' in guard
    assert "availableMinor: 999_999" in guard
    assert 'formatWalletAmount(1_250_000) === "₦12,500.00"' in guard


def test_copy_registry_gained_the_wallet_keys():
    for key in (
        '"ui.wallet.title"',
        '"ui.wallet.balance"',
        '"ui.wallet.available"',
        '"ui.wallet.held"',
        '"ui.wallet.create"',
        '"ui.wallet.exists"',
        '"ui.wallet.kyc-required"',
    ):
        assert key in COPY, key
    # Every status, entry kind and hold state has a label.
    for status in ("active", "frozen", "closed"):
        assert f'"ui.wallet.status.{status}"' in COPY, status
    for kind in ("fund", "withdrawal", "transfer_out", "transfer_in",
                 "fee_charge", "fee_revenue"):
        assert f'"ui.wallet.entry.{kind}"' in COPY, kind
    for state in ("pending", "posted", "voided"):
        assert f'"ui.wallet.hold.{state}"' in COPY, state


def test_app_shell_asserts_the_wallet_amendment():
    assert (
        'import { walletHonoursAmendment } from "./src/presence/walletView.js";'
        in APP_TSX
    )
    assert "walletHonoursAmendment()," in APP_TSX


def test_client_tests_cover_the_contract():
    for anchor in (
        "the wallet vocabularies are pinned to the amendment values",
        "a wallet summary is id, currency, status and three amounts — never a note",
        "planWalletCreation refuses with exactly one reason",
        "wallet amounts format as naira deterministically",
        "the master guard holds and is not vacuous",
    ):
        assert anchor in CLIENT_TEST, anchor


def test_readme_row_present():
    assert "`src/presence/walletView.ts`" in README
    assert "AMD-PAY-10..14" in README
    assert "byte-identical to the edge copies" in README


# --------------------------------------------------------------------- docs


def test_ux_doc_declares_the_map_and_the_gaps():
    for anchor in (
        "create_wallet",
        "wallet_move",
        "place_wallet_hold",
        "void_wallet_hold",
        "settle_transfer_funds",
        "set_wallet_status",
        "wallet_balances",
        "app.transfer_settlement",
        "POST/GET /v1/wallets",
        "00000000-0000-0000-0000-00000000fee1",
        "Settlement rails (Mojaloop / TigerBeetle)",
        "Free-text fields of any kind",
        "Non-NGN currencies",
        "DSAR export of wallets",
        "tests/test_batch53.py",
    ):
        assert anchor in UX_DOC, anchor


def test_transfers_doc_points_at_the_wallet_layer():
    assert "docs/ux/wallets.md" in TRANSFERS_DOC
    assert "AMD-PAY-10..14" in TRANSFERS_DOC


# --------------------------------------------------------------- DSAR/erasure


def test_dsar_export_gains_the_wallet_history_with_every_key_preserved():
    # AMD-PAY-14: one wholesale CREATE OR REPLACE, forward-only — the 0026
    # body is the baseline and every key it carried survives.
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
    # The wallets key carries the entry ledger and hold history inline.
    wallets_block = _block(MIGRATION, "'wallets', COALESCE(", "'[]'::jsonb)\n    )")
    for field in ("'walletId'", "'currency'", "'status'", "'createdAt'",
                  "'entries'", "'holds'", "'balanceAfter'", "'transferId'",
                  "'holdId'", "'resolvedAt'"):
        assert field in wallets_block, field
    assert "FROM wallet_entries e" in wallets_block
    assert "FROM wallet_holds h" in wallets_block
    assert "FROM wallets w WHERE w.owner = uid" in wallets_block
    # FR-32/34 masking clauses carried forward verbatim.
    assert "CASE WHEN m.close_reason = 'declined' THEN 'expired'" in MIGRATION
    assert "m.close_reason <> 'blocked'" in MIGRATION
    # Grant discipline identical to every previous round.
    assert "REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC" in MIGRATION
    assert "GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app" in MIGRATION
    # The 0026 body stays in its file — newest wins by ordering, never by
    # editing history.
    assert "'transfers'" in MIGRATION_0026


def test_wallet_rows_are_never_erased_anywhere():
    # AMD-PAY-11/14: no migration may erase or rewrite wallet rows — the
    # append-only discipline has no erasure exception, not even in the
    # account-deletion path.
    for banned in (
        "DELETE FROM wallets",
        "DELETE FROM wallet_entries",
        "DELETE FROM wallet_holds",
        "DROP TABLE wallets",
        "DROP TABLE wallet_entries",
        "DROP TABLE wallet_holds",
        "TRUNCATE wallets",
        "TRUNCATE wallet_entries",
        "TRUNCATE wallet_holds",
    ):
        assert banned not in ALL_MIGRATIONS, banned
    # The delete_account definer makes no mention of the wallet tables.
    delete_block = MIGRATION_0003[MIGRATION_0003.index(
        "CREATE OR REPLACE FUNCTION delete_account"):]
    delete_block = delete_block[: delete_block.index("END $$;")]
    assert "wallet" not in delete_block


# ----------------------------------------------------------- traceability


def test_migration_mounted_and_routes_documented():
    # The b23 regression guard: every migration rides the initdb ConfigMap,
    # ordered after 28_dsar_transfers.sql so the wallet-aware export wins.
    assert "=db/migrations/0027_wallets.sql" in K8S_README
    assert "29_wallets.sql" in K8S_README
    assert "/docker-entrypoint-initdb.d/29_wallets.sql:ro" in COMPOSE
    # TECH-14: the five wallet wires are in the OpenAPI contract.
    for path in (
        "/v1/wallets:",
        "/v1/wallets/{walletId}/entries:",
        "/v1/moderation/wallets/{walletId}/freeze:",
        "/v1/moderation/wallets/{walletId}/unfreeze:",
    ):
        assert path in OPENAPI, path
    assert "AMD-PAY-10" in OPENAPI and "AMD-PAY-13" in OPENAPI
    assert "AMD-PAY-14" in OPENAPI


def test_traceability_counts_unchanged():
    # Amendments carry AMD- identifiers in the addendum ledger — the
    # original 306-requirement counts do not move.
    assert "| implemented | 234 |" in TRACEABILITY
    assert "| partial | 6 |" in TRACEABILITY
    assert "| gap-p0 | 0 |" in TRACEABILITY
    assert "| client | 0 |" in TRACEABILITY
