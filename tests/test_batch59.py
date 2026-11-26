"""Batch 59 invariants — vertical feature flags (SRS Addendum 001,
AMD-VERT-01..05):

  AMD-VERT-01  vertical catalogue: ten governed verticals — the locked
               `discovery` core plus venues, groups, dating, marketplace,
               services (batch 61), payments, trust, introductions,
               serendipity — with KYC/adult gates mirroring the proofs the
               feature definers demand.
  AMD-VERT-02  per-user flags: default-on (an absent row keeps today's
               behaviour for every existing account), explicit rows narrow,
               writes go through the definer alone (app role holds SELECT
               only), every choice records its source.
  AMD-VERT-03  single resolver: vertical_enabled — locked core always on,
               explicit row wins, catalogue default otherwise, unknown
               verticals fail closed — enforced by one authenticated edge
               preHandler gate keyed on the route template. Moderation,
               account, consent, profile, taxonomy, telemetry and ops
               surfaces are never gated.
  AMD-VERT-04  onboarding read model: list_my_verticals renders the full
               catalogue in display order with effective state, eligibility
               and reason, and explicit-choice markers.
  AMD-VERT-05  batch toggle write: set_user_verticals validates the whole
               patch before any row moves; the locked core refuses
               narrowing; enabling a gated vertical re-proves KYC/adult at
               write; disabling never requires eligibility.

Cross-language parity: the SQL seed, the edge mirror, the client mirror,
the Go mirror (services/presence-go/verticals.go), the Rust mirror
(services/match-core/src/verticals.rs) and the Python reference
(presence/verticals.py) all carry the same ten keys in the same order
with the same locked core and gates — pinned here.

The 306-requirement ledger stays untouched; amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md.
"""

from __future__ import annotations

import re

import pytest
import yaml
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / "services/edge"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0034_vertical_flags.sql").read_text()
MIGRATION_61 = (ROOT / "db/migrations/0036_service_bookings.sql").read_text()
EDGE_VERTICALS = (EDGE / "src/verticals.ts").read_text()
EDGE_VERTICAL_ROUTES = (EDGE / "src/routes/verticals.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
CLIENT = (ROOT / "client/src/presence/verticalOnboarding.ts").read_text()
COPY = (ROOT / "client/src/presence/copyRegistry.ts").read_text()
GO = (ROOT / "services/presence-go/verticals.go").read_text()
RUST = (ROOT / "services/match-core/src/verticals.rs").read_text()
PYREF = (ROOT / "presence/verticals.py").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()

VERTICALS = (
    "discovery", "venues", "groups", "dating", "marketplace",
    "services", "payments", "trust", "introductions", "serendipity",
)

from presence.verticals import (  # noqa: E402
    CATALOGUE,
    LOCKED_VERTICAL,
    VERTICALS as PY_VERTICALS,
    vertical_enabled,
    vertical_for_template,
)


def _fn_body(src: str, name: str) -> str:
    start = src.index(f"CREATE OR REPLACE FUNCTION {name}(")
    end = src.index("END $$;", start)
    return src[start:end]


# ----------------------------------------------------------- migration ---

def test_addendum_documents_the_amendment():
    for n in range(1, 6):
        assert f"AMD-VERT-{n:02d}" in ADDENDUM, n
    assert "batch 59" in ADDENDUM
    # The safety rule is stated in the amendment.
    assert "MUST NOT be gated" in ADDENDUM


def test_catalogue_table_and_seed():
    assert "CREATE TABLE vertical_catalogue" in MIGRATION
    # The batch-59 nine seeded in display order in 0034; batch 61's
    # services row rides 0036 (sort 45 keeps the display order stable).
    nine = [v for v in VERTICALS if v != "services"]
    positions = [MIGRATION.index(f"('{v}',") for v in nine]
    assert positions == sorted(positions)
    # The locked core: locked=true, no gates, default on, sort 0.
    assert re.search(
        r"\('discovery', 'Discovery',.*\n\s*true, false, false, true, 0\)",
        MIGRATION, re.S)
    # Gates mirror the feature definers: dating is the only adult gate.
    assert re.search(r"\('dating', 'Dating',.*\n\s*false, true, true, true, 30\)",
                     MIGRATION, re.S)
    # Every vertical ships default-on (backward compatibility).
    assert MIGRATION.count("true, 10)") == 1  # venues
    for tail in ("true, 20)", "true, 40)", "true, 50)", "true, 60)",
                 "true, 70)", "true, 80)"):
        assert tail in MIGRATION, tail
    # Batch 61: the services row (KYC-gated, no adult gate, sort 45).
    assert re.search(
        r"\('services', 'Services',.*\n\s*false, true, false, true, 45\)",
        MIGRATION_61, re.S)


def test_flags_table_is_owner_read_definer_write():
    assert "CREATE TABLE user_vertical_flags" in MIGRATION
    assert "PRIMARY KEY (user_id, vertical)" in MIGRATION
    assert re.search(
        r"source\s+text\s+NOT NULL\s+CHECK \(source IN \('onboarding', 'settings', 'ops'\)\)",
        MIGRATION)
    assert "ALTER TABLE user_vertical_flags ENABLE ROW LEVEL SECURITY" in MIGRATION
    assert "user_vertical_flags_owner_read" in MIGRATION
    # The app role reads; only the definer writes.
    assert ("GRANT SELECT ON vertical_catalogue, user_vertical_flags "
            "TO presence_app") in MIGRATION
    assert not re.search(
        r"GRANT (INSERT|UPDATE|DELETE)[^;]*user_vertical_flags", MIGRATION)


def test_vertical_enabled_resolver():
    body = _fn_body(MIGRATION, "vertical_enabled")
    assert "STABLE SECURITY DEFINER SET search_path = public" in body
    # Fail closed without a caller and on unknown verticals.
    assert "IF v_user IS NULL THEN" in body
    assert "IF NOT FOUND THEN" in body
    # Locked core always on; explicit row wins; catalogue default else.
    assert "IF v_cat.locked THEN" in body
    assert "RETURN true;" in body
    assert "COALESCE(" in body
    assert "v_cat.default_enabled" in body


def test_list_my_verticals_read_model():
    body = _fn_body(MIGRATION, "list_my_verticals")
    assert "STABLE SECURITY DEFINER SET search_path = public" in body
    for col in ("vertical", "label", "summary", "locked", "eligible",
                "reason", "enabled", "explicit_choice", "source",
                "sort_order"):
        assert col in body, col
    # Eligibility reflects the catalogue gates against current posture.
    assert "u.kyc_state = 'verified'" in body
    assert "extract(year FROM now())::int - 18" in body
    assert "'kyc_required'" in body and "'underage'" in body
    # Display order is the catalogue's.
    assert "ORDER BY c.sort_order" in body


def test_set_user_verticals_all_or_nothing():
    body = _fn_body(MIGRATION, "set_user_verticals")
    assert "SECURITY DEFINER SET search_path = public" in body
    # The whole patch validates before any row moves: the validation loop
    # precedes the write loop.
    validate = body.index("Validate the entire patch before writing anything")
    write = body.index("INSERT INTO user_vertical_flags")
    assert validate < write
    for outcome in ("'forbidden'", "'invalid_patch'", "'unknown_vertical'",
                    "'locked'", "'kyc_required'", "'underage'", "'updated'"):
        assert f"RETURN {outcome}" in body, outcome
    # Enabling re-proves the gates; disabling never does (the eligibility
    # checks sit inside the v_enabled branch).
    enable_branch = body.index("IF v_enabled THEN")
    assert body.index("v_cat.requires_kyc") > enable_branch
    assert body.index("v_cat.requires_adult") > enable_branch
    # The locked core refuses narrowing.
    assert "IF v_cat.locked AND NOT v_enabled THEN" in body
    assert "ON CONFLICT (user_id, vertical) DO UPDATE" in body


def test_sec17_and_fr17_vocabulary_stays_out():
    banned = re.compile(
        r"\b(passport|id_document|identity_document|document_scan|"
        r"document_image|nin|bvn|driver_licen[cs]e|national_id)\b", re.I)
    for src in (MIGRATION, EDGE_VERTICALS, EDGE_VERTICAL_ROUTES, CLIENT,
                GO, RUST, PYREF):
        assert not banned.search(src)
    # FR-17: the word stays out of the migration entirely.
    assert "intent" not in MIGRATION.lower()


# ------------------------------------------------------------------ edge ---

def test_edge_catalogue_mirror_matches_sql():
    block = EDGE_VERTICALS[EDGE_VERTICALS.index("export const VERTICALS"):]
    for v in VERTICALS:
        assert f'"{v}"' in block, v
    # Same order as the Python reference tuple.
    order = [block.index(f'"{v}"') for v in VERTICALS]
    assert order == sorted(order)
    assert 'LOCKED_VERTICAL: Vertical = "discovery"' in EDGE_VERTICALS


def test_edge_gate_map_covers_every_toggleable_vertical():
    # Every toggleable vertical has at least one route-template rule; the
    # locked core never appears in the gate map.
    rules = EDGE_VERTICALS[EDGE_VERTICALS.index("const TEMPLATE_RULES"):]
    for v in VERTICALS[1:]:
        assert f', "{v}"],' in rules, v
    assert ', "discovery"]' not in rules
    # Moderation surfaces are deliberately unmapped (regex literals only —
    # comments may name the surface).
    assert "^\\/v1\\/moderation" not in rules
    # The mapped surfaces (TS regex literals escape the slashes).
    for anchor in ("/v1/dating", "/v1/marketplace", "/v1/transfers",
                   "/v1/wallets", "/v1/presence/bond", "/v1/met-receipts",
                   "/v1/escrows", "/v1/disclosure-grants", "/v1/attestation",
                   "/v1/introductions", "/v1/serendipity", "/v1/rooms",
                   "/v1/tables", "/v1/slots", "/v1/announcements",
                   "/v1/presence/checkin", "/v1/groups"):
        assert anchor.replace("/", "\\/") in rules, anchor


def test_edge_gate_registration_and_response():
    # After authenticate, before idempotency.
    auth = EDGE_APP.index('authed.addHook("onRequest", authenticate);')
    gate = EDGE_APP.index('authed.addHook("preHandler", verticalGate(ctx));')
    idem = EDGE_APP.index("registerIdempotency(authed, ctx);")
    assert auth < gate < idem
    assert "registerVerticalRoutes(authed, ctx);" in EDGE_APP
    # Fail-closed neutral refusal.
    assert 'reply.code(403).send({ error: "vertical_disabled", vertical })' \
        in EDGE_VERTICALS
    # The resolver runs inside withRls as the caller.
    assert "withRls(ctx.pg, req.userId" in EDGE_VERTICALS
    assert "SELECT vertical_enabled($1) AS enabled" in EDGE_VERTICALS


def test_edge_account_routes():
    assert 'app.get("/v1/account/verticals"' in EDGE_VERTICAL_ROUTES
    assert 'app.put(\n    "/v1/account/verticals"' in EDGE_VERTICAL_ROUTES
    assert "SELECT * FROM list_my_verticals()" in EDGE_VERTICAL_ROUTES
    assert "SELECT set_user_verticals($1::jsonb, $2) AS outcome" \
        in EDGE_VERTICAL_ROUTES
    # Outcome mapping: 200 updated; 400 invalid/unknown; 409 locked;
    # 403 kyc_required/underage/forbidden.
    assert 'reply.code(400).send({ error: outcome })' in EDGE_VERTICAL_ROUTES
    assert 'reply.code(outcome === "locked" ? 409 : 403)' \
        in EDGE_VERTICAL_ROUTES
    # The PUT is rate-limited per user like every other write.
    assert "VERTICAL_WRITE_RATE_LIMIT" in EDGE_VERTICAL_ROUTES


def test_edge_parser_is_strict():
    parser = EDGE_VERTICALS[EDGE_VERTICALS.index("export function "
                                                  "parseVerticalsPatchBody"):]
    # Unknown keys, unknown source, empty patch, non-boolean, locked
    # narrowing all refuse before the definer runs.
    assert 'k !== "patch" && k !== "source"' in parser
    assert "PATCH_SOURCES" in parser
    assert "entries.length === 0" in parser
    assert 'typeof value !== "boolean"' in parser
    assert "key === LOCKED_VERTICAL && value === false" in parser


# ---------------------------------------------------------------- client ---

def test_client_catalogue_mirror_matches_sql():
    for v in VERTICALS:
        assert f'vertical: "{v}"' in CLIENT, v
    order = [CLIENT.index(f'vertical: "{v}"') for v in VERTICALS]
    assert order == sorted(order)
    assert 'LOCKED_VERTICAL: Vertical = "discovery"' in CLIENT
    # Gates mirror the SQL seed (client field names are camelCase).
    dating = CLIENT[CLIENT.index('vertical: "dating"'):]
    assert "requiresKyc: true" in dating.split("},")[0]
    assert "requiresAdult: true" in dating.split("},")[0]


def test_client_toggle_model_and_patch_builder():
    # The locked core renders always-on with no toggle.
    assert 'disabledReason: "locked"' in CLIENT
    assert '"ui.verticals.locked"' in CLIENT
    # Ineligible verticals render disabled with their reason copy.
    assert "ui.verticals.ineligible." in CLIENT
    # The patch builder mirrors the edge/definer validation.
    for err in ("empty_patch", "unknown_vertical", "non_boolean",
                "locked_narrowed", "source_unknown"):
        assert f'"{err}"' in CLIENT, err
    # Affirming the locked core is a no-op that never hits the wire.
    assert "never sent on the wire" in CLIENT


def test_copy_registry_keys():
    for key in (
        "ui.verticals.title", "ui.verticals.subtitle", "ui.verticals.locked",
        "ui.verticals.ineligible.kyc_required",
        "ui.verticals.ineligible.underage", "ui.verticals.disabled",
    ):
        assert f'"{key}"' in COPY, key
    for v in VERTICALS:
        assert f'"ui.vertical.{v}.label"' in COPY, v
        assert f'"ui.vertical.{v}.summary"' in COPY, v


# ------------------------------------------- cross-language parity pins ---

def test_go_mirror_carries_the_catalogue():
    for v in VERTICALS:
        assert f'Vertical = "{v}"' in GO or f'"{v}"' in GO, v
    assert "const LockedVertical = VerticalDiscovery" in GO
    # Ten seed rows (positional struct literals).
    assert len(re.findall(r"\{Vertical[A-Za-z]+, (?:true|false),", GO)) == 10
    assert "VerticalForTemplate" in GO and "VerticalEnabled" in GO


def test_rust_mirror_carries_the_catalogue():
    for name in ("Discovery", "Venues", "Groups", "Dating", "Marketplace",
                 "Services", "Payments", "Trust", "Introductions",
                 "Serendipity"):
        assert name in RUST, name
    assert "pub const CATALOGUE: [CatalogueEntry; 10]" in RUST
    assert "pub const LOCKED_VERTICAL: Vertical = Vertical::Discovery" in RUST
    assert "pub fn vertical_enabled" in RUST
    assert "pub fn vertical_for_template" in RUST


def test_python_reference_matches_and_runs():
    assert PY_VERTICALS == VERTICALS
    assert LOCKED_VERTICAL == "discovery"
    assert [row[0] for row in CATALOGUE] == list(VERTICALS)
    assert all(row[4] is True for row in CATALOGUE)  # default-on everywhere
    assert CATALOGUE[0][1] is True                   # discovery locked
    # Resolver semantics.
    assert vertical_enabled("discovery", False) is True   # locked wins
    assert vertical_enabled("dating") is True             # default
    assert vertical_enabled("dating", False) is False     # explicit narrows
    assert vertical_enabled("dating", True) is True
    assert vertical_enabled("bogus") is False             # fail closed
    # Template mapping agrees with the edge gate map.
    assert vertical_for_template("/v1/dating/preferences") == "dating"
    assert vertical_for_template("/v1/wallets/:walletId/entries") == "payments"
    assert vertical_for_template("/v1/presence/bond") == "trust"
    assert vertical_for_template("/v1/groups/:tableId/stake") == "groups"
    assert vertical_for_template("/v1/venues/:venueId/rooms") == "venues"
    assert vertical_for_template("/v1/serendipity/windows") == "serendipity"
    assert vertical_for_template("/v1/presence") is None
    assert vertical_for_template("/v1/account/verticals") is None
    assert vertical_for_template("/v1/moderation/wallets/reconciliation") is None
    assert vertical_for_template("/v1/venues/:venueId/dashboard") is None
    assert vertical_for_template("/v1/walletsmith") is None


# --------------------------------------------------------------- openapi ---

def test_openapi_documents_get_and_put_only():
    doc = yaml.safe_load(OPENAPI)
    node = doc["paths"]["/v1/account/verticals"]
    assert set(node.keys()) == {"get", "put"}
    patch_props = node["put"]["requestBody"]["content"]["application/json"][
        "schema"]["properties"]["patch"]["properties"]
    assert set(patch_props.keys()) == set(VERTICALS)
    enums = node["get"]["responses"]["200"]["content"]["application/json"][
        "schema"]["properties"]["verticals"]["items"]["properties"][
        "vertical"]["enum"]
    assert enums == list(VERTICALS)
    # No new POST anywhere: the three pinned POST windows keep their counts.
    bond = OPENAPI.index("/v1/presence/bond:")
    dating = OPENAPI.index("/v1/dating/preferences:")
    esc = OPENAPI.index("/v1/moderation/escrow-resolutions:")
    comps = OPENAPI.index("components:")
    assert len(re.findall(r"\n    post:", OPENAPI[bond:dating])) == 18
    assert len(re.findall(r"\n    post:", OPENAPI[dating:esc])) == 10
    # Batch 60 re-bound: the 9 swap POSTs land after escrow-resolutions and
    # before components:, so this window grows 2 -> 11 (batch 60 pins the swap
    # POSTs separately). Batch 61 re-bounds again: the 5 service POSTs land
    # in the same window, 11 -> 16 (batch 61 pins them separately).
    assert len(re.findall(r"\n    post:", OPENAPI[esc:comps])) == 16


# ---------------------------------------------------------------- deploy ---

def test_migration_rides_both_initdb_mounts():
    assert ("/docker-entrypoint-initdb.d/36_vertical_flags.sql:ro"
            in COMPOSE)
    assert "../db/migrations/0034_vertical_flags.sql" in COMPOSE
    assert "--from-file=36_vertical_flags.sql=db/migrations/0034_vertical_flags.sql" \
        in K8S_README
