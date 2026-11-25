"""Batch 56 invariants — ten core-platform innovations (SRS Addendum 001,
AMD-INN-01..10):

  AMD-INN-01  presence bonds: one pinned bond per user, hold-backed,
              released by the owner, forfeited by a moderator on a report.
  AMD-INN-02  verified-met receipts: reciprocal co-attestation inside a
              pinned 900 s window; pair + two timestamps, nothing else.
  AMD-INN-03  trust escrow: milestones, up-front hold, payer-only release,
              moderator-resolved disputes.
  AMD-INN-04  group stakes: pinned seat stake, refund only after FR-100
              check-in verification, 24 h forfeiture sweep.
  AMD-INN-05  duress mode: client-only, pinned pipeline, imports only the
              TR-30 wipe.
  AMD-INN-06  selective disclosure: single-use 900 s claims; the verifier
              learns the claim and nothing else.
  AMD-INN-07  on-device match preview: client-only estimate, cross-pinned
              to the TR-04/FR-21 engine constants; no edge route exists.
  AMD-INN-08  serendipity windows: max four active, pause/resume only,
              overlap answers a boolean.
  AMD-INN-09  verification passport: HMAC-signed pseudonymous claims;
              verification is an unauthenticated oracle outside the authed
              scope, every verdict counted.
  AMD-INN-10  host-mediated introductions: blocks refuse absolutely; the
              second accept walks the pair to MUTUAL through the FR-29
              consent ledger — never a direct UPDATE.

The 306-requirement ledger stays untouched; amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / "services/edge"
CLIENT = ROOT / "client"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0030_innovations.sql").read_text()
EDGE_MODULE = (EDGE / "src/innovations.ts").read_text()
EDGE_ROUTES = (EDGE / "src/routes/innovations.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
EDGE_METRICS = (EDGE / "src/metrics.ts").read_text()
EDGE_TEST = (EDGE / "test/innovations.test.ts").read_text()
CLIENT_DURESS = (CLIENT / "src/presence/duressMode.ts").read_text()
CLIENT_PREVIEW = (CLIENT / "src/presence/matchPreview.ts").read_text()
CLIENT_DURESS_TEST = (CLIENT / "test/duressMode.test.ts").read_text()
CLIENT_PREVIEW_TEST = (CLIENT / "test/matchPreview.test.ts").read_text()
UX_DOC = (ROOT / "docs/ux/innovations.md").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()


# ----------------------------------------------------------- migration ---

def test_addendum_documents_all_ten_innovations():
    for n in range(1, 11):
        assert f"AMD-INN-{n:02d}" in ADDENDUM, n


def test_presence_bonds_table_and_guards():
    assert "CREATE TABLE presence_bonds" in MIGRATION
    assert "REFERENCES wallet_holds (hold_id)" in MIGRATION
    assert "CHECK (amount_minor = 100000)" in MIGRATION
    assert "presence_bonds_one_active" in MIGRATION
    for msg in ("presence_bonds is append-only (AMD-INN-01)",
                "bond terms are immutable (AMD-INN-01)",
                "illegal bond transition % -> % (AMD-INN-01)",
                "forfeiture requires a report (AMD-INN-01)"):
        assert msg in MIGRATION, msg


def test_bond_definers_hold_the_discipline():
    for fn in ("place_presence_bond()", "release_presence_bond(p_bond uuid)",
               "forfeit_presence_bond(p_bond uuid, p_report uuid)"):
        assert f"FUNCTION {fn}" in MIGRATION, fn
    # Value moves only inside the settlement gate.
    assert MIGRATION.count("app.transfer_settlement") >= 8
    # Forfeiture names a report against the owner and moves value as fees.
    assert "r.reported = v_bond.owner" in MIGRATION
    assert "'fee_charge'" in MIGRATION and "'fee_revenue'" in MIGRATION
    assert "admin_audit_log(" in MIGRATION


def test_met_receipts_are_pair_and_timestamps_only():
    assert "CREATE TABLE met_receipts" in MIGRATION
    assert "CHECK (user_lo < user_hi)" in MIGRATION
    assert "met_receipts_one_pending" in MIGRATION
    assert "interval '900 seconds'" in MIGRATION
    # No location, no device, no free text columns.
    cols = re.search(r"CREATE TABLE met_receipts \((.*?)\);", MIGRATION, re.S).group(1)
    for banned in ("location", "geo", "device", "details", "notes",
                   "message", "bytea", "accuracy"):
        assert banned not in cols, banned
    assert "receipt timestamps are set-once (AMD-INN-02)" in MIGRATION


def test_escrow_contract():
    assert "CREATE TABLE escrow_agreements" in MIGRATION
    assert "CREATE TABLE escrow_milestones" in MIGRATION
    assert "total_minor > 0 AND total_minor <= 5000000" in MIGRATION
    assert "CHECK (seq >= 1 AND seq <= 12)" in MIGRATION
    assert "'active', 'completed', 'refunded', 'disputed'" in MIGRATION
    for msg in ("escrow terms are immutable (AMD-INN-03)",
                "illegal escrow transition % -> % (AMD-INN-03)",
                "milestone terms are immutable (AMD-INN-03)",
                "illegal milestone transition % -> % (AMD-INN-03)"):
        assert msg in MIGRATION, msg
    # Payer-only release; moderator-only resolve.
    assert "v_escrow.payer <> v_user" in MIGRATION
    assert "p_decision NOT IN ('refund', 'release')" in MIGRATION


def test_group_stakes_contract():
    assert "CREATE TABLE group_stakes" in MIGRATION
    assert "CHECK (amount_minor = 50000)" in MIGRATION
    assert "group_stakes_one_active" in MIGRATION
    assert ">= 6" in MIGRATION  # the SEC-33 seat cap
    assert "interval '24 hours'" in MIGRATION
    for msg in ("group_stakes is append-only (AMD-INN-04)",
                "stake terms are immutable (AMD-INN-04)",
                "illegal stake transition % -> % (AMD-INN-04)"):
        assert msg in MIGRATION, msg
    assert "forfeit_group_stakes()" in MIGRATION


def test_disclosure_grants_contract():
    assert "CREATE TABLE disclosure_grants" in MIGRATION
    assert "claim IN ('over_18', 'kyc_verified')" in MIGRATION
    assert "interval '900 seconds'" in MIGRATION
    # The secret is stored as a digest; redemption is single-use and
    # venue-ops gated.
    assert "digest(v_secret, 'sha256')" in MIGRATION
    assert "grant use is single and terminal (AMD-INN-06)" in MIGRATION
    assert "app_venue_ops()" in MIGRATION
    # over_18 is proven from the declared birth year.
    assert "birth_year <= extract(year FROM now())::int - 18" in MIGRATION


def test_serendipity_windows_contract():
    assert "CREATE TABLE serendipity_windows" in MIGRATION
    assert "weekday BETWEEN 0 AND 6" in MIGRATION
    assert "hour_end > hour_start" in MIGRATION
    assert "window terms are immutable (AMD-INN-08)" in MIGRATION
    assert "serendipity_windows is append-only (AMD-INN-08)" in MIGRATION
    # The four-active cap is enforced at add AND at resume.
    assert MIGRATION.count(">= 4") >= 2
    # Overlap is a boolean over canonical fields; it reveals no schedule.
    assert "FUNCTION serendipity_overlap(p_peer uuid)" in MIGRATION
    assert "b.hour_start < a.hour_end AND a.hour_start < b.hour_end" in MIGRATION


def test_introductions_contract():
    assert "CREATE TABLE introductions" in MIGRATION
    assert "CHECK (party_lo < party_hi)" in MIGRATION
    assert "host <> party_lo AND host <> party_hi" in MIGRATION
    assert "introductions_one_open" in MIGRATION
    # Blocks refuse absolutely, in both directions.
    assert "FROM blocks b" in MIGRATION
    assert "b.blocker = v_lo AND b.blocked = v_hi" in MIGRATION
    assert "b.blocker = v_hi AND b.blocked = v_lo" in MIGRATION
    # The consent machine is driven through the ledger, never by UPDATE of
    # matches.state.
    assert "INSERT INTO consent_ledger" in MIGRATION
    assert "'EXPRESSED', 'MUTUAL'" in MIGRATION
    assert "ON CONFLICT (user_lo, user_hi) DO NOTHING" in MIGRATION
    assert not re.search(r"UPDATE\s+matches\b", MIGRATION)
    assert "interval '72 hours'" in MIGRATION
    for msg in ("introduction terms are immutable (AMD-INN-10)",
                "illegal introduction transition % -> % (AMD-INN-10)",
                "introduction answers are set-once (AMD-INN-10)"):
        assert msg in MIGRATION, msg


def test_attestation_claims_definer():
    assert "FUNCTION attestation_claims()" in MIGRATION
    assert "jsonb_build_object('claims', v_claims)" in MIGRATION


def test_all_new_tables_are_rls_governed_and_definer_written():
    for table in ("presence_bonds", "met_receipts", "escrow_agreements",
                  "escrow_milestones", "group_stakes", "disclosure_grants",
                  "serendipity_windows", "introductions"):
        assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;" in MIGRATION, table
    # Reads only: no INSERT/UPDATE/DELETE grant on any innovation table.
    assert not re.search(
        r"GRANT (INSERT|UPDATE|DELETE)[^\n]*ON (presence_bonds|met_receipts|"
        r"escrow_agreements|escrow_milestones|group_stakes|disclosure_grants|"
        r"serendipity_windows|introductions)",
        MIGRATION,
    )
    for fn in ("place_presence_bond()", "release_presence_bond(uuid)",
               "forfeit_presence_bond(uuid, uuid)", "submit_met_receipt(uuid)",
               "expire_met_receipts()", "create_escrow(uuid, bigint[])",
               "release_escrow_milestone(uuid, smallint)", "dispute_escrow(uuid)",
               "resolve_escrow(uuid, text)", "place_group_stake(uuid)",
               "refund_group_stake(uuid)", "forfeit_group_stakes()",
               "issue_disclosure_grant(text)", "redeem_disclosure_grant(uuid, text)",
               "add_serendipity_window(smallint, smallint, smallint, text)",
               "set_serendipity_window_state(uuid, text)",
               "serendipity_overlap(uuid)", "propose_introduction(uuid, uuid)",
               "answer_introduction(uuid, text)", "expire_introductions()",
               "attestation_claims()"):
        assert f"GRANT EXECUTE ON FUNCTION {fn} TO presence_app;" in MIGRATION, fn


# ------------------------------------------------------------ edge module ---

def test_edge_constants_cross_pin_the_migration():
    for const in ("BOND_AMOUNT_MINOR = 100_000", "MET_WINDOW_S = 900",
                  "ESCROW_MAX_TOTAL_MINOR = 5_000_000",
                  "ESCROW_MAX_MILESTONES = 12", "STAKE_AMOUNT_MINOR = 50_000",
                  "STAKE_TTL_H = 24", "DISCLOSURE_TTL_S = 900",
                  'DISCLOSURE_CLAIMS = ["over_18", "kyc_verified"]',
                  "SERENDIPITY_MAX_ACTIVE = 4", "INTRO_TTL_H = 72",
                  "ATTESTATION_TTL_S = 3600"):
        assert const in EDGE_MODULE, const


def test_edge_parsers_are_strict():
    for parser in ("parseMetReceiptBody", "parseEscrowBody",
                   "parseEscrowResolution", "parseBondForfeitBody",
                   "parseStakeRefundBody", "parseDisclosureIssueBody",
                   "parseDisclosureVerifyBody", "parseSerendipityWindowBody",
                   "parseSerendipityStateBody", "parseIntroductionBody",
                   "parseIntroductionAnswerBody", "parseAttestationVerifyBody"):
        assert f"export function {parser}(" in EDGE_MODULE, parser
    assert 'keys.length !== 1' in EDGE_MODULE  # no extra keys, anywhere


def test_attestation_token_contract():
    assert 'ATTESTATION_VERSION = "pa1"' in EDGE_MODULE
    assert 'presence-attestation:${userId}' in EDGE_MODULE
    assert "timingSafeEqual" in EDGE_MODULE
    assert '"expired"' in EDGE_MODULE
    assert "/^[0-9a-f]{64}$/" in EDGE_MODULE  # pseudonymous subject shape


# ------------------------------------------------------------ edge routes ---

def test_innovation_routes_exist():
    for path in ('"/v1/presence/bond"', '"/v1/presence/bond/release"',
                 '"/v1/moderation/bonds/:bondId/forfeit"',
                 '"/v1/met-receipts"', '"/v1/escrows"',
                 '"/v1/escrows/:escrowId/milestones/:seq/release"',
                 '"/v1/escrows/:escrowId/dispute"',
                 '"/v1/moderation/escrows/:escrowId/resolve"',
                 '"/v1/groups/:tableId/stake"',
                 '"/v1/groups/:tableId/stake/refund"',
                 '"/v1/moderation/sweeps"',
                 '"/v1/disclosure-grants"',
                 '"/v1/venues/disclosure-verify"',
                 '"/v1/serendipity/windows"',
                 '"/v1/serendipity/windows/:windowId/state"',
                 '"/v1/serendipity/overlap"',
                 '/v1/attestation"',
                 '/v1/attestation/verify"',
                 '"/v1/introductions"',
                 '"/v1/introductions/:introId/answer"'):
        assert path in EDGE_ROUTES, path


def test_value_moves_only_inside_settlement():
    # The value-moving definers are reached through withSettlement only.
    for call in ("place_presence_bond", "release_presence_bond",
                 "forfeit_presence_bond", "create_escrow",
                 "release_escrow_milestone", "resolve_escrow",
                 "place_group_stake", "refund_group_stake",
                 "forfeit_group_stakes"):
        assert call in EDGE_ROUTES, call
    assert EDGE_ROUTES.count("withSettlement(") >= 8
    assert "WalletRailUnavailable" in EDGE_ROUTES
    assert '"app.moderator"' in EDGE_ROUTES
    # The stake refund verifies the FR-100 check-in token BEFORE the refund.
    refund = EDGE_ROUTES.index("stake/refund")
    verify = EDGE_ROUTES.index("verifyCheckinToken(", refund)
    refund_call = EDGE_ROUTES.index("refund_group_stake($1)", refund)
    assert verify < refund_call


def test_moderation_routes_are_gated():
    # Every /v1/moderation POST in this file carries requireModerator.
    blocks = re.split(r"app\.post\(", EDGE_ROUTES)
    for block in blocks[1:]:
        if '"/v1/moderation/' in block.split(",", 1)[0]:
            assert "requireModerator" in block[:600], block[:120]
    # The venue verifier route is venue-ops gated.
    assert "requireVenueOps" in EDGE_ROUTES
    assert "withVenueOps(" in EDGE_ROUTES


def test_every_post_declares_a_rate_limit():
    # AMD-OPS-03 extended: every POST in the innovation routes declares a
    # per-route rate limit.
    posts = [m.start() for m in re.finditer(r"app\.post\(", EDGE_ROUTES)]
    assert len(posts) >= 15
    for start in posts:
        window = EDGE_ROUTES[start:start + 900]
        assert "rateLimit" in window, EDGE_ROUTES[start:start + 80]


def test_attestation_verify_is_outside_the_authed_scope():
    # Two registration functions; the verify oracle registers OUTSIDE.
    assert "registerInnovationRoutes" in EDGE_ROUTES
    assert "registerAttestationVerifyRoute" in EDGE_ROUTES
    app_verify = EDGE_APP.index("registerAttestationVerifyRoute(app, ctx);")
    app_authed = EDGE_APP.index("await app.register(async (authed)")
    app_innov = EDGE_APP.index("registerInnovationRoutes(authed, ctx);")
    assert app_verify < app_authed < app_innov
    # And after the wallet governance routes, keeping the b54/b55 order.
    assert EDGE_APP.index("registerWalletGovernanceRoutes(authed, ctx);") < app_innov


def test_attestation_verdicts_are_counted():
    assert "presence_attestation_verify_results_total" in EDGE_METRICS
    for result in ('{ result: "unconfigured" }', '{ result: "invalid" }',
                   '{ result: "expired" }', '{ result: "valid" }'):
        assert f"attestationVerifyResults().inc({result})" in EDGE_ROUTES, result


# ----------------------------------------------------------------- client ---

def test_duress_mode_is_client_only_and_fail_safe():
    assert "DURESS_PIPELINE" in CLIENT_DURESS
    for step in ('"withdraw-presence"', '"wipe-local-state"', '"neutral-screen"'):
        assert step in CLIENT_DURESS, step
    # The wipe delegates to the TR-30 allowlist wipe — the only import.
    imports = re.findall(r'^import .* from "(\..*)";$', CLIENT_DURESS, re.M)
    assert imports == ["./localState.js"], imports
    assert "clearLocalState" in CLIENT_DURESS
    # No server route answers a duress signal.
    assert "duress" not in EDGE_ROUTES.lower()
    assert "DURESS_PIPELINE.length, 3" in CLIENT_DURESS_TEST


def test_match_preview_is_client_only_and_cross_pinned():
    assert "PREVIEW_SHARED_BONUS = 0.05" in CLIENT_PREVIEW
    assert "PREVIEW_POSSIBLE_MIN = 0.12" in CLIENT_PREVIEW
    assert "PREVIEW_STRONG_MIN = 0.36" in CLIENT_PREVIEW
    assert "PREVIEW_SCORE_CAP = 1.0" in CLIENT_PREVIEW
    # The client test cross-pins the engine constants and asserts no edge
    # route serves a preview.
    assert "EXACT_OVERLAP_BONUS = 0\\.05" in CLIENT_PREVIEW_TEST
    assert "SUGGEST_THRESHOLD = 0\\.12" in CLIENT_PREVIEW_TEST
    assert "match-preview" in CLIENT_PREVIEW_TEST


# ------------------------------------------------------------------- docs ---

def test_ux_doc_covers_all_ten():
    for n in range(1, 11):
        assert f"AMD-INN-{n:02d}" in UX_DOC, n


def test_openapi_documents_the_innovation_paths():
    for path in ("/v1/presence/bond:", "/v1/presence/bond/release:",
                 "/v1/moderation/bonds/{bondId}/forfeit:",
                 "/v1/met-receipts:", "/v1/escrows:",
                 "/v1/escrows/{escrowId}/milestones/{seq}/release:",
                 "/v1/escrows/{escrowId}/dispute:",
                 "/v1/moderation/escrows/{escrowId}/resolve:",
                 "/v1/groups/{tableId}/stake:",
                 "/v1/groups/{tableId}/stake/refund:",
                 "/v1/moderation/sweeps:", "/v1/disclosure-grants:",
                 "/v1/venues/disclosure-verify:", "/v1/serendipity/windows:",
                 "/v1/serendipity/windows/{windowId}/state:",
                 "/v1/serendipity/overlap:", "/v1/attestation:",
                 "/v1/attestation/verify:", "/v1/introductions:",
                 "/v1/introductions/{introId}/answer:"):
        assert f"  {path}" in OPENAPI, path
    # Passport verify is documented as unauthenticated.
    verify_section = OPENAPI.split("  /v1/attestation/verify:", 1)[1].split("\n  /", 1)[0]
    assert "UNAUTHENTICATED" in verify_section


def test_every_new_openapi_post_declares_idempotency():
    # Every POST section under the innovation paths references the shared
    # IdempotencyKey parameter — including the unauthenticated verify
    # oracle, matching the webhook precedent. (The section ends at the
    # batch-57 dating/marketplace block, which pins its own POSTs in
    # tests/test_batch57.py.)
    start = OPENAPI.index("  /v1/presence/bond:")
    end = OPENAPI.index("  /v1/dating/preferences:", start)
    section = OPENAPI[start:end]
    posts = [m.start() for m in re.finditer(r"\n    post:", section)]
    assert len(posts) == 18
    misses = []
    for i, s in enumerate(posts):
        end = posts[i + 1] if i + 1 < len(posts) else len(section)
        chunk = section[s:end]
        if "IdempotencyKey" not in chunk:
            heading = section[:s].rsplit("\n  /v1/", 1)[-1].splitlines()[0]
            misses.append(heading)
    assert misses == [], misses


def test_mounts_cover_migration_0030():
    assert "0030_innovations.sql:/docker-entrypoint-initdb.d/32_innovations.sql:ro" in COMPOSE
    assert "--from-file=32_innovations.sql=db/migrations/0030_innovations.sql" in K8S_README


def test_edge_tests_cover_the_module():
    for anchor in ("pinned constants match the migration contract",
                   "attestation round-trips; the subject is a pseudonym",
                   "strict shape, no extra keys"):
        assert anchor in EDGE_TEST, anchor
