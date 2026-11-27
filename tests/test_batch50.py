"""Batch 50 invariants — DSAR inclusion of the transfer history (SRS
Addendum 001, AMD-PAY-09): the FR-62 export document carries the subject's
transfer rows with their event ledgers inline, every key the export
already carried is preserved verbatim, masking discipline (FR-32/34) is
unchanged, and transfer rows survive account deletion tied to the
anonymous tombstone — the AMD-PAY-07 append-only discipline has no
erasure exception.

The 306-requirement ledger stays untouched: AMD-PAY-09 lives in
docs/spec/srs-addendum-001.md, so the traceability counts stay 234/6/0.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / "services/edge"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0026_dsar_transfers.sql").read_text()
MIGRATION_0003 = (ROOT / "db/migrations/0003_account_deletion.sql").read_text()
MIGRATION_0020 = (ROOT / "db/migrations/0020_venue_registry.sql").read_text()
MIGRATION_0025 = (ROOT / "db/migrations/0025_p2p_transfers.sql").read_text()
ALL_MIGRATIONS = "\n".join(
    p.read_text() for p in sorted((ROOT / "db/migrations").glob("*.sql"))
)
UX_DOC = (ROOT / "docs/ux/p2p-transfers.md").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
ACCOUNT_ROUTE = (EDGE / "src/routes/account.ts").read_text()
TRACEABILITY = (ROOT / "docs/traceability.md").read_text()


# ------------------------------------------------------------------ files


def test_batch50_files_exist():
    assert (ROOT / "db/migrations/0026_dsar_transfers.sql").exists()


# --------------------------------------------------------------- addendum


def test_addendum_records_dsar_inclusion():
    assert "AMD-PAY-09" in ADDENDUM
    # Inclusion: the export carries the transfer history with its ledger.
    assert "MUST include the subject's transfer history" in ADDENDUM
    assert "event ledger inline" in ADDENDUM
    # Masking discipline unchanged; financial records outrank pair masking.
    assert "financial record, not a conversation artefact" in ADDENDUM
    # Retention: rows survive deletion tied to the tombstone; no erasure.
    assert "survive account deletion" in ADDENDUM
    assert "MUST NOT erase or rewrite transfer or transfer_event rows" in ADDENDUM
    # The footer records the batch and its verification anchor.
    assert "AMD-PAY-09 added alongside batch 50" in ADDENDUM
    assert "tests/test_batch50.py" in ADDENDUM


# --------------------------------------------------------------- migration


def test_migration_replaces_export_and_preserves_every_existing_key():
    # AMD-PAY-09: one wholesale CREATE OR REPLACE, forward-only — the
    # 0020-era body is the baseline and every key it carried survives.
    assert "CREATE OR REPLACE FUNCTION dsar_export(uid uuid) RETURNS jsonb" in MIGRATION
    assert "0020-era dsar_export body wholesale" in MIGRATION
    for key in (
        "'user'",
        "'identity'",
        "'interests'",
        "'pairs'",
        "'ledgerActions'",
        "'blocksFiled'",
        "'reportsFiled'",
        "'dataProcessingConsents'",
    ):
        assert key in MIGRATION, key
    # FR-32/34 masking clauses carried forward verbatim.
    assert "CASE WHEN m.close_reason = 'declined' THEN 'expired'" in MIGRATION
    assert "m.close_reason <> 'blocked'" in MIGRATION
    # Grant discipline identical to every previous round.
    assert "REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC" in MIGRATION
    assert "GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app" in MIGRATION


def test_transfers_key_carries_the_full_record_with_events_inline():
    assert "'transfers'" in MIGRATION
    for field in (
        "'transferId'",
        "'pairId'",
        "'role'",
        "'counterparty'",
        "'amountMinor'",
        "'feeMinor'",
        "'currency'",
        "'state'",
        "'proposedAt'",
        "'expiresAt'",
        "'resolvedOutcome'",
        "'updatedAt'",
        "'events'",
    ):
        assert field in MIGRATION, field
    # The subject's own perspective: role and counterparty derived from uid.
    assert "CASE WHEN t.sender = uid THEN 'sender' ELSE 'recipient' END" in MIGRATION
    assert "CASE WHEN t.sender = uid THEN t.recipient ELSE t.sender END" in MIGRATION
    # Party scope, matching the 0025 RLS read contract exactly.
    assert "FROM transfers t WHERE uid IN (t.sender, t.recipient)" in MIGRATION
    # The event ledger rides inline, chronological.
    assert "FROM transfer_events e" in MIGRATION
    assert "WHERE e.transfer_id = t.transfer_id" in MIGRATION


def test_transfer_rows_are_never_erased_anywhere():
    # AMD-PAY-07/09: no migration may erase or rewrite transfer rows — the
    # append-only discipline has no erasure exception, not even in the
    # account-deletion path.
    for banned in (
        "DELETE FROM transfers",
        "DELETE FROM transfer_events",
        "DROP TABLE transfers",
        "DROP TABLE transfer_events",
        "TRUNCATE transfers",
        "TRUNCATE transfer_events",
    ):
        assert banned not in ALL_MIGRATIONS, banned
    # The delete_account definer is untouched by this batch and still makes
    # no mention of the transfer tables.
    delete_block = MIGRATION_0003[MIGRATION_0003.index(
        "CREATE OR REPLACE FUNCTION delete_account"):]
    delete_block = delete_block[: delete_block.index("END $$;")]
    assert "transfers" not in delete_block
    # The append-only trigger from 0025 still stands.
    assert "transfer_events is append-only (AMD-PAY-07)" in MIGRATION_0025


def test_prior_export_definers_preserved_forward_only():
    # Forward-only discipline: earlier bodies stay in their files; the
    # newest body wins at apply time by ordering, never by editing history.
    assert "CREATE OR REPLACE FUNCTION dsar_export(uid uuid)" in MIGRATION_0003
    assert "CREATE OR REPLACE FUNCTION dsar_export(uid uuid)" in MIGRATION_0020
    assert "'reportsFiled'" in MIGRATION_0003
    assert "'dataProcessingConsents'" in MIGRATION_0020


# --------------------------------------------------------------------- docs


def test_ux_doc_records_the_inclusion():
    assert "AMD-PAY-09" in UX_DOC
    assert "dsar_export" in UX_DOC
    assert "migration 0026" in UX_DOC
    # The b49 anchor string survives — now in the component map, not in the
    # NOT-here list.
    assert "DSAR export of transfers" in UX_DOC
    assert "tracked openly rather than smuggled into this batch" not in UX_DOC
    assert "does not yet" not in UX_DOC
    assert "tests/test_batch50.py" in UX_DOC


def test_openapi_documents_transfer_history_in_export():
    block = OPENAPI[OPENAPI.index("/v1/account/export:"):]
    block = block[: block.index("/v1/account/visibility:")]
    assert "transfer history" in block
    assert "AMD-PAY-09" in block


def test_migration_mounted():
    # The b23 regression guard: every migration rides the initdb mounts.
    assert "=db/migrations/0026_dsar_transfers.sql" in K8S_README
    assert "28_dsar_transfers.sql" in K8S_README
    assert "/docker-entrypoint-initdb.d/28_dsar_transfers.sql:ro" in COMPOSE


def test_export_route_needs_no_change():
    # The route passes the document through untouched; the new key flows
    # automatically. Any route edit would be scope to justify.
    assert "SELECT dsar_export($1::uuid) AS doc" in ACCOUNT_ROUTE


# ----------------------------------------------------------- traceability


def test_traceability_counts_unchanged():
    # Amendments carry AMD- identifiers in the addendum ledger — the
    # original 306-requirement counts do not move.
    # Batch 70 closed TR-44 (the final phase-gated requirement): 234 → 235, phase-gated 1 → 0.
    assert "| implemented | 235 |" in TRACEABILITY
    assert "| partial | 6 |" in TRACEABILITY
    assert "| gap-p0 | 0 |" in TRACEABILITY
    assert "| client | 0 |" in TRACEABILITY
