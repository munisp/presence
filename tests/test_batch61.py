"""Batch 61 invariants — service bookings, the services vertical (SRS
Addendum 001, AMD-SVC-01..05):

  AMD-SVC-01  structured service booking: a service-kind listing, the two
              parties, an agreed total riding the AMD-PAY-05 ceiling, a
              milestone count (1..12), the escrow, and nothing else — no
              description, no scheduling free text, no address. Terms
              immutable; same-state writes are no-ops only; the
              accepted|in_progress|completed|cancelled|disputed machine is
              enforced by the database. `services` joins the vertical
              catalogue as the tenth vertical (sort 45, KYC-gated).
  AMD-SVC-02  escrow-composed booking: the customer's AMD-INN-03 milestone
              escrow IS the booking — composed exactly like a marketplace
              purchase, except the listing stays listed. Even split, the
              last milestone absorbing the remainder; both sides
              KYC-verified at booking; blocks refuse both directions. The
              provider starts (no value moves); the customer confirms
              milestones through the escrow release definer; the last
              release completes escrow and booking atomically.
  AMD-SVC-03  moderation: a moderator alone resolves from `disputed` by
              delegating to the escrow resolver unchanged — the AMD-ESC-01
              four-eyes gate applies above 1,000,000 minor of remaining
              value, and the resolver's service propagation block makes
              the direct and approved paths resolve identically.
  AMD-SVC-04  the stale-booking clocks: an accepted booking auto-refunds
              after 168 h (the escrow walks its guard-legal
              active→disputed→refunded path); an in_progress booking
              escalates to disputed after 30 d. The expirer refuses to run
              without the settlement gate.
  AMD-SVC-05  observability and record-keeping: every transition lands in
              the append-only service_events ledger; bookings survive
              account deletion tied to the tombstone; the FR-62 export
              carries them with role and counterparty; reconciliation
              reports open service disputes, the oldest dispute age and
              the stuck-booking count.

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
MIGRATION = (ROOT / "db/migrations/0036_service_bookings.sql").read_text()
EDGE_SERVICES = (EDGE / "src/services.ts").read_text()
EDGE_ROUTES = (EDGE / "src/routes/services.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
EDGE_VERTICALS = (EDGE / "src/verticals.ts").read_text()
CLIENT = (ROOT / "client/src/presence/serviceBooking.ts").read_text()
COPY = (ROOT / "client/src/presence/copyRegistry.ts").read_text()
GO = (ROOT / "services/presence-go/verticals.go").read_text()
RUST = (ROOT / "services/match-core/src/verticals.rs").read_text()
PYREF = (ROOT / "presence/verticals.py").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
UX_DOC = (ROOT / "docs/ux/service-bookings.md").read_text()

PUBLIC_DEFINERS = (
    "book_service", "start_service", "confirm_service_milestone",
    "dispute_service", "resolve_service", "expire_stale_services",
)


def _fn_body(src: str, name: str) -> str:
    start = src.index(f"CREATE OR REPLACE FUNCTION {name}(")
    end = src.index("END $$;", start)
    return src[start:end]


# --------------------------------------------------------------- addendum ---

def test_addendum_carries_the_five_amendments():
    assert "## AMD-SVC — Service bookings (services vertical)" in ADDENDUM
    for amd in ("AMD-SVC-01", "AMD-SVC-02", "AMD-SVC-03", "AMD-SVC-04",
                "AMD-SVC-05"):
        assert f"**{amd} " in ADDENDUM, amd
    assert "AMD-SVC-01..05 added alongside batch 61" in ADDENDUM
    assert "tests/test_batch61.py` pins the service bookings" in ADDENDUM


def test_addendum_pinned_numbers_match_the_migration():
    # 12 milestones, 5,000,000 ceiling, 168h/30d clocks, 1M four-eyes floor.
    assert "1–12" in ADDENDUM
    assert "5,000,000 minor" in ADDENDUM
    assert "168 hours" in ADDENDUM and "30 days" in ADDENDUM
    assert "1,000,000 minor" in ADDENDUM
    # v1 carries no customer-cancel / provider-decline surface, deliberately.
    assert "no customer-cancel and no provider-decline" in ADDENDUM


# -------------------------------------------------------------- migration ---

def test_migration_declares_the_two_tables():
    for table in ("service_bookings", "service_events"):
        assert f"CREATE TABLE {table}" in MIGRATION, table
        assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in MIGRATION, table


def test_service_booking_contract():
    # State machine vocabulary and the pinned caps.
    assert re.search(r"CHECK \(state IN \('accepted', 'in_progress', 'completed',\s+"
                     r"'cancelled', 'disputed'\)\)", MIGRATION)
    assert re.search(r"CHECK \(agreed_minor > 0 AND agreed_minor <= 5000000\)",
                     MIGRATION)
    assert "CHECK (milestones BETWEEN 1 AND 12)" in MIGRATION
    assert re.search(r"currency\s+text NOT NULL DEFAULT 'NGN'"
                     r" CHECK \(currency = 'NGN'\)", MIGRATION)
    assert "CHECK (customer <> provider)" in MIGRATION
    # One escrow per booking.
    assert re.search(r"escrow_id\s+uuid NOT NULL UNIQUE REFERENCES"
                     r" escrow_agreements \(escrow_id\)", MIGRATION)
    # Terms are immutable once created.
    guard = _fn_body(MIGRATION, "service_bookings_guard")
    assert "immutable" in guard
    # The v1 scope note is documented in the migration header.
    assert "no customer cancel" in MIGRATION and "decline definer" in MIGRATION


def test_transition_table_is_guarded():
    guard = _fn_body(MIGRATION, "service_bookings_guard")
    assert re.search(
        r"OLD\.state = 'accepted'\s+AND NEW\.state IN \('in_progress', 'cancelled', 'disputed'\)",
        guard)
    assert re.search(
        r"OLD\.state = 'in_progress'\s+AND NEW\.state IN \('completed', 'disputed'\)",
        guard)
    assert re.search(
        r"OLD\.state = 'disputed'\s+AND NEW\.state IN \('completed', 'cancelled'\)",
        guard)
    # A same-state update may only be a no-op.
    assert "IF NEW.state = OLD.state THEN" in guard
    same = guard[guard.index("IF NEW.state = OLD.state THEN"):]
    assert "IS DISTINCT FROM" in same
    assert "illegal service booking update" in same


def test_service_events_are_append_only():
    guard = _fn_body(MIGRATION, "service_events_guard")
    assert "RAISE EXCEPTION" in guard and "append-only" in guard
    assert ("CREATE TRIGGER service_events_guard\n"
            "    BEFORE UPDATE OR DELETE ON service_events" in MIGRATION)


def test_party_read_rls_policies():
    assert re.search(r"CREATE POLICY service_bookings_party_read ON service_bookings"
                     r"\s+FOR SELECT USING \(app_user\(\) IN \(customer, provider\)"
                     r" OR app_moderator\(\)\)", MIGRATION)
    assert "CREATE POLICY service_events_party_read ON service_events" in MIGRATION
    # No write policies — every write flows through the definers.
    assert not re.search(r"CREATE POLICY \w+ ON service_bookings\s+FOR (INSERT|UPDATE|DELETE)",
                         MIGRATION)


def test_book_service_composes_create_escrow():
    book = _fn_body(MIGRATION, "book_service")
    # The settlement gate (the purchase idiom: gate-off answers 'forbidden').
    assert "current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'" in book
    # KYC both sides, block check both directions, service kind required,
    # no self-booking, the listing must be listed.
    assert book.count("kyc_state = 'verified'") == 2
    assert "LEAST(" in book and "GREATEST(" in book
    assert "v_listing.kind <> 'service'" in book
    assert "v_listing.seller = v_user" in book
    assert "v_listing.state <> 'listed'" in book
    # The listing STAYS listed — a service offer is repeatable.
    assert "UPDATE marketplace_listings" not in book
    # Even split, the last milestone absorbing the remainder.
    assert "p_amount_minor / p_milestones" in book
    assert "p_amount_minor - v_base * p_milestones" in book
    # Composition through the escrow definer, outcome passed through.
    assert "create_escrow(v_listing.seller, v_amounts)" in book
    for outcome in ("'booked'", "'forbidden'", "'kyc_required'",
                    "'unknown_listing'", "'not_a_service'", "'self'",
                    "'unavailable'", "'invalid_amount'",
                    "'invalid_milestones'", "'blocked'"):
        assert outcome in book, outcome


def test_start_and_confirm_discipline():
    start = _fn_body(MIGRATION, "start_service")
    # Provider-only, accepted-only; no settlement gate (no value moves).
    assert "v_user <> v_bk.provider" in start
    assert "v_bk.state <> 'accepted'" in start
    assert "transfer_settlement" not in start
    confirm = _fn_body(MIGRATION, "confirm_service_milestone")
    # Customer-only, in-progress-only; delegates to the escrow release.
    assert "v_user <> v_bk.customer" in confirm
    assert "v_bk.state <> 'in_progress'" in confirm
    assert "release_escrow_milestone(v_bk.escrow_id, p_milestone)" in confirm
    assert "current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'" \
        in confirm
    # 'released' → 'confirmed'; 'completed' completes the booking.
    assert "IF v_out = 'released' THEN" in confirm
    assert "IF v_out = 'completed' THEN" in confirm
    completed = confirm[confirm.index("IF v_out = 'completed' THEN"):]
    assert "SET state = 'completed', completed_at = now()" in completed


def test_dispute_never_gated_and_resolution_delegates():
    dispute = _fn_body(MIGRATION, "dispute_service")
    # A dispute must always be available — no settlement gate.
    assert "transfer_settlement" not in dispute
    assert "v_user NOT IN (v_bk.customer, v_bk.provider)" in dispute
    assert "v_bk.state NOT IN ('accepted', 'in_progress')" in dispute
    assert "dispute_escrow(v_bk.escrow_id)" in dispute
    resolve = _fn_body(MIGRATION, "resolve_service")
    assert "app_moderator()" in resolve
    assert "current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on'" \
        in resolve
    assert "p_decision NOT IN ('refund', 'release')" in resolve
    assert "v_bk.state <> 'disputed'" in resolve
    # Delegates; 'approval_required' passes through verbatim.
    assert "resolve_escrow(v_bk.escrow_id, p_decision)" in resolve
    assert "RETURN v_out" in resolve


def test_resolve_escrow_propagates_to_bookings():
    # The redefined resolver carries the service propagation block — the
    # four-eyes approval path resolves bookings identically (b58 lesson).
    resolver = _fn_body(MIGRATION, "resolve_escrow")
    assert "v_booking" in resolver
    prop = resolver[resolver.index("v_booking"):]
    assert re.search(r"UPDATE service_bookings b\s+SET state", prop)
    assert "WHERE b.escrow_id = p_escrow AND b.state = 'disputed'" in prop
    assert "INSERT INTO service_events" in prop


def test_expiry_clocks_walk_the_legal_path():
    expire = _fn_body(MIGRATION, "expire_stale_services")
    # The expirer refuses outright without the settlement gate.
    assert "RAISE EXCEPTION 'settlement gate required (AMD-SVC-04)'" in expire
    # 168 h ghost-refund: the escrow guard forbids active→refunded, so the
    # walk goes active→disputed→refunded with the hold voided between.
    assert "interval '168 hours'" in expire
    walk = expire.index("SET state = 'disputed', disputed_at = now()")
    assert walk < expire.index("void_wallet_hold")
    assert expire.index("void_wallet_hold") < expire.index(
        "SET state = 'refunded', resolved_at = now(), resolved_by = NULL")
    # 30 d in-progress escalation to disputed.
    assert "interval '30 days'" in expire
    assert "SET state = 'disputed', disputed_at = now()" in expire
    assert "SET state = 'cancelled', cancelled_at = now()" in expire


def test_dsar_export_and_reconciliation_carry_services():
    dsar = _fn_body(MIGRATION, "dsar_export")
    assert "'services'" in dsar
    for key in ("'bookingId'", "'listingId'", "'role'", "'counterparty'",
                "'agreedMinor'", "'milestones'", "'state'"):
        assert key in dsar, key
    recon = _fn_body(MIGRATION, "wallet_reconciliation")
    assert "'openServiceDisputes'" in recon
    assert "'oldestServiceDisputeSeconds'" in recon
    assert "'stuckServices'" in recon
    # The batch-59/60 keys survive the redefinition.
    assert "'openSwapDisputes'" in recon
    assert "'swaps'" in dsar


def test_vertical_catalogue_gains_the_tenth_row():
    assert re.search(r"\('services', 'Services',", MIGRATION)
    assert re.search(r"false, true, false, true, 45\)", MIGRATION)


def test_grants():
    assert "GRANT SELECT ON service_bookings, service_events TO presence_app" \
        in MIGRATION
    for name, sig in (("book_service", "uuid, bigint, smallint"),
                      ("start_service", "uuid"),
                      ("confirm_service_milestone", "uuid, smallint"),
                      ("dispute_service", "uuid"),
                      ("resolve_service", "uuid, text"),
                      ("expire_stale_services", "")):
        assert re.search(
            rf"GRANT EXECUTE ON FUNCTION {name}\({sig}\) TO presence_app",
            MIGRATION,
        ), name


def test_no_banned_vocabulary():
    # FR-17: the word "intent" never appears in SQL.
    assert "intent" not in MIGRATION.lower()
    # SEC-17: no government-identifier vocabulary in the migration.
    assert not re.search(r"passport|\bnin\b|\bbvn\b", MIGRATION.lower())


# -------------------------------------------------------------------- edge ---

def test_edge_constants_mirror_the_migration():
    assert "SERVICE_MAX_AMOUNT_MINOR = 5_000_000" in EDGE_SERVICES
    assert "SERVICE_MAX_MILESTONES = 12" in EDGE_SERVICES
    assert "SERVICE_START_TTL_SECONDS = 604_800" in EDGE_SERVICES
    assert "SERVICE_STALE_SECONDS = 2_592_000" in EDGE_SERVICES
    assert 'SERVICE_CURRENCY = "NGN"' in EDGE_SERVICES
    assert '"accepted", "in_progress", "completed", "cancelled", "disputed"' \
        in EDGE_SERVICES


def test_edge_routes_cover_the_surface():
    for route in (
        '"/v1/services/bookings"',
        '"/v1/services/bookings/mine"',
        '"/v1/services/bookings/:bookingId"',
        '"/v1/services/bookings/:bookingId/start"',
        '"/v1/services/bookings/:bookingId/milestones/:milestone/confirm"',
        '"/v1/services/bookings/:bookingId/dispute"',
        '"/v1/moderation/services/disputed"',
        '"/v1/moderation/services/:bookingId/resolve"',
    ):
        assert route in EDGE_ROUTES, route
    # Value moves only inside withSettlement — the three value-touching
    # routes (book, confirm, resolve); start/dispute/reads ride withRls.
    assert EDGE_ROUTES.count("withSettlement(") == 3
    # The rail kill switch answers 503 on every settlement path.
    assert "WalletRailUnavailable" in EDGE_ROUTES
    # The moderation resolve requires the moderator role AND the rail, and
    # the four-eyes passthrough answers 202.
    resolve = EDGE_ROUTES[EDGE_ROUTES.index("/v1/moderation/services/:bookingId/resolve"):]
    assert "requireModerator" in resolve
    assert '"app.moderator"' in resolve
    assert 'reply.code(202).send({ state: "approval_required" })' in resolve
    # Registered in the app and gated under the services vertical.
    assert 'import { registerServiceRoutes } from "./routes/services.js"' in EDGE_APP
    assert "registerServiceRoutes(authed, ctx)" in EDGE_APP
    assert '[/^\\/v1\\/services(\\/|$)/, "services"]' in EDGE_VERTICALS


def test_edge_parsers_are_strict():
    # Exact key counts — a smuggled field refuses the body (FR-96/SEC-37).
    assert "keys.length !== 3" in EDGE_SERVICES
    assert "keys.length !== 1" in EDGE_SERVICES
    # The booking parser pins the ceiling and the milestone bound.
    assert "SERVICE_MAX_AMOUNT_MINOR" in EDGE_SERVICES
    assert "SERVICE_MAX_MILESTONES" in EDGE_SERVICES
    # SEC-17: no government-identifier vocabulary in the edge module.
    assert not re.search(r"passport|\bnin\b|\bbvn\b", EDGE_SERVICES.lower())
    assert not re.search(r"passport|\bnin\b|\bbvn\b", EDGE_ROUTES.lower())


# ------------------------------------------------------------------ parity ---

def test_parity_mirrors_carry_the_services_mapping():
    assert '{"/v1/services", VerticalServices}' in GO
    assert '("/v1/services", Vertical::Services)' in RUST
    assert '("/v1/services", "services")' in PYREF
    # The tenth catalogue row, in all three mirrors.
    assert "VerticalServices" in GO
    assert "Vertical::Services" in RUST
    assert '("services", False, True, False, True, 45)' in PYREF
    # The Rust arrays are re-bound (the b60 lesson).
    assert "[CatalogueEntry; 10]" in RUST
    assert "[(&str, Vertical); 19]" in RUST


# ------------------------------------------------------------------ client ---

def test_client_mirrors_and_copy():
    assert "SERVICE_MAX_AMOUNT_MINOR = 5_000_000" in CLIENT
    assert "SERVICE_MAX_MILESTONES = 12" in CLIENT
    assert "SERVICE_START_TTL_SECONDS = 604_800" in CLIENT
    assert 'SERVICE_CURRENCY = "NGN"' in CLIENT
    # The wire parsers refuse any smuggled field — exact key counts.
    assert "keys.length !== 14" in CLIENT
    assert "keys.length !== 5" in CLIENT
    # The transition table mirrors the guard.
    assert '["accepted", "in_progress"]' in CLIENT
    assert '["disputed", "cancelled"]' in CLIENT
    for key in ("ui.services.title", "ui.services.book", "ui.services.start",
                "ui.services.confirm-milestone", "ui.services.dispute",
                "ui.services.booking.state.disputed",
                "ui.vertical.services.label", "ui.vertical.services.summary"):
        assert f'"{key}"' in COPY, key


# ----------------------------------------------------------------- openapi ---

def test_openapi_documents_the_surface():
    doc = yaml.safe_load(OPENAPI)
    paths = doc["paths"]
    for path in (
        "/v1/services/bookings",
        "/v1/services/bookings/mine",
        "/v1/services/bookings/{bookingId}",
        "/v1/services/bookings/{bookingId}/start",
        "/v1/services/bookings/{bookingId}/milestones/{milestone}/confirm",
        "/v1/services/bookings/{bookingId}/dispute",
        "/v1/moderation/services/disputed",
        "/v1/moderation/services/{bookingId}/resolve",
    ):
        assert path in paths, path
    # Five POSTs: book, start, confirm, dispute, resolve.
    post_paths = [p for p in paths if p.startswith("/v1/services")
                  or p.startswith("/v1/moderation/services")]
    posts = sum(1 for p in post_paths if "post" in paths[p])
    assert posts == 5
    gets = sum(1 for p in post_paths if "get" in paths[p])
    assert gets == 3
    # The booking schema is closed and pins the bounds.
    schema = paths["/v1/services/bookings"]["post"]["requestBody"]["content"][
        "application/json"]["schema"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {"listingId", "agreedMinor", "milestones"}
    assert schema["properties"]["agreedMinor"]["maximum"] == 5000000
    assert schema["properties"]["milestones"]["maximum"] == 12
    # The resolve path documents the four-eyes 202.
    resolve = paths["/v1/moderation/services/{bookingId}/resolve"]["post"]
    assert "202" in resolve["responses"]


def test_openapi_post_windows():
    # The b59/b60 windows keep their counts; the escrow→components window
    # grew by exactly the five service POSTs (11 → 16), then by the six
    # batch-62 onboarding POSTs — apply, withdraw, approve, reject, KYC
    # request, venue activate (16 → 22; batch 62 pins them separately).
    bond = OPENAPI.index("/v1/presence/bond:")
    dating = OPENAPI.index("/v1/dating/preferences:")
    esc = OPENAPI.index("/v1/moderation/escrow-resolutions:")
    comps = OPENAPI.index("components:")
    assert len(re.findall(r"\n    post:", OPENAPI[bond:dating])) == 18
    assert len(re.findall(r"\n    post:", OPENAPI[dating:esc])) == 10
    assert len(re.findall(r"\n    post:", OPENAPI[esc:comps])) == 22


def test_every_service_openapi_post_declares_idempotency():
    # Batch 62 re-bounds the section end: the onboarding paths land between
    # the services block and components:, so the service window ends at the
    # first batch-62 path.
    start = OPENAPI.index("  /v1/services/bookings:")
    section = OPENAPI[start:OPENAPI.index("  /v1/account/onboarding:", start)]
    posts = [m.start() for m in re.finditer(r"\n    post:", section)]
    assert len(posts) == 5  # book, start, confirm, dispute, moderation resolve
    misses = []
    for i, s in enumerate(posts):
        end = posts[i + 1] if i + 1 < len(posts) else len(section)
        if "IdempotencyKey" not in section[s:end]:
            heading = section[:s].rsplit("\n  /v1/", 1)[-1].splitlines()[0]
            misses.append(heading)
    assert misses == [], misses


# ------------------------------------------------------------------ deploy ---

def test_migration_rides_both_initdb_mounts():
    assert "/docker-entrypoint-initdb.d/38_service_bookings.sql:ro" in COMPOSE
    assert "../db/migrations/0036_service_bookings.sql" in COMPOSE
    assert "--from-file=38_service_bookings.sql=db/migrations/0036_service_bookings.sql" \
        in K8S_README


def test_ux_doc_exists_and_carries_the_amendment():
    assert "AMD-SVC-01..05" in UX_DOC
    assert "service" in UX_DOC.lower()
    assert "ghosting clock" in UX_DOC
