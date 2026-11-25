"""Batch 57 invariants — dating mode + marketplace listing primitive
(SRS Addendum 001, AMD-DATE-01..05, AMD-MKT-01..05):

  AMD-DATE-01  opt-in dating mode: a structured, enumerated attribute set
               (gender, seeking 1-3, goal, age range 18-99) — no photo
               (FR-87 unchanged), no free text (FR-96/SEC-37 unchanged);
               KYC-verified + adult proved at write.
  AMD-DATE-02  governed vocabularies: database-seeded, app-read-only.
  AMD-DATE-03  preference-intersection discovery filter: the scan pipeline
               intersects candidates with mutual compatibility before any
               pair surfaces; inert without an active profile; narrows,
               never widens.
  AMD-DATE-04  counterpart reveal: compatible AND NUDGED or later; ranges,
               never birth years; the FR-29 consent machine unchanged.
  AMD-DATE-05  pause/resume; resume re-proves both gates; the application
               role can never delete a profile row.
  AMD-MKT-01   structured listing: kind, category, price, currency,
               market — no description, no photo; terms immutable; guarded
               state machine draft -> listed -> held -> sold.
  AMD-MKT-02   marketplace_events append-only for every path.
  AMD-MKT-03   purchase composes the b56 escrow (single milestone = price)
               inside the AMD-PAY-15 settlement gate; confirm releases,
               dispute holds, moderation resolves; refund relists.
  AMD-MKT-04   KYC both parties; non-sensitive taxonomy category (TR-22);
               configured market; price <= 5,000,000 (AMD-PAY-05 ceiling);
               at most 12 live listings per seller; NGN only.
  AMD-MKT-05   moderated takedown with governed reason code, audited; a
               held listing is never removed out from under an escrow.

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
DATING_MIGRATION = (ROOT / "db/migrations/0031_dating.sql").read_text()
MARKET_MIGRATION = (ROOT / "db/migrations/0032_marketplace.sql").read_text()
EDGE_DATING = (EDGE / "src/dating.ts").read_text()
EDGE_MARKET = (EDGE / "src/marketplace.ts").read_text()
EDGE_DATING_ROUTES = (EDGE / "src/routes/dating.ts").read_text()
EDGE_MARKET_ROUTES = (EDGE / "src/routes/marketplace.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
EDGE_SCAN = (EDGE / "src/routes/scan.ts").read_text()
EDGE_DATING_TEST = (EDGE / "test/dating.test.ts").read_text()
EDGE_MARKET_TEST = (EDGE / "test/marketplace.test.ts").read_text()
CLIENT_DATING = (CLIENT / "src/presence/datingPreferences.ts").read_text()
CLIENT_LISTING = (CLIENT / "src/presence/listingCard.ts").read_text()
CLIENT_DATING_TEST = (CLIENT / "test/datingPreferences.test.ts").read_text()
CLIENT_LISTING_TEST = (CLIENT / "test/listingCard.test.ts").read_text()
UX_DOC = (ROOT / "docs/ux/dating-and-marketplace.md").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()

DATING_PATHS = (
    "/v1/dating/preferences:", "/v1/dating/profile:", "/v1/dating/state:",
    "/v1/dating/compatibility:", "/v1/dating/counterpart:",
)
MARKET_PATHS = (
    "/v1/marketplace/listings:", "/v1/marketplace/listings/mine:",
    "/v1/marketplace/listings/{listingId}/list:",
    "/v1/marketplace/listings/{listingId}/remove:",
    "/v1/marketplace/listings/{listingId}/purchase:",
    "/v1/marketplace/orders:", "/v1/marketplace/orders/{orderId}/confirm:",
    "/v1/marketplace/orders/{orderId}/dispute:",
    "/v1/moderation/marketplace/listings/{listingId}/remove:",
    "/v1/moderation/marketplace/orders/{orderId}/resolve:",
)


# ----------------------------------------------------------- migration ---

def test_addendum_documents_both_amendments():
    for n in range(1, 6):
        assert f"AMD-DATE-{n:02d}" in ADDENDUM, n
        assert f"AMD-MKT-{n:02d}" in ADDENDUM, n
    # The reaffirmed invariants are explicit.
    assert "FR-87" in ADDENDUM and "FR-96/SEC-37" in ADDENDUM


def test_dating_vocabularies_are_governed_and_seeded():
    assert "CREATE TABLE dating_genders" in DATING_MIGRATION
    assert "CREATE TABLE dating_goals" in DATING_MIGRATION
    assert "VALUES ('female'), ('male'), ('nonbinary')" in DATING_MIGRATION
    assert ("VALUES ('long_term'), ('short_term'), ('friendship'), ('exploring')"
            in DATING_MIGRATION)
    # The application role reads but never writes the vocabularies.
    assert "GRANT SELECT ON dating_genders, dating_goals, dating_profiles" in DATING_MIGRATION
    assert not re.search(r"GRANT (INSERT|UPDATE|DELETE).*dating_(genders|intents)",
                         DATING_MIGRATION)


def test_dating_profile_has_no_photo_and_no_free_text():
    cols = re.search(r"CREATE TABLE dating_profiles \((.*?)\);",
                     DATING_MIGRATION, re.S).group(1).lower()
    for banned in ("photo", "bio", "description", "freetext", "free_text",
                   "note", "message", "birth_year", "birthdate", "location"):
        assert banned not in cols, banned
    assert "age_min BETWEEN 18 AND 99" in DATING_MIGRATION
    assert "cardinality(seeking) BETWEEN 1 AND 3" in DATING_MIGRATION
    assert "CHECK (age_max >= age_min)" in DATING_MIGRATION


def test_dating_guards_and_definer_gates():
    for msg in ("dating_profiles is append-only for the application role (AMD-DATE-05)",
                "dating profile identity is immutable (AMD-DATE-01)",
                "seeking must stay inside the governed vocabulary (AMD-DATE-02)"):
        assert msg in DATING_MIGRATION, msg
    # KYC + adult gates proved at write and re-proved at resume.
    assert DATING_MIGRATION.count("kyc_state = 'verified'") >= 5
    assert DATING_MIGRATION.count("birth_year <= extract(year FROM now())::int - 18") >= 3
    for outcome in ("'kyc_required'", "'underage'", "'invalid_preferences'"):
        assert outcome in DATING_MIGRATION, outcome
    # Owner-read RLS; no browse policy.
    assert "dating_profiles_owner_read" in DATING_MIGRATION


def test_dating_filter_and_reveal_discipline():
    # Compatibility: mutual seeking, mutual age range, same goal, blocks
    # refuse in both directions.
    for anchor in ("v_me.gender = ANY(v_peer.seeking)",
                   "v_peer.gender = ANY(v_me.seeking)",
                   "v_me.goal = v_peer.goal",
                   "v_my_age BETWEEN v_peer.age_min AND v_peer.age_max",
                   "v_peer_age BETWEEN v_me.age_min AND v_me.age_max",
                   "(b.blocker = v_user AND b.blocked = p_peer)",
                   "(b.blocker = p_peer AND b.blocked = v_user)"):
        assert anchor in DATING_MIGRATION, anchor
    # The reveal requires NUDGED or later (the pair_avatar discipline).
    assert "m.state IN ('NUDGED', 'EXPRESSED', 'MUTUAL', 'OPEN')" in DATING_MIGRATION
    # The scan filter is inert without an active profile.
    assert "RETURN QUERY SELECT unnest(p_peers);" in DATING_MIGRATION
    # The FR-29 consent machine is untouched: no matches/consent writes here.
    assert "INSERT INTO matches" not in DATING_MIGRATION
    assert "consent_ledger" not in DATING_MIGRATION


def test_marketplace_tables_and_guards():
    assert "CREATE TABLE marketplace_listings" in MARKET_MIGRATION
    assert "CREATE TABLE marketplace_orders" in MARKET_MIGRATION
    assert "CREATE TABLE marketplace_events" in MARKET_MIGRATION
    for msg in ("marketplace_listings is append-only (AMD-MKT-01)",
                "listing terms are immutable (AMD-MKT-01)",
                "illegal listing transition % -> % (AMD-MKT-01)",
                "marketplace_orders is append-only (AMD-MKT-03)",
                "order terms are immutable (AMD-MKT-03)",
                "illegal order transition % -> % (AMD-MKT-03)",
                "marketplace_events is append-only (AMD-MKT-02)"):
        assert msg in MARKET_MIGRATION, msg


def test_marketplace_listing_is_structured_only():
    cols = re.search(r"CREATE TABLE marketplace_listings \((.*?)\);",
                     MARKET_MIGRATION, re.S).group(1).lower()
    for banned in ("description", "photo", "image", "title", "note",
                   "message", "freetext"):
        assert banned not in cols, banned
    assert "kind IN ('item', 'service')" in MARKET_MIGRATION
    assert "REFERENCES taxonomy_nodes (node_id)" in MARKET_MIGRATION
    assert "REFERENCES market_config (market_id)" in MARKET_MIGRATION
    assert "currency = 'NGN'" in MARKET_MIGRATION
    assert "price_minor > 0 AND price_minor <= 5000000" in MARKET_MIGRATION


def test_marketplace_state_machines():
    # Listings: draft -> listed | removed; listed -> held | removed;
    # held -> sold | listed. Terminal: sold, removed.
    assert ("OLD.state = 'draft'  AND NEW.state IN ('listed', 'removed')"
            in MARKET_MIGRATION)
    assert ("OLD.state = 'listed' AND NEW.state IN ('held', 'removed')"
            in MARKET_MIGRATION)
    assert ("OLD.state = 'held'   AND NEW.state IN ('sold', 'listed')"
            in MARKET_MIGRATION)
    # Orders mirror the escrow: active -> completed | disputed;
    # disputed -> completed | refunded.
    assert ("OLD.state = 'active'   AND NEW.state IN ('completed', 'disputed')"
            in MARKET_MIGRATION)
    assert ("OLD.state = 'disputed' AND NEW.state IN ('completed', 'refunded')"
            in MARKET_MIGRATION)
    # One open order per listing; one order per escrow.
    assert "marketplace_orders_one_open" in MARKET_MIGRATION
    assert "marketplace_orders_escrow" in MARKET_MIGRATION


def test_marketplace_purchase_composes_the_b56_escrow():
    # No new value machinery: the b56 definers do every movement.
    assert "FROM create_escrow(v_listing.seller, ARRAY[v_listing.price_minor]) e" in MARKET_MIGRATION
    assert "release_escrow_milestone(v_order.escrow_id, 1::smallint)" in MARKET_MIGRATION
    assert "dispute_escrow(v_order.escrow_id)" in MARKET_MIGRATION
    assert "resolve_escrow(v_order.escrow_id, p_decision)" in MARKET_MIGRATION
    # Value moves only inside the AMD-PAY-15 settlement gate.
    assert MARKET_MIGRATION.count("app.transfer_settlement") >= 3
    # Refund relists; release sells.
    assert "SET state = 'listed', listed_at = now()" in MARKET_MIGRATION
    assert "SET state = 'sold', closed_at = now()" in MARKET_MIGRATION
    # The marketplace invents no wallet writes of its own.
    assert "INSERT INTO wallet_entries" not in MARKET_MIGRATION
    assert "place_wallet_hold" not in MARKET_MIGRATION


def test_marketplace_eligibility_caps_and_moderation():
    # KYC gate, sensitive-category refusal, twelve-live cap, reason-coded
    # audited takedown.
    assert "'kyc_required'" in MARKET_MIGRATION
    assert "'sensitive_category'" in MARKET_MIGRATION
    assert "AND n.sensitive" in MARKET_MIGRATION
    assert ">= 12" in MARKET_MIGRATION
    assert "'reason_required'" in MARKET_MIGRATION
    assert "admin_audit_log(" in MARKET_MIGRATION
    assert "app_moderator()" in MARKET_MIGRATION
    # Every transition lands in the events ledger.
    assert MARKET_MIGRATION.count("INSERT INTO marketplace_events") >= 6


# ----------------------------------------------------------------- edge ---

def test_edge_modules_pin_the_contracts():
    assert 'DATING_GENDERS = ["female", "male", "nonbinary"]' in EDGE_DATING
    assert ('DATING_GOALS = ["long_term", "short_term", "friendship", "exploring"]'
            in EDGE_DATING)
    assert "DATING_AGE_MIN = 18" in EDGE_DATING
    assert "DATING_AGE_MAX = 99" in EDGE_DATING
    assert "DATING_MAX_SEEKING = 3" in EDGE_DATING
    assert 'LISTING_KINDS = ["item", "service"]' in EDGE_MARKET
    assert "LISTING_MAX_PRICE_MINOR = 5_000_000" in EDGE_MARKET
    assert "LISTING_MAX_ACTIVE = 12" in EDGE_MARKET
    assert 'MARKETPLACE_CURRENCY = "NGN"' in EDGE_MARKET
    assert "MARKETPLACE_BROWSE_LIMIT = 50" in EDGE_MARKET


def test_dating_routes_registered_and_shaped():
    assert 'import { registerDatingRoutes } from "./routes/dating.js";' in EDGE_APP
    assert "registerDatingRoutes(authed, ctx);" in EDGE_APP
    for route in ('"/v1/dating/preferences"', '"/v1/dating/profile"',
                  '"/v1/dating/state"', '"/v1/dating/compatibility"',
                  '"/v1/dating/counterpart"'):
        assert route in EDGE_DATING_ROUTES, route
    # No value moves: withRls only, never withSettlement.
    assert "withSettlement" not in EDGE_DATING_ROUTES
    posts = [m.start() for m in re.finditer(r"app\.post\(", EDGE_DATING_ROUTES)]
    assert len(posts) == 2
    for start in posts:
        assert "rateLimit" in EDGE_DATING_ROUTES[start:start + 900]


def test_marketplace_routes_registered_and_shaped():
    assert 'import { registerMarketplaceRoutes } from "./routes/marketplace.js";' in EDGE_APP
    assert "registerMarketplaceRoutes(authed, ctx);" in EDGE_APP
    # Registered after the innovation routes, keeping the b56 order.
    assert (EDGE_APP.index("registerInnovationRoutes(authed, ctx);")
            < EDGE_APP.index("registerMarketplaceRoutes(authed, ctx);"))
    for route in ('"/v1/marketplace/listings"', '"/v1/marketplace/listings/mine"',
                  '"/v1/marketplace/listings/:listingId/list"',
                  '"/v1/marketplace/listings/:listingId/remove"',
                  '"/v1/marketplace/listings/:listingId/purchase"',
                  '"/v1/marketplace/orders"',
                  '"/v1/marketplace/orders/:orderId/confirm"',
                  '"/v1/marketplace/orders/:orderId/dispute"',
                  '"/v1/moderation/marketplace/listings/:listingId/remove"',
                  '"/v1/moderation/marketplace/orders/:orderId/resolve"'):
        assert route in EDGE_MARKET_ROUTES, route
    # Value moves only inside withSettlement: purchase, confirm, resolve.
    assert EDGE_MARKET_ROUTES.count("withSettlement(") == 3
    # Both moderation routes are gated.
    blocks = re.split(r"app\.post\(", EDGE_MARKET_ROUTES)
    for block in blocks[1:]:
        if '"/v1/moderation/' in block.split(",", 1)[0]:
            assert "requireModerator" in block[:600], block[:120]
    # The browse projection carries no seller identity (FR-30).
    assert "BROWSE_PROJECTION" in EDGE_MARKET_ROUTES
    browse = re.search(r"BROWSE_PROJECTION = `(.*?)`;", EDGE_MARKET_ROUTES, re.S).group(1)
    assert "seller" not in browse
    # Every POST is rate-limited (AMD-OPS-03).
    posts = [m.start() for m in re.finditer(r"app\.post\(", EDGE_MARKET_ROUTES)]
    assert len(posts) == 8
    for start in posts:
        assert "rateLimit" in EDGE_MARKET_ROUTES[start:start + 900]


def test_scan_route_applies_the_dating_filter():
    assert "dating_filter_candidates($1::uuid[])" in EDGE_SCAN
    # The filter runs before any pair is recorded DETECTED.
    assert (EDGE_SCAN.index("dating_filter_candidates")
            < EDGE_SCAN.index("INSERT INTO matches"))


# ----------------------------------------------------------------- client ---

def test_client_contracts_mirror_the_edge():
    assert 'DATING_GENDERS = ["female", "male", "nonbinary"]' in CLIENT_DATING
    assert "DATING_AGE_MIN = 18" in CLIENT_DATING
    assert "validateDatingPreferences" in CLIENT_DATING
    assert "LISTING_MAX_PRICE_MINOR = 5_000_000" in CLIENT_LISTING
    assert 'MARKETPLACE_CURRENCY = "NGN"' in CLIENT_LISTING
    # Deterministic price formatting — no locale APIs.
    assert "toLocaleString" not in CLIENT_LISTING
    assert "Intl.NumberFormat" not in CLIENT_LISTING
    # The client tests cross-pin the edge modules.
    assert "../services/edge/src/dating.ts" in CLIENT_DATING_TEST
    assert "../services/edge/src/marketplace.ts" in CLIENT_LISTING_TEST


# ------------------------------------------------------------------- docs ---

def test_ux_doc_covers_both_amendments():
    for n in range(1, 6):
        assert f"AMD-DATE-{n:02d}" in UX_DOC, n
        assert f"AMD-MKT-{n:02d}" in UX_DOC, n


def test_openapi_documents_the_new_paths():
    for path in DATING_PATHS + MARKET_PATHS:
        assert f"  {path}" in OPENAPI, path


def test_every_new_openapi_post_declares_idempotency():
    start = OPENAPI.index("  /v1/dating/preferences:")
    section = OPENAPI[start:OPENAPI.index("components:", start)]
    posts = [m.start() for m in re.finditer(r"\n    post:", section)]
    assert len(posts) == 10
    misses = []
    for i, s in enumerate(posts):
        end = posts[i + 1] if i + 1 < len(posts) else len(section)
        if "IdempotencyKey" not in section[s:end]:
            heading = section[:s].rsplit("\n  /v1/", 1)[-1].splitlines()[0]
            misses.append(heading)
    assert misses == [], misses


def test_mounts_cover_migrations_0031_0032():
    assert "0031_dating.sql:/docker-entrypoint-initdb.d/33_dating.sql:ro" in COMPOSE
    assert "0032_marketplace.sql:/docker-entrypoint-initdb.d/34_marketplace.sql:ro" in COMPOSE
    assert "--from-file=33_dating.sql=db/migrations/0031_dating.sql" in K8S_README
    assert "--from-file=34_marketplace.sql=db/migrations/0032_marketplace.sql" in K8S_README


def test_edge_tests_cover_the_modules():
    for anchor in ("pinned constants match the migration contract",
                   "strict shape, no extra keys"):
        assert anchor in EDGE_DATING_TEST, anchor
        assert anchor in EDGE_MARKET_TEST, anchor


def test_sec17_document_vocabulary_stays_out_of_the_new_code():
    # SEC-17: the document vocabulary is banned in schema and edge source.
    banned = re.compile(
        r"\b(passport|id_document|identity_document|document_scan|"
        r"document_image|nin|bvn|driver_licen[cs]e|national_id)\b", re.I)
    for src in (DATING_MIGRATION, MARKET_MIGRATION, EDGE_DATING,
                EDGE_MARKET, EDGE_DATING_ROUTES, EDGE_MARKET_ROUTES):
        assert not banned.search(src)
