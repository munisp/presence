"""Batch 58 invariants — escrow hardening (SRS Addendum 001, AMD-ESC-01..03):

  AMD-ESC-01  four-eyes dispute resolution above the pinned threshold
              (1,000,000 minor of REMAINING pending milestone value): an
              escrow_resolve_approvals row freezes escrow, decision,
              remaining value and proposer; a different moderator must
              approve; self-approval is refused; approval matches the
              decision; one pending approval per escrow; value never moves
              while gated; marketplace orders propagate on EVERY resolution
              path (direct and approved alike).
  AMD-ESC-02  dispute liveness: disputed_at stamped at dispute time;
              wallet_reconciliation appends the escrow governance queues to
              the seven preserved keys; the edge scrapes
              presence_escrow_oldest_dispute_seconds; EscrowDisputeAging
              pages the trust-safety lead past the 24 h SLA. Value MUST
              NEVER move on a timer — visibility only.
  AMD-ESC-03  scripts/rehearse_full_chain.py applies every migration in
              order against a scratch database (extension surface stubbed,
              stubs named in the script header) and exercises the escrow
              lifecycle end to end. The first run caught two return-type
              redefinitions (lifecycle_tick 0002->0003, fund_wallet
              0028->0029) and one missing column (appeals.report_id in
              0019) that lint-only review never saw — fixed in place with
              DROP-first / ADD COLUMN so fresh-environment applies succeed.

The 306-requirement ledger stays untouched; amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / "services/edge"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0033_escrow_hardening.sql").read_text()
EDGE_METRICS = (EDGE / "src/metrics.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
EDGE_INNOVATIONS = (EDGE / "src/routes/innovations.ts").read_text()
EDGE_MARKET_ROUTES = (EDGE / "src/routes/marketplace.ts").read_text()
ALERTS = (ROOT / "deploy/k8s/prometheusrules.yaml").read_text()
RUNBOOK = (ROOT / "docs/runbook.md").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
REHEARSAL = (ROOT / "scripts/rehearse_full_chain.py").read_text()
TARGETS = (ROOT / "loadtest/targets.js").read_text()
RACE = (ROOT / "loadtest/escrow-concurrency.js").read_text()
LOADTEST_README = (ROOT / "loadtest/README.md").read_text()


def _fn_body(src: str, name: str) -> str:
    start = src.index(f"CREATE OR REPLACE FUNCTION {name}(")
    end = src.index("END $$;", start)
    return src[start:end]


# ----------------------------------------------------------- migration ---

def test_addendum_documents_the_amendment():
    for n in range(1, 4):
        assert f"AMD-ESC-{n:02d}" in ADDENDUM, n
    assert "batch 58" in ADDENDUM
    # The liveness rule is visibility-only, stated in the amendment.
    assert "MUST NEVER move on a timer" in ADDENDUM


def test_approvals_table_freezes_the_terms():
    assert "CREATE TABLE escrow_resolve_approvals" in MIGRATION
    assert re.search(r"decision\s+text\s+NOT NULL\s+CHECK \(decision IN \('refund', 'release'\)\)",
                     MIGRATION)
    assert "remaining_minor" in MIGRATION
    assert re.search(r"state\s+text\s+NOT NULL\s+DEFAULT 'pending'\s+"
                     r"CHECK \(state IN \('pending', 'approved', 'rejected'\)\)",
                     MIGRATION)
    # One pending approval per escrow, enforced structurally.
    assert re.search(r"CREATE UNIQUE INDEX escrow_resolve_approvals_pending\s+"
                     r"ON escrow_resolve_approvals \(escrow_id\) WHERE state = 'pending'",
                     MIGRATION)
    # Append-only + immutable terms + legal transitions, AMD-ESC-01 labelled.
    assert "escrow_resolve_approvals is append-only (AMD-ESC-01)" in MIGRATION
    assert "escrow resolution terms are immutable (AMD-ESC-01)" in MIGRATION
    assert "illegal escrow resolution transition (AMD-ESC-01)" in MIGRATION
    assert re.search(r"CREATE TRIGGER escrow_resolve_approvals_guard\s+"
                     r"BEFORE UPDATE OR DELETE ON escrow_resolve_approvals",
                     MIGRATION)
    # RLS with no policies and no grants: definers only.
    assert "ALTER TABLE escrow_resolve_approvals ENABLE ROW LEVEL SECURITY" in MIGRATION
    assert "CREATE POLICY" not in MIGRATION
    assert not re.search(r"GRANT \w+ ON escrow_resolve_approvals", MIGRATION)


def test_resolve_escrow_gates_above_the_threshold():
    body = _fn_body(MIGRATION, "resolve_escrow")
    # The threshold applies to REMAINING pending milestone value.
    assert re.search(r"sum\(m\.amount_minor\).*?state = 'pending'", body, re.S)
    assert "v_remaining > 1000000" in body
    # The approval must match the decision and come from a second moderator.
    assert "ap.decision = p_decision" in body
    assert "ap.proposed_by <> v_user" in body
    assert "ap.state = 'approved'" in body
    # Gated: insert-or-keep the single pending row, audit, refuse to move.
    assert "ON CONFLICT (escrow_id) WHERE state = 'pending' DO NOTHING" in body
    assert "'approval_proposed'" in body
    assert "RETURN 'approval_required';" in body
    # The gate lands BEFORE any wallet write in the function.
    assert body.index("'approval_required'") < body.index("void_wallet_hold")
    assert body.index("'approval_required'") < body.index("INSERT INTO wallet_entries")


def test_resolve_escrow_propagates_to_marketplace_on_every_path():
    body = _fn_body(MIGRATION, "resolve_escrow")
    # The order/listing bookkeeping lives in resolve_escrow so the approved
    # path (approve_escrow_resolution) cannot leave an order dangling.
    assert re.search(r"UPDATE marketplace_orders o\s+SET state = CASE", body)
    assert "WHERE o.escrow_id = p_escrow AND o.state = 'disputed'" in body
    assert "RETURNING * INTO v_order" in body
    assert "'disputed', 'refunded'" in body and "'held', 'listed'" in body
    assert "'disputed', 'completed'" in body and "'held', 'sold'" in body
    # Propagation runs before the audit write that closes the function.
    assert body.index("UPDATE marketplace_orders") < body.rindex("admin_audit_log")


def test_resolve_purchase_is_a_pure_delegate():
    body = _fn_body(MIGRATION, "resolve_purchase")
    assert "RETURN 'approval_required';" in body
    assert "RETURN 'escrow_error';" in body
    # No duplicated bookkeeping — resolve_escrow owns propagation.
    assert "UPDATE marketplace_orders" not in body
    assert "marketplace_events" not in body


def test_approve_and_reject_mirror_the_credit_approval_pattern():
    body = _fn_body(MIGRATION, "approve_escrow_resolution")
    for outcome in ("forbidden", "unknown_approval", "illegal_state",
                    "self_approval", "escrow_not_disputed"):
        assert f"RETURN '{outcome}'" in body, outcome
    assert "a.proposed_by = v_user" in body  # self-approval check
    assert "'approval_granted'" in body
    # Executes the frozen decision in the same transaction and returns its
    # outcome ('resolved' on success).
    assert "v_out := resolve_escrow(a.escrow_id, a.decision);" in body
    assert "RETURN v_out;" in body
    reject = _fn_body(MIGRATION, "reject_escrow_resolution")
    assert "'approval_rejected'" in reject
    assert "RETURN 'rejected'" in reject
    # Reject carries no self-check (no value moves) — same as
    # reject_wallet_credit.
    assert "self_approval" not in reject
    assert re.search(r"CREATE OR REPLACE FUNCTION list_escrow_resolve_approvals\(\)",
                     MIGRATION)
    for fn in ("approve_escrow_resolution(uuid)",
               "reject_escrow_resolution(uuid)",
               "list_escrow_resolve_approvals()"):
        assert f"GRANT EXECUTE ON FUNCTION {fn} TO presence_app" in MIGRATION


def test_dispute_stamps_disputed_at_and_reconciliation_gains_queues():
    assert "ALTER TABLE escrow_agreements ADD COLUMN disputed_at timestamptz" in MIGRATION
    dispute = _fn_body(MIGRATION, "dispute_escrow")
    assert "disputed_at = now()" in dispute
    rec = _fn_body(MIGRATION, "wallet_reconciliation")
    # The seven 0029 keys survive verbatim…
    for key in ("walletsChecked", "balanceMismatches", "platformFeeDelta",
                "stuckHolds", "openWithdrawals", "openRiskSignals",
                "pendingCreditApprovals"):
        assert f"'{key}'" in rec, key
    # …and the four escrow governance queues are appended.
    for key in ("openEscrowDisputes", "oldestEscrowDisputeSeconds",
                "pendingEscrowResolveApprovals", "stuckEscrows"):
        assert f"'{key}'" in rec, key
    assert "min(a.disputed_at)" in rec


# ------------------------------------------------------------------ edge ---

def test_edge_scrapes_the_dispute_age_gauge():
    assert 'presence_escrow_oldest_dispute_seconds' in EDGE_METRICS
    assert "escrowDisputeAge" in EDGE_APP
    assert "min(disputed_at)" in EDGE_APP
    assert "WHERE state = 'disputed'" in EDGE_APP
    # The scrape sits beside the moderation-queue scrape in /metrics.
    scrape = EDGE_APP.index("min(disputed_at)")
    assert EDGE_APP.index("moderationQueueAge") < scrape


def test_four_eyes_routes_and_202_mappings():
    assert '"/v1/moderation/escrow-resolutions"' in EDGE_INNOVATIONS
    assert '"/v1/moderation/escrow-resolutions/:approvalId/approve"' in EDGE_INNOVATIONS
    assert '"/v1/moderation/escrow-resolutions/:approvalId/reject"' in EDGE_INNOVATIONS
    # The escrow resolve route maps the gate to 202 — nothing moved.
    assert 'outcome === "approval_required"' in EDGE_INNOVATIONS
    assert 'reply.code(202).send({ state: "approval_required" })' in EDGE_INNOVATIONS
    # Marketplace order resolve maps it too.
    assert '"approval_required"' in EDGE_MARKET_ROUTES
    assert 'reply.code(202).send({ state: "approval_required" })' in EDGE_MARKET_ROUTES
    # Approve moves value: it is the only new route inside withSettlement,
    # with the moderator GUC passed through for the definer's gates.
    approve = EDGE_INNOVATIONS.index(
        '"/v1/moderation/escrow-resolutions/:approvalId/approve"')
    approve_block = EDGE_INNOVATIONS[approve:approve + 2400]
    assert re.search(r"withSettlement\(\s*ctx\.pg,\s*req\.userId", approve_block)
    assert '"app.moderator"' in approve_block
    assert "approve_escrow_resolution($1)" in approve_block
    assert "self_approval" in approve_block
    # Reject and list are moderator-only reads/writes of the queue — no
    # settlement GUC, mirroring reject_wallet_credit.
    reject = EDGE_INNOVATIONS.index(
        '"/v1/moderation/escrow-resolutions/:approvalId/reject"')
    reject_end = EDGE_INNOVATIONS.index("app.post(", reject + 10)
    reject_block = EDGE_INNOVATIONS[reject:reject_end]
    assert "withModerator(ctx.pg" in reject_block
    assert "withSettlement" not in reject_block
    list_at = EDGE_INNOVATIONS.index('app.get(\n    "/v1/moderation/escrow-resolutions"')
    list_end = EDGE_INNOVATIONS.index("app.post(", list_at + 10)
    list_block = EDGE_INNOVATIONS[list_at:list_end]
    assert "withModerator(ctx.pg" in list_block
    assert "withSettlement" not in list_block
    assert "list_escrow_resolve_approvals()" in list_block
    # Every new moderation route is moderator-gated and rate-limited.
    for route in ('"/v1/moderation/escrow-resolutions"',
                  '"/v1/moderation/escrow-resolutions/:approvalId/approve"',
                  '"/v1/moderation/escrow-resolutions/:approvalId/reject"'):
        at = EDGE_INNOVATIONS.index(route)
        block = EDGE_INNOVATIONS[at:at + 700]
        assert "requireModerator" in block, route
        assert "MODERATION_RATE_LIMIT" in block, route


# ----------------------------------------------------- alerting / runbook ---

def test_dispute_aging_alert_and_runbook():
    assert "EscrowDisputeAging" in ALERTS
    assert re.search(r"max\(presence_escrow_oldest_dispute_seconds\) > 86400",
                     ALERTS)
    assert 'severity: ticket' in ALERTS.split("EscrowDisputeAging")[1][:600]
    assert "docs/runbook.md#escrowdisputeaging" in ALERTS
    assert "## EscrowDisputeAging" in RUNBOOK
    section = RUNBOOK.split("## EscrowDisputeAging")[1]
    assert "openEscrowDisputes" in section
    assert "oldestEscrowDisputeSeconds" in section
    # The runbook points at the four-eyes queue endpoints.
    assert "/v1/moderation/escrow-resolutions" in section


# --------------------------------------------------------------- openapi ---

ESCROW_MOD_PATHS = (
    "/v1/moderation/escrow-resolutions:",
    "/v1/moderation/escrow-resolutions/{approvalId}/approve:",
    "/v1/moderation/escrow-resolutions/{approvalId}/reject:",
)


def test_openapi_documents_the_new_paths_and_the_202():
    for path in ESCROW_MOD_PATHS:
        assert f"  {path}" in OPENAPI, path
    # Both resolve entry points document the four-eyes 202.
    resolve = OPENAPI.index("/v1/moderation/escrows/{escrowId}/resolve:")
    order = OPENAPI.index("/v1/moderation/marketplace/orders/{orderId}/resolve:")
    for at in (resolve, order):
        block = OPENAPI[at:at + 2600]
        assert '"202"' in block, OPENAPI[at:at + 80]
        assert "AMD-ESC-01" in block


def test_every_batch58_openapi_post_declares_idempotency():
    start = OPENAPI.index("  /v1/moderation/escrow-resolutions:")
    section = OPENAPI[start:OPENAPI.index("components:", start)]
    posts = [m.start() for m in re.finditer(r"\n    post:", section)]
    assert len(posts) == 2  # approve + reject; the queue list is a GET
    misses = []
    for i, s in enumerate(posts):
        end = posts[i + 1] if i + 1 < len(posts) else len(section)
        if "IdempotencyKey" not in section[s:end]:
            heading = section[:s].rsplit("\n  /v1/", 1)[-1].splitlines()[0]
            misses.append(heading)
    assert misses == [], misses


# ------------------------------------------------------- rehearsal (g6) ---

def test_rehearsal_script_contract():
    # Applies every migration in lexical order.
    assert 'sorted(MIGRATION_DIR.glob("*.sql"))' in REHEARSAL
    # The stubbed extension surface is named in the header (AMD-ESC-03).
    header = REHEARSAL.split('"""')[1]
    for stub in ("h3index", "h3_cell_to_parent", "h3_get_resolution",
                 "digest", "gen_random_bytes", "ST_IsValid", "ST_NPoints",
                 "ST_Area", "ST_Segmentize", "ST_Intersection",
                 "ST_Intersects", "check_function_bodies"):
        assert stub in header, stub
    # Exercises the lifecycle: creation, release, dispute, four-eyes,
    # conservation — and the marketplace composition.
    for anchor in ("four_eyes_gate", "self_approval_refused",
                   "no_value_moved_on_gate", "second_pair_resolves",
                   "approval_matches_decision", "below_threshold_ungated",
                   "marketplace_four_eyes_passthrough",
                   "marketplace_refund_conservation",
                   "approvals_guard_blocks_delete", "global_conservation",
                   "reconciliation_keys"):
        assert anchor in REHEARSAL, anchor
    assert 'print(f"rehearse_full_chain: {len(r.passed)}/{r.total} checks PASS")' \
        in REHEARSAL


def test_chain_bugs_fixed_at_the_source():
    m3 = (ROOT / "db/migrations/0003_account_deletion.sql").read_text()
    assert "DROP FUNCTION lifecycle_tick();" in m3
    assert (m3.index("DROP FUNCTION lifecycle_tick();")
            < m3.index("CREATE OR REPLACE FUNCTION lifecycle_tick()"))
    m29 = (ROOT / "db/migrations/0029_rail_hardening.sql").read_text()
    assert "DROP FUNCTION fund_wallet(uuid, bigint, text);" in m29
    assert (m29.index("DROP FUNCTION fund_wallet")
            < m29.index("CREATE OR REPLACE FUNCTION fund_wallet("))
    m19 = (ROOT / "db/migrations/0019_reporting_compliance.sql").read_text()
    assert "DROP CONSTRAINT appeals_report_id_fkey" not in m19
    assert re.search(r"ALTER TABLE appeals\s+ADD COLUMN report_id uuid\s+"
                     r"REFERENCES reports \(report_id\) ON DELETE SET NULL",
                     m19)


# --------------------------------------------------------------- loadtest ---

def test_escrow_concurrency_scenario():
    assert "ESCROW_RACE_PAIRS = 200" in TARGETS
    assert "ESCROW_TERMINAL_CONSISTENCY = 1.0" in TARGETS
    assert "escrow_terminal_inconsistent" in RACE
    assert 'escrow_terminal_inconsistent: ["count==0"]' in RACE
    # The race must be real: both terminal outcomes required.
    assert 'escrow_terminal_completed: ["count>0"]' in RACE
    assert 'escrow_terminal_disputed: ["count>0"]' in RACE
    # Conservation asserted through the moderator reconciliation.
    assert "balanceMismatches" in RACE
    assert "/v1/moderation/wallets/reconciliation" in RACE
    # Release and dispute fire in parallel against the same escrow.
    assert "http.batch" in RACE
    assert "/milestones/1/release" in RACE and "/dispute" in RACE
    assert "escrow-concurrency.js" in LOADTEST_README


# ----------------------------------------------------------------- deploy ---

def test_mounts_cover_migration_0033():
    assert "0033_escrow_hardening.sql:/docker-entrypoint-initdb.d/35_escrow_hardening.sql:ro" \
        in COMPOSE
    assert "--from-file=35_escrow_hardening.sql=db/migrations/0033_escrow_hardening.sql" \
        in K8S_README


# ------------------------------------------------------------------ sweep ---

def test_sec17_document_vocabulary_stays_out_of_the_new_code():
    banned = re.compile(
        r"\b(passport|id_document|identity_document|document_scan|"
        r"document_image|nin|bvn|driver_licen[cs]e|national_id)\b", re.I)
    for src in (MIGRATION, EDGE_INNOVATIONS, EDGE_MARKET_ROUTES, EDGE_METRICS,
                REHEARSAL, RACE):
        assert not banned.search(src)


def test_fr17_intent_word_stays_out_of_migrations():
    assert "intent" not in MIGRATION.lower()
