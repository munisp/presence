"""Batch 60 invariants — barter swaps, trade-by-barter (SRS Addendum 001,
AMD-SWP-01..05):

  AMD-SWP-01  structured swap listing: a have category, a want set of
              one to three distinct categories, a value estimate riding the
              AMD-PAY-05 ceiling, a market, and nothing else — no
              description, no photo, no free text. Terms immutable; the
              listed|held|swapped|removed state machine is enforced by the
              database; at most twelve live swaps per owner. A swap gates
              under the existing `marketplace` vertical — the nine-row
              catalogue is unchanged.
  AMD-SWP-02  reciprocal matching: swap candidates must be symmetrically
              covered through the TR-18 taxonomy closure within the same
              market, KYC-gated, block-aware both directions, callable only
              by a caller holding a listed swap, pinned to 50 rows, with no
              owner in the projection (FR-30).
  AMD-SWP-03  bond-backed agreement: the optional cash balancer is
              reserved as a wallet hold AT PROPOSE TIME inside the
              AMD-PAY-15 settlement gate (no new value machinery);
              acceptance re-proves both sides' KYC and waits for both
              required bonds; set-once dual confirmation settles
              atomically; proposals expire at 72 h, accepted agreements
              escalate to disputed at 168 h; every transition lands in the
              append-only swap_events ledger.
  AMD-SWP-04  pinned swap bond: 100,000 minor (₦1,000), hold-backed, one
              active bond per party per agreement; a forfeited bond pays
              THE COUNTERPARTY, never the fee wallet; v1 barter carries NO
              cash fee.
  AMD-SWP-05  moderation: a moderator alone resolves from `disputed` —
              refund unwinds and relists, release settles and completes,
              an optional bond forfeits to the other party; audited; the
              dispute queue is observable through reconciliation.

The 306-requirement ledger stays untouched; amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md.
"""

from __future__ import annotations

import re

import yaml
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / "services/edge"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0035_barter_swaps.sql").read_text()
EDGE_BARTER = (EDGE / "src/barter.ts").read_text()
EDGE_ROUTES = (EDGE / "src/routes/barter.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
EDGE_VERTICALS = (EDGE / "src/verticals.ts").read_text()
CLIENT = (ROOT / "client/src/presence/swapBoard.ts").read_text()
COPY = (ROOT / "client/src/presence/copyRegistry.ts").read_text()
GO = (ROOT / "services/presence-go/verticals.go").read_text()
RUST = (ROOT / "services/match-core/src/verticals.rs").read_text()
PYREF = (ROOT / "presence/verticals.py").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
UX_DOC = (ROOT / "docs/ux/barter-swaps.md").read_text()

PUBLIC_DEFINERS = (
    "swap_category_covers", "swap_compatible", "swap_candidates",
    "create_swap_listing", "delist_swap_listing", "propose_swap",
    "stake_swap_bond", "respond_swap", "cancel_swap",
    "confirm_swap_exchange", "dispute_swap", "resolve_swap",
    "expire_stale_swaps",
)


def _fn_body(src: str, name: str) -> str:
    start = src.index(f"CREATE OR REPLACE FUNCTION {name}(")
    end = src.index("END $$;", start)
    return src[start:end]


# --------------------------------------------------------------- addendum ---

def test_addendum_carries_the_five_amendments():
    assert "## AMD-SWP — Barter swaps (trade-by-barter)" in ADDENDUM
    for amd in ("AMD-SWP-01", "AMD-SWP-02", "AMD-SWP-03", "AMD-SWP-04", "AMD-SWP-05"):
        assert f"**{amd} " in ADDENDUM, amd
    assert "AMD-SWP-01..05 added alongside batch 60" in ADDENDUM
    assert "tests/test_batch60.py` pins the barter swaps" in ADDENDUM


def test_addendum_pinned_numbers_match_the_migration():
    # 12 live listings, 5,000,000 ceiling, 72h/168h clocks, ₦1,000 bond, no fee.
    assert "12 live" in ADDENDUM
    assert "5,000,000 minor" in ADDENDUM
    assert "72 hours" in ADDENDUM and "168 hours" in ADDENDUM
    assert "100,000 minor" in ADDENDUM
    assert "NO cash fee" in ADDENDUM
    # The bond pays the counterparty, never the platform.
    assert "never the platform fee wallet" in ADDENDUM


# -------------------------------------------------------------- migration ---

def test_migration_declares_the_four_tables():
    for table in ("swap_listings", "swap_agreements", "swap_bonds", "swap_events"):
        assert f"CREATE TABLE {table}" in MIGRATION, table
        assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in MIGRATION, table


def test_swap_listing_contract():
    # State machine vocabulary and the pinned caps.
    assert "CHECK (state IN ('listed', 'held', 'swapped', 'removed'))" in MIGRATION
    assert re.search(r"CHECK \(value_estimate_minor > 0\s+"
                     r"AND value_estimate_minor <= 5000000\)", MIGRATION)
    assert re.search(r"currency\s+text NOT NULL DEFAULT 'NGN'"
                     r" CHECK \(currency = 'NGN'\)", MIGRATION)
    # Terms are immutable once created.
    guard = _fn_body(MIGRATION, "swap_listings_guard")
    assert "terms are immutable" in guard or "immutable" in guard
    # The twelve-cap lives in the create definer.
    create = _fn_body(MIGRATION, "create_swap_listing")
    assert ">= 12" in create and "too_many" in create
    # Non-sensitive category gate (TR-22) and configured market.
    assert "sensitive_category" in create and "unknown_market" in create
    # KYC gate at write.
    assert "kyc_required" in create


def test_swap_agreement_contract():
    assert re.search(r"CHECK \(state IN \('proposed', 'accepted', 'completed',\s+"
                     r"'cancelled', 'disputed'\)\)", MIGRATION)
    assert "CHECK (balance_minor >= 0 AND balance_minor <= 5000000)" in MIGRATION
    assert "CHECK (proposer <> counterparty)" in MIGRATION
    # One open agreement per listing, both listings.
    assert MIGRATION.count("WHERE state IN ('proposed', 'accepted')") >= 2
    # Confirmations are set-once.
    guard = _fn_body(MIGRATION, "swap_agreements_guard")
    assert "proposer_confirmed_at" in guard and "counterparty_confirmed_at" in guard
    assert "set-once" in guard or "once" in guard


def test_swap_bond_contract():
    # The pinned ₦1,000 bond; one active bond per party per agreement.
    assert "CHECK (amount_minor = 100000)" in MIGRATION
    assert "WHERE state = 'active'" in MIGRATION


def test_swap_events_are_append_only():
    guard = _fn_body(MIGRATION, "swap_events_guard")
    assert "RAISE EXCEPTION" in guard and "append-only" in guard
    assert ("CREATE TRIGGER swap_events_guard\n"
            "    BEFORE UPDATE OR DELETE ON swap_events" in MIGRATION)


def test_transition_tables_are_guarded():
    listing_guard = _fn_body(MIGRATION, "swap_listings_guard")
    assert "OLD.state = 'listed' AND NEW.state IN ('held', 'removed')" in listing_guard
    assert re.search(
        r"OLD\.state = 'held'\s+AND NEW\.state IN \('listed', 'swapped'\)",
        listing_guard,
    )
    agreement_guard = _fn_body(MIGRATION, "swap_agreements_guard")
    assert "OLD.state = 'proposed' AND NEW.state IN ('accepted', 'cancelled')" \
        in agreement_guard
    assert "OLD.state = 'accepted' AND NEW.state IN ('completed', 'disputed')" \
        in agreement_guard
    assert "OLD.state = 'disputed' AND NEW.state IN ('completed', 'cancelled')" \
        in agreement_guard
    bond_guard = _fn_body(MIGRATION, "swap_bonds_guard")
    assert "OLD.state = 'active' AND NEW.state IN ('released', 'forfeited')" in bond_guard


def test_reciprocal_matching_discipline():
    covers = _fn_body(MIGRATION, "swap_category_covers")
    # Coverage rides the materialized TR-18 closure, not a LIKE scan.
    assert "taxonomy_closure" in covers
    candidates = _fn_body(MIGRATION, "swap_candidates")
    assert "LIMIT 50" in candidates
    # KYC gate and the reciprocal covers: the candidate's have is
    # covered by one of the caller's wants AND vice versa.
    assert "kyc_state" in candidates
    assert candidates.count("swap_category_covers") == 2
    assert "unnest(mine.want_categories)" in candidates
    assert "unnest(c.want_categories)" in candidates
    # The caller must hold a listed swap themselves.
    assert "'listed'" in candidates
    # Blocks exclude both directions (canonical LEAST/GREATEST idiom).
    assert "LEAST(" in candidates and "GREATEST(" in candidates
    # No owner in the candidate projection (FR-30).
    returns = candidates.index("RETURNS TABLE(")
    projection = candidates[candidates.index("SELECT", returns):]
    assert "owner" not in projection.split("FROM swap_listings")[0]


def test_hold_at_propose_and_unique_violation_unwind():
    propose = _fn_body(MIGRATION, "propose_swap")
    # The balancer hold is placed BEFORE the insert; the unique-violation
    # handler voids it explicitly because the hold predates the
    # subtransaction.
    assert propose.index("place_wallet_hold") < propose.index("INSERT INTO swap_agreements")
    assert "EXCEPTION WHEN unique_violation" in propose
    handler = propose[propose.index("EXCEPTION WHEN unique_violation"):]
    assert "void_wallet_hold" in handler


def test_every_hold_touching_definer_gates_on_the_settlement_rail():
    for name in ("propose_swap", "stake_swap_bond", "respond_swap", "cancel_swap",
                 "confirm_swap_exchange", "resolve_swap"):
        body = _fn_body(MIGRATION, name)
        assert "current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'" \
            in body, name
    # The expirer refuses to run with the rail off — it touches holds.
    expire = _fn_body(MIGRATION, "expire_stale_swaps")
    assert "RAISE EXCEPTION" in expire
    assert "current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'" \
        in expire


def test_acceptance_reproves_kyc_and_waits_for_bonds():
    respond = _fn_body(MIGRATION, "respond_swap")
    assert "kyc_state" in respond
    assert "bond_required" in respond


def test_dual_confirmation_settles_atomically():
    confirm = _fn_body(MIGRATION, "confirm_swap_exchange")
    # The second confirmation posts the balancer, releases the bonds,
    # completes the agreement and moves both listings to swapped.
    assert "swap_post_hold" in confirm
    assert "'completed'" in confirm and "'swapped'" in confirm
    assert "released" in confirm


def test_expiry_clocks():
    expire = _fn_body(MIGRATION, "expire_stale_swaps")
    # Proposals unwind at 72 h; accepted agreements escalate at 168 h.
    assert "72" in expire and "168" in expire
    assert "'cancelled'" in expire and "'disputed'" in expire


def test_moderation_resolution_and_counterparty_paid_forfeit():
    resolve = _fn_body(MIGRATION, "resolve_swap")
    assert "app_moderator()" in resolve
    assert "p_decision NOT IN ('refund', 'release')" in resolve
    assert "p_decision = 'release'" in resolve
    # A forfeit pays the OTHER party — the bond's counterparty — never a
    # fee wallet; v1 barter has no fee path at all.
    assert "fee_revenue" not in resolve
    assert "fee_charge" not in resolve
    assert "swap_post_hold(v_bond.hold_id, v_bond.party, v_innocent)" in resolve
    assert "admin_audit_log" in resolve


def test_dsar_export_and_reconciliation_carry_swaps():
    dsar = _fn_body(MIGRATION, "dsar_export")
    assert "'swaps'" in dsar
    recon = _fn_body(MIGRATION, "wallet_reconciliation")
    assert "'openSwapDisputes'" in recon
    assert "'oldestSwapDisputeSeconds'" in recon
    assert "'stuckSwaps'" in recon


def test_grants_and_revokes():
    assert ("GRANT SELECT ON swap_listings, swap_agreements, swap_bonds, swap_events"
            in MIGRATION)
    for name in PUBLIC_DEFINERS:
        assert re.search(
            rf"GRANT EXECUTE ON FUNCTION {name}\([a-z, \[\]]*\) TO presence_app",
            MIGRATION,
        ), name
    # The internal definers are never callable by the app role.
    assert "REVOKE ALL ON FUNCTION swap_unwind(uuid) FROM PUBLIC" in MIGRATION
    assert "REVOKE ALL ON FUNCTION swap_post_hold(uuid, uuid, uuid) FROM PUBLIC" \
        in MIGRATION
    for internal in ("swap_unwind", "swap_post_hold"):
        assert f"GRANT EXECUTE ON FUNCTION {internal}" not in MIGRATION


def test_no_banned_vocabulary():
    # FR-17: the word "intent" never appears in SQL.
    assert "intent" not in MIGRATION.lower()
    # SEC-17: no government-identifier vocabulary in the migration.
    assert not re.search(r"passport|\bnin\b|\bbvn\b", MIGRATION.lower())


# -------------------------------------------------------------------- edge ---

def test_edge_constants_mirror_the_migration():
    assert "SWAP_BOND_AMOUNT_MINOR = 100_000" in EDGE_BARTER
    assert "SWAP_MAX_ACTIVE = 12" in EDGE_BARTER
    assert "SWAP_MAX_VALUE_MINOR = 5_000_000" in EDGE_BARTER
    assert "SWAP_MAX_BALANCE_MINOR = 5_000_000" in EDGE_BARTER
    assert "SWAP_MAX_WANTS = 3" in EDGE_BARTER
    assert "SWAP_PROPOSE_TTL_SECONDS = 259_200" in EDGE_BARTER
    assert "SWAP_ACCEPT_TTL_SECONDS = 604_800" in EDGE_BARTER
    assert "SWAP_CANDIDATE_LIMIT = 50" in EDGE_BARTER
    assert 'SWAP_CURRENCY = "NGN"' in EDGE_BARTER
    assert '["listed", "held", "swapped", "removed"]' in EDGE_BARTER
    assert '"proposed", "accepted", "completed", "cancelled", "disputed"' in EDGE_BARTER


def test_edge_routes_cover_the_surface():
    for route in (
        '"/v1/swaps/listings"',
        '"/v1/swaps/listings/mine"',
        '"/v1/swaps/candidates"',
        '"/v1/swaps/listings/:listingId/remove"',
        '"/v1/swaps/proposals"',
        '"/v1/swaps/:agreementId/respond"',
        '"/v1/swaps/:agreementId/cancel"',
        '"/v1/swaps/:agreementId/stake-bond"',
        '"/v1/swaps/:agreementId/confirm"',
        '"/v1/swaps/:agreementId/dispute"',
        '"/v1/swaps/agreements"',
        '"/v1/swaps/agreements/:agreementId"',
        '"/v1/moderation/swaps/disputed"',
        '"/v1/moderation/swaps/:agreementId/resolve"',
    ):
        assert route in EDGE_ROUTES, route
    # Value moves only inside withSettlement — the six hold-touching
    # routes (propose, respond, cancel, stake-bond, confirm, resolve);
    # reads ride withRls.
    assert EDGE_ROUTES.count("withSettlement(") == 6
    # The rail kill switch answers 503 on every settlement path.
    assert "WalletRailUnavailable" in EDGE_ROUTES
    # The moderation resolve requires the moderator role AND the rail.
    resolve = EDGE_ROUTES[EDGE_ROUTES.index("/v1/moderation/swaps/:agreementId/resolve"):]
    assert "requireModerator" in resolve
    # Registered in the app and gated under the marketplace vertical.
    assert 'import { registerBarterRoutes } from "./routes/barter.js"' in EDGE_APP
    assert "registerBarterRoutes(authed, ctx)" in EDGE_APP
    assert '[/^\\/v1\\/swaps(\\/|$)/, "marketplace"]' in EDGE_VERTICALS


def test_edge_parsers_are_strict():
    # Exact key counts — a smuggled field refuses the body (FR-96/SEC-37).
    assert "keys.length !== 4" in EDGE_BARTER
    assert "keys.length !== 1" in EDGE_BARTER
    # SEC-17: no government-identifier vocabulary in the edge module.
    assert not re.search(r"passport|\bnin\b|\bbvn\b", EDGE_BARTER.lower())
    assert not re.search(r"passport|\bnin\b|\bbvn\b", EDGE_ROUTES.lower())


# ------------------------------------------------------------------ parity ---

def test_parity_mirrors_carry_the_swaps_mapping():
    assert '{"/v1/swaps", VerticalMarketplace}' in GO
    assert '("/v1/swaps", Vertical::Marketplace)' in RUST
    assert '("/v1/swaps", "marketplace")' in PYREF


# ------------------------------------------------------------------ client ---

def test_client_mirrors_and_copy():
    assert "SWAP_BOND_AMOUNT_MINOR = 100_000" in CLIENT
    assert "SWAP_MAX_ACTIVE = 12" in CLIENT
    assert "SWAP_MAX_WANTS = 3" in CLIENT
    assert 'SWAP_CURRENCY = "NGN"' in CLIENT
    # The candidate parser refuses a row that leaks an owner (FR-30).
    assert "parseSwapCandidateWire" in CLIENT
    # The wire parsers refuse any smuggled field — exact key counts.
    assert "keys.length !== 9" in CLIENT
    assert "keys.length !== 6" in CLIENT
    assert "keys.length !== 14" in CLIENT
    for key in ("ui.swaps.title", "ui.swaps.propose", "ui.swaps.confirm",
                "ui.swaps.stake-bond", "ui.swaps.bond-required",
                "ui.swaps.agreement.state.disputed"):
        assert f'"{key}"' in COPY, key


# ----------------------------------------------------------------- openapi ---

def test_openapi_documents_the_surface():
    doc = yaml.safe_load(OPENAPI)
    paths = doc["paths"]
    for path in (
        "/v1/swaps/listings",
        "/v1/swaps/listings/mine",
        "/v1/swaps/candidates",
        "/v1/swaps/listings/{listingId}/remove",
        "/v1/swaps/proposals",
        "/v1/swaps/{agreementId}/respond",
        "/v1/swaps/{agreementId}/cancel",
        "/v1/swaps/{agreementId}/stake-bond",
        "/v1/swaps/{agreementId}/confirm",
        "/v1/swaps/{agreementId}/dispute",
        "/v1/swaps/agreements",
        "/v1/swaps/agreements/{agreementId}",
        "/v1/moderation/swaps/disputed",
        "/v1/moderation/swaps/{agreementId}/resolve",
    ):
        assert path in paths, path
    # Nine POSTs: create, remove, propose, respond, cancel, stake, confirm,
    # dispute, resolve.
    post_paths = [p for p in paths if p.startswith("/v1/swaps")
                  or p.startswith("/v1/moderation/swaps")]
    posts = sum(1 for p in post_paths if "post" in paths[p])
    assert posts == 9
    gets = sum(1 for p in post_paths if "get" in paths[p])
    assert gets == 5
    # The proposal schema is closed.
    schema = paths["/v1/swaps/proposals"]["post"]["requestBody"]["content"][
        "application/json"]["schema"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {
        "myListingId", "theirListingId", "balanceMinor", "requiresBond",
    }
    assert schema["properties"]["balanceMinor"]["maximum"] == 5000000


def test_openapi_post_windows():
    # The b59 windows keep their counts; the escrow→components window grew
    # by the nine swap POSTs (2 → 11), then by batch 61's five service POSTs
    # (11 → 16), then by batch 62's six onboarding POSTs — apply, withdraw,
    # approve, reject, KYC request, venue activate (16 → 22), batch-63
    # KYC session + verdict webhook (→ 24), batch-69 WhatsApp webhook
    # intake + link + verify (→ 27), batch-70 tile-bundle register +
    # publish (→ 29).
    bond = OPENAPI.index("/v1/presence/bond:")
    dating = OPENAPI.index("/v1/dating/preferences:")
    esc = OPENAPI.index("/v1/moderation/escrow-resolutions:")
    comps = OPENAPI.index("components:")
    assert len(re.findall(r"\n    post:", OPENAPI[bond:dating])) == 18
    assert len(re.findall(r"\n    post:", OPENAPI[dating:esc])) == 10
    assert len(re.findall(r"\n    post:", OPENAPI[esc:comps])) == 29


def test_every_swap_openapi_post_declares_idempotency():
    start = OPENAPI.index("  /v1/swaps/listings:")
    # The swap block ends where the batch-61 services block begins.
    section = OPENAPI[start:OPENAPI.index("  /v1/services/bookings:", start)]
    posts = [m.start() for m in re.finditer(r"\n    post:", section)]
    assert len(posts) == 9  # create, remove, propose, respond, cancel,
    # stake-bond, confirm, dispute, moderation resolve
    misses = []
    for i, s in enumerate(posts):
        end = posts[i + 1] if i + 1 < len(posts) else len(section)
        if "IdempotencyKey" not in section[s:end]:
            heading = section[:s].rsplit("\n  /v1/", 1)[-1].splitlines()[0]
            misses.append(heading)
    assert misses == [], misses


# ------------------------------------------------------------------ deploy ---

def test_migration_rides_both_initdb_mounts():
    assert "/docker-entrypoint-initdb.d/37_barter_swaps.sql:ro" in COMPOSE
    assert "../db/migrations/0035_barter_swaps.sql" in COMPOSE
    assert "--from-file=37_barter_swaps.sql=db/migrations/0035_barter_swaps.sql" \
        in K8S_README


def test_ux_doc_exists_and_carries_the_amendment():
    assert "AMD-SWP-01..05" in UX_DOC
    assert "trade-by-barter" in UX_DOC.lower() or "barter" in UX_DOC.lower()
