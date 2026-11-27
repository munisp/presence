"""Batch 49 invariants — the P2P transfer contracts (SRS Addendum 001,
AMD-PAY-03..08): the dual-consent transfer state machine enforced in the
database, the pinned caps and fee, eligibility proved at both moments,
the append-only ledger, the dispute path, and the client transfer card
with no free text by construction.

The 306-requirement ledger stays untouched: amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md, so the traceability counts
stay 234/6/0. AMD-PAY-02/08: the Mojaloop/TigerBeetle deployment gate
(TECH-23) stands — 'settled' is reachable only through a
transaction-local setting no P0 component sets.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "client"
EDGE = ROOT / "services/edge"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0025_p2p_transfers.sql").read_text()
EDGE_TRANSFERS = (EDGE / "src/transfers.ts").read_text()
EDGE_ROUTES = (EDGE / "src/routes/transfers.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
EDGE_TEST = (EDGE / "test/transfers.test.ts").read_text()
CLIENT_TC = (CLIENT / "src/presence/transferCard.ts").read_text()
CLIENT_TEST = (CLIENT / "test/transferCard.test.ts").read_text()
COPY = (CLIENT / "src/presence/copyRegistry.ts").read_text()
APP_TSX = (CLIENT / "App.tsx").read_text()
README = (CLIENT / "README.md").read_text()
UX_DOC = (ROOT / "docs/ux/p2p-transfers.md").read_text()
IDENTITY_DOC = (ROOT / "docs/ux/identity-assurance.md").read_text()
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


def test_batch49_files_exist():
    for path in (
        "db/migrations/0025_p2p_transfers.sql",
        "services/edge/src/transfers.ts",
        "services/edge/src/routes/transfers.ts",
        "services/edge/test/transfers.test.ts",
        "client/src/presence/transferCard.ts",
        "client/test/transferCard.test.ts",
        "docs/ux/p2p-transfers.md",
    ):
        assert (ROOT / path).exists(), path


# --------------------------------------------------------------- addendum


def test_addendum_records_the_transfer_contracts():
    for amd in (
        "AMD-PAY-03",
        "AMD-PAY-04",
        "AMD-PAY-05",
        "AMD-PAY-06",
        "AMD-PAY-07",
        "AMD-PAY-08",
    ):
        assert amd in ADDENDUM, amd
    # AMD-PAY-03: no free text, by construction.
    assert "There is no memo, note, or message field" in ADDENDUM
    assert "FR-96/SEC-37 screening is unchanged" in ADDENDUM
    # AMD-PAY-04: database-enforced legality (FR-29 discipline).
    assert "MUST be enforced by the database" in ADDENDUM
    # AMD-PAY-05: the pinned caps and the sixth-revenue-line fee.
    assert "NGN 50,000.00" in ADDENDUM and "NGN 150,000.00" in ADDENDUM
    assert "100 basis points" in ADDENDUM
    # AMD-PAY-06: eligibility proved at both moments.
    assert "eligibility, proved twice" in ADDENDUM
    # AMD-PAY-07/08: the ledger and the tangible settlement gate.
    assert "append-only" in ADDENDUM
    assert "app.transfer_settlement" in ADDENDUM
    # AMD-PAY-02 still stands (the b48 pin keeps guarding it too).
    assert "MUST NOT be deployed until the payments compliance programme is approved" in ADDENDUM


# --------------------------------------------------------------- migration


def test_transfers_table_is_structured_only():
    # AMD-PAY-03: amount, currency, fee, state — nothing free-form.
    assert "CREATE TABLE transfers (" in MIGRATION
    assert "amount_minor bigint NOT NULL CHECK (amount_minor > 0)" in MIGRATION
    assert "fee_minor    bigint NOT NULL CHECK (fee_minor >= 0)" in MIGRATION
    assert "currency    text NOT NULL CHECK (currency = 'NGN')" in MIGRATION
    assert "CHECK (sender <> recipient)" in MIGRATION
    assert "resolved_outcome text CHECK (resolved_outcome IN ('upheld', 'rejected'))" in MIGRATION
    # No free-text column can exist on either table.
    table_block = _block(MIGRATION, "CREATE TABLE transfers (", "CHECK (sender <> recipient)")
    for banned in ("memo", "note", "message", "description", "comment"):
        assert banned not in table_block, banned


def test_transfer_events_ledger_is_append_only():
    # AMD-PAY-07: the trigger raises, and the app role gets no write grants.
    assert "CREATE TABLE transfer_events (" in MIGRATION
    assert "CREATE OR REPLACE FUNCTION transfer_events_append_only() RETURNS trigger" in MIGRATION
    assert "RAISE EXCEPTION 'transfer_events is append-only (AMD-PAY-07)'" in MIGRATION
    assert "BEFORE UPDATE OR DELETE ON transfer_events" in MIGRATION
    assert "GRANT SELECT ON transfer_events TO presence_app;" in MIGRATION
    assert "GRANT SELECT ON transfers TO presence_app;" in MIGRATION
    for banned in (
        "GRANT UPDATE ON transfer_events",
        "GRANT DELETE ON transfer_events",
        "GRANT INSERT ON transfer_events",
        "GRANT INSERT ON transfers",
        "GRANT UPDATE ON transfers",
    ):
        assert banned not in MIGRATION, banned


def test_propose_transfer_definer_decides_everything():
    assert "CREATE OR REPLACE FUNCTION propose_transfer(" in MIGRATION
    assert "LANGUAGE plpgsql SECURITY DEFINER SET search_path = public" in MIGRATION
    # The definer bypasses RLS — the sender claim must be the caller's own.
    assert "p_sender IS DISTINCT FROM app_user()" in MIGRATION
    # AMD-PAY-05: the pinned caps and the fee computed in the database.
    assert "p_amount_minor > 5000000" in MIGRATION
    assert "v_daily + p_amount_minor > 15000000" in MIGRATION
    assert "(p_amount_minor * 100) / 10000" in MIGRATION
    assert "interval '24 hours'" in MIGRATION
    # AMD-PAY-06: both parties verified, no payment suspension, OPEN pair.
    assert MIGRATION.count("SELECT 1 FROM kyc_verified_accounts WHERE user_id = p_") >= 2
    assert "has_active_suspension(p_sender, 'payment_instrument')" in MIGRATION
    assert "has_active_suspension(p_recipient, 'payment_instrument')" in MIGRATION
    assert "WHERE m.state = 'OPEN'" in MIGRATION
    assert "interval '1 hour'" in MIGRATION
    # The refusal vocabulary.
    for outcome in (
        "'proposed'",
        "'forbidden'",
        "'invalid_amount'",
        "'over_transfer_cap'",
        "'over_daily_cap'",
        "'not_kyc_verified'",
        "'suspended'",
        "'no_open_conversation'",
    ):
        assert outcome in MIGRATION, outcome


def test_record_transfer_event_enforces_machine_roles_and_gate():
    assert "CREATE OR REPLACE FUNCTION record_transfer_event(" in MIGRATION
    assert "FOR UPDATE" in MIGRATION
    # AMD-PAY-04: roles — recipient answers, sender cancels, either disputes,
    # moderation resolves.
    assert "p_event IN ('accepted', 'declined') AND p_actor <> v.recipient" in MIGRATION
    assert "p_event = 'cancelled' AND p_actor <> v.sender" in MIGRATION
    assert "p_event = 'disputed' AND p_actor NOT IN (v.sender, v.recipient)" in MIGRATION
    # Caller-bound events must come from the caller (RLS bypass guard).
    assert "p_actor IS DISTINCT FROM app_user()" in MIGRATION
    # AMD-PAY-08: the rail alone settles — the GUC no P0 component sets.
    assert "current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'" in MIGRATION
    # Resolution is moderator-only, closed-vocabulary, and audited.
    assert "IF NOT app_moderator() THEN" in MIGRATION
    assert "p_detail->>'outcome' NOT IN ('upheld', 'rejected')" in MIGRATION
    assert "'transfer.resolved'" in MIGRATION
    assert "admin_audit_log(" in MIGRATION
    # AMD-PAY-06: acceptance re-proves both parties and the OPEN pair.
    accept_block = _block(MIGRATION, "IF p_event = 'accepted' THEN", "UPDATE transfers")
    assert "kyc_verified_accounts" in accept_block
    assert "m.state = 'OPEN'" in accept_block
    assert "RETURN 'not_kyc_verified'" in MIGRATION
    assert "RETURN 'pair_not_open'" in MIGRATION
    assert "RETURN 'not_expired'" in MIGRATION


def test_lazy_expiry_mirrors_the_elevation_tick():
    assert "CREATE OR REPLACE FUNCTION expire_stale_transfers() RETURNS integer" in MIGRATION
    assert "WHERE state = 'proposed' AND expires_at <= now()" in MIGRATION
    assert "PERFORM record_transfer_event(r.transfer_id, NULL, 'expired');" in MIGRATION
    assert "GRANT EXECUTE ON FUNCTION expire_stale_transfers() TO presence_app;" in MIGRATION


# ------------------------------------------------------- cross-layer pins


def test_transfer_transition_table_is_byte_identical_edge_and_client():
    """AMD-PAY-04: the two TS mirrors cannot drift."""
    edge_block = _block(EDGE_TRANSFERS, "export const TRANSFER_TRANSITIONS", "];")
    client_block = _block(CLIENT_TC, "export const TRANSFER_TRANSITIONS", "];")
    assert edge_block == client_block


def test_transfer_transition_table_matches_the_definer():
    """AMD-PAY-04: edge mirror and database definer agree on the eight moves."""
    ts_block = _block(EDGE_TRANSFERS, "export const TRANSFER_TRANSITIONS", "];")
    ts_pairs = set(re.findall(r'\["(\w+)", "(\w+)"\]', ts_block))
    assert len(ts_pairs) == 8
    sql_pairs: set[tuple[str, str]] = set()
    for state, single, multi in re.findall(
        r"\(v\.state = '(\w+)'\s+AND p_event (?:= '(\w+)'|IN \(([^)]*)\))\)",
        MIGRATION,
    ):
        if single:
            sql_pairs.add((state, single))
        else:
            for target in re.findall(r"'(\w+)'", multi):
                sql_pairs.add((state, target))
    assert ts_pairs == sql_pairs


def test_transfer_states_agree_across_layers():
    edge_block = _block(EDGE_TRANSFERS, "export const TRANSFER_STATES", "as const;")
    client_block = _block(CLIENT_TC, "export const TRANSFER_STATES", "as const;")
    assert edge_block == client_block
    for state in (
        "'proposed'",
        "'accepted'",
        "'declined'",
        "'cancelled'",
        "'expired'",
        "'settled'",
        "'disputed'",
        "'resolved'",
    ):
        assert state in MIGRATION, state


def test_constants_are_pinned_identically_edge_and_client():
    for line in (
        'export const TRANSFER_CURRENCY = "NGN";',
        "export const MAX_TRANSFER_MINOR = 5_000_000;",
        "export const DAILY_TRANSFER_CAP_MINOR = 15_000_000;",
        "export const TRANSFER_FEE_BPS = 100;",
        "export const TRANSFER_ACCEPT_WINDOW_MS = 3_600_000;",
        'export const DISPUTE_REASONS = ["not-received", "wrong-amount", "unauthorised"] as const;',
    ):
        assert line in EDGE_TRANSFERS, line
        assert line in CLIENT_TC, line


# ------------------------------------------------------------ edge service


def test_edge_module_surface():
    for name in (
        "TRANSFER_STATES",
        "TRANSFER_TRANSITIONS",
        "isTransferState",
        "isLegalTransferTransition",
        "TRANSFER_CURRENCY",
        "MAX_TRANSFER_MINOR",
        "DAILY_TRANSFER_CAP_MINOR",
        "TRANSFER_FEE_BPS",
        "TRANSFER_ACCEPT_WINDOW_MS",
        "computeFeeMinor",
        "DISPUTE_REASONS",
        "parseTransferProposal",
        "parseTransferDispute",
        "parseDisputeOutcome",
    ):
        assert name in EDGE_TRANSFERS, name


def test_edge_routes_are_the_seven_transfer_wires():
    assert 'app.post(\n    "/v1/transfers"' in EDGE_ROUTES
    assert 'app.get("/v1/transfers"' in EDGE_ROUTES
    assert '"/v1/transfers/:transferId/accept"' in EDGE_ROUTES
    assert '"/v1/transfers/:transferId/decline"' in EDGE_ROUTES
    assert '"/v1/transfers/:transferId/cancel"' in EDGE_ROUTES
    assert '"/v1/transfers/:transferId/dispute"' in EDGE_ROUTES
    assert '"/v1/moderation/transfers/:transferId/resolve"' in EDGE_ROUTES
    # The definers decide; the routes only map outcomes.
    assert "FROM propose_transfer($1, $2, $3)" in EDGE_ROUTES
    assert EDGE_ROUTES.count("record_transfer_event($1, $2") >= 4
    assert "SELECT expire_stale_transfers()" in EDGE_ROUTES
    assert "preHandler: requireModerator" in EDGE_ROUTES
    # TR-23 strict bodies.
    assert "additionalProperties: false" in EDGE_ROUTES


def test_no_settle_route_exists():
    """AMD-PAY-08: the rail gate made tangible — no route, no GUC write.

    The header comment may NAME the gate; what must not exist is a wire
    that reaches it: no /settle path, and nothing that sets the
    transaction-local flag (set_config or SET LOCAL).
    """
    assert "settle" not in [m.group(1) for m in re.finditer(r'"(/v1/[^"]*)"', EDGE_ROUTES)]
    assert "set_config('app.transfer_settlement'" not in EDGE_ROUTES
    assert "SET LOCAL app.transfer_settlement" not in EDGE_ROUTES
    assert "SET app.transfer_settlement" not in EDGE_ROUTES


def test_edge_app_registers_the_routes():
    assert 'import { registerTransferRoutes } from "./routes/transfers.js";' in EDGE_APP
    assert "registerTransferRoutes(authed, ctx);" in EDGE_APP


def test_edge_tests_cover_the_validators():
    for anchor in (
        "AMD-PAY-04: the eight states and the eight legal transitions are pinned",
        "AMD-PAY-05: caps, fee and currency are pinned to the amendment values",
        "parseTransferProposal",
        "parseTransferDispute",
        "parseDisputeOutcome",
        "5_000_000",
    ):
        assert anchor in EDGE_TEST, anchor


# ------------------------------------------------------------------ client


def test_client_module_is_import_free():
    assert _imports(CLIENT_TC) == []


def test_client_module_surface():
    for name in (
        "TRANSFER_STATES",
        "TRANSFER_TRANSITIONS",
        "isLegalTransferTransition",
        "computeFeeMinor",
        "DISPUTE_REASONS",
        "TransferCard",
        "TRANSFER_CARD_FIELDS",
        "buildTransferCard",
        "planTransfer",
        "formatTransferAmount",
        "copyKeyForTransferState",
        "transferHonoursAmendment",
    ):
        assert name in CLIENT_TC, name
    # The five pinned refusal reasons.
    for reason in (
        '"invalid-input"',
        '"over-transfer-cap"',
        '"not-kyc-verified"',
        '"no-open-conversation"',
        '"over-daily-cap"',
    ):
        assert reason in CLIENT_TC, reason


def test_transfer_card_has_no_free_text_by_construction():
    # AMD-PAY-03: the card type is amount, fee, currency, state — there is
    # no free-text field to populate, and the pinned field set says so.
    card_block = _block(CLIENT_TC, "export interface TransferCard", "\n}")
    assert "amountMinor: number;" in card_block
    assert "feeMinor: number;" in card_block
    assert "currency: string;" in card_block
    assert "state: TransferState;" in card_block
    for banned in ("note", "memo", "message"):
        assert banned not in card_block, banned
    assert (
        'TRANSFER_CARD_FIELDS = ["amountMinor", "feeMinor", "currency", "state"] as const'
        in CLIENT_TC
    )


def test_client_guard_is_non_vacuous():
    guard = _block(CLIENT_TC, "export function transferHonoursAmendment", "\n}")
    assert "TRANSFER_TRANSITIONS.length !== 8" in guard
    assert "DISPUTE_REASONS.length !== 3" in guard
    assert 'isLegalTransferTransition("proposed", "settled") === false' in guard
    assert 'note: "pay me"' in guard
    assert 'formatTransferAmount(1_250_000, "NGN") === "₦12,500.00"' in guard


def test_copy_registry_gained_the_transfer_keys():
    for key in (
        '"ui.transfer.title"',
        '"ui.transfer.fee"',
        '"ui.transfer.accept"',
        '"ui.transfer.decline"',
        '"ui.transfer.cancel"',
        '"ui.transfer.dispute"',
        '"ui.transfer.kyc-required"',
        '"ui.transfer.open-required"',
    ):
        assert key in COPY, key
    # Every state has a label — the card never renders a raw state string.
    for state in (
        "proposed",
        "accepted",
        "declined",
        "cancelled",
        "expired",
        "settled",
        "disputed",
        "resolved",
    ):
        assert f'"ui.transfer.state.{state}"' in COPY, state


def test_app_shell_asserts_the_transfer_amendment():
    assert (
        'import { transferHonoursAmendment } from "./src/presence/transferCard.js";'
        in APP_TSX
    )
    assert "transferHonoursAmendment()," in APP_TSX


def test_client_tests_cover_the_contract():
    for anchor in (
        "the transfer states and legal-transition table are pinned",
        "caps, fee and currency are pinned to the amendment values",
        "a transfer card is amount, fee, currency and state — never a note",
        "planTransfer refuses with exactly one reason",
        "amounts format as naira deterministically",
        "the master guard holds and is not vacuous",
    ):
        assert anchor in CLIENT_TEST, anchor


# --------------------------------------------------------------------- docs


def test_readme_row_present():
    assert "`src/presence/transferCard.ts`" in README
    assert "AMD-PAY" in README
    assert "byte-identical to the edge copies" in README


def test_ux_doc_declares_the_map_and_the_gaps():
    for anchor in (
        "propose_transfer",
        "record_transfer_event",
        "expire_stale_transfers",
        "app.transfer_settlement",
        "POST/GET /v1/transfers",
        "not-received",
        "Settlement rails (Mojaloop / TigerBeetle)",
        "Free-text memos",
        "Non-NGN currencies",
        "DSAR export of transfers",
    ):
        assert anchor in UX_DOC, anchor


def test_identity_doc_records_the_landing():
    # The b48 "not here" entry stays (its pins keep passing) and now points
    # at the delivered contracts.
    assert "Peer-to-peer payments" in IDENTITY_DOC
    assert "docs/ux/p2p-transfers.md" in IDENTITY_DOC
    assert "the deployment gate still stands" in IDENTITY_DOC


# ----------------------------------------------------------- traceability


def test_migration_mounted_and_routes_documented():
    # The b23 regression guard: every migration rides the initdb ConfigMap.
    assert "=db/migrations/0025_p2p_transfers.sql" in K8S_README
    assert "/docker-entrypoint-initdb.d/27_p2p_transfers.sql:ro" in COMPOSE
    # TECH-14: the seven transfer wires are in the OpenAPI contract.
    for path in (
        "/v1/transfers:",
        "/v1/transfers/{transferId}/accept:",
        "/v1/transfers/{transferId}/decline:",
        "/v1/transfers/{transferId}/cancel:",
        "/v1/transfers/{transferId}/dispute:",
        "/v1/moderation/transfers/{transferId}/resolve:",
    ):
        assert path in OPENAPI, path
    assert "AMD-PAY-01/05/06" in OPENAPI and "AMD-PAY-04/07" in OPENAPI


def test_traceability_counts_unchanged():
    # Amendments carry AMD- identifiers in the addendum ledger — the
    # original 306-requirement counts do not move.
    # Batch 70 closed TR-44 (the final phase-gated requirement): 234 → 235, phase-gated 1 → 0.
    assert "| implemented | 235 |" in TRACEABILITY
    assert "| partial | 6 |" in TRACEABILITY
    assert "| gap-p0 | 0 |" in TRACEABILITY
    assert "| client | 0 |" in TRACEABILITY
