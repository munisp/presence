"""Batch 48 invariants — the identity-assurance layer (SRS Addendum 001):
universal KYC gating of discovery (AMD-KYC-01..05), the curated avatar
identity layer (AMD-AVT-01..04), and the payments-path gate revision
(AMD-PAY-01/02, contracts land in batch 49).

The original 306-requirement ledger is untouched: amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md, so the traceability counts
stay 234/6/0. One shipped pin moved under the amendment discipline:
"avatar" left FORBIDDEN_MATCH_IDENTITY_FIELDS (AMD-AVT-02) and the
batch-39 pin was updated in place with the amendment recorded.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "client"
EDGE = ROOT / "services/edge"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0024_kyc_avatars.sql").read_text()
EDGE_IDENTITY = (EDGE / "src/identity.ts").read_text()
EDGE_ROUTES = (EDGE / "src/routes/identity.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
EDGE_TEST = (EDGE / "test/identity.test.ts").read_text()
MATCH_STORE = (ROOT / "services/match/src/store.ts").read_text()
CLIENT_IA = (CLIENT / "src/presence/identityAssurance.ts").read_text()
CLIENT_TEST = (CLIENT / "test/identityAssurance.test.ts").read_text()
MATCH_SURFACE = (CLIENT / "src/presence/matchSurface.ts").read_text()
SCREENS = (CLIENT / "src/presence/ui/screens.ts").read_text()
COPY = (CLIENT / "src/presence/copyRegistry.ts").read_text()
APP_TSX = (CLIENT / "App.tsx").read_text()
README = (CLIENT / "README.md").read_text()
UX_DOC = (ROOT / "docs/ux/identity-assurance.md").read_text()
TRACEABILITY = (ROOT / "docs/traceability.md").read_text()
B39 = (ROOT / "tests/test_batch39.py").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
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


def test_batch48_files_exist():
    for path in (
        "docs/spec/srs-addendum-001.md",
        "db/migrations/0024_kyc_avatars.sql",
        "services/edge/src/identity.ts",
        "services/edge/src/routes/identity.ts",
        "services/edge/test/identity.test.ts",
        "client/src/presence/identityAssurance.ts",
        "client/test/identityAssurance.test.ts",
        "docs/ux/identity-assurance.md",
    ):
        assert (ROOT / path).exists(), path


# --------------------------------------------------------------- addendum


def test_addendum_records_the_three_amendments():
    for amd in (
        "AMD-KYC-01",
        "AMD-KYC-02",
        "AMD-KYC-03",
        "AMD-KYC-04",
        "AMD-KYC-05",
        "AMD-AVT-01",
        "AMD-AVT-02",
        "AMD-AVT-03",
        "AMD-AVT-04",
        "AMD-PAY-01",
        "AMD-PAY-02",
    ):
        assert amd in ADDENDUM, amd
    # The owner's instruction is recorded as the amendment's authority.
    assert "Every user of the platform is KYC and vetted" in ADDENDUM
    # The 306-ledger is explicitly untouched; amendments carry AMD- ids.
    assert "306-requirement ledger is unchanged" in ADDENDUM
    # Safety/privacy-first: the gate fails closed, FR-30 is not relaxed,
    # and the FR-87 photo prohibition is unchanged.
    assert "gate fails closed" in ADDENDUM
    assert "FR-30 is **not** relaxed" in ADDENDUM
    assert "FR-87's prohibition is unchanged" in ADDENDUM
    # AMD-PAY-02: the TECH-23 deployment gate stands.
    assert "MUST NOT be deployed until the payments compliance programme is approved" in ADDENDUM


# --------------------------------------------------------------- migration


def test_migration_kyc_columns_minimise_data():
    # AMD-KYC-01: the four-state column, defaulting to pending (fail closed).
    assert "ADD COLUMN kyc_state text NOT NULL DEFAULT 'pending'" in MIGRATION
    assert (
        "CHECK (kyc_state IN ('pending', 'verified', 'rejected', 'suspended'))"
        in MIGRATION
    )
    # AMD-KYC-02: exactly an opaque reference, a timestamp, a reviewing actor.
    assert "ADD COLUMN kyc_verified_at timestamptz" in MIGRATION
    assert "ADD COLUMN kyc_provider_ref text" in MIGRATION
    assert "ADD COLUMN kyc_reviewed_by text" in MIGRATION
    # Never documents or legal identity.
    for banned in ("document", "legal_name", "date_of_birth", "passport"):
        assert f"ADD COLUMN {banned}" not in MIGRATION


def test_record_kyc_decision_enforces_and_audits():
    # AMD-KYC-03: legality in the database, not in endpoint logic.
    assert "CREATE OR REPLACE FUNCTION record_kyc_decision(" in MIGRATION
    assert "LANGUAGE plpgsql SECURITY DEFINER SET search_path = public" in MIGRATION
    assert "FOR UPDATE" in MIGRATION
    # Only moderation or the provider-callback GUC may move a state.
    assert "app_moderator() OR current_setting('app.kyc_callback', true) = 'on'" in MIGRATION
    # The legal-transition table (cross-pinned against the edge mirror below).
    assert "(v_state = 'pending'   AND p_decision IN ('verified', 'rejected')) OR" in MIGRATION
    assert "(v_state = 'verified'  AND p_decision = 'suspended') OR" in MIGRATION
    assert "(v_state = 'suspended' AND p_decision = 'verified') OR" in MIGRATION
    assert "(v_state = 'rejected'  AND p_decision = 'pending')" in MIGRATION
    assert "RETURN 'illegal_transition'" in MIGRATION
    assert "RETURN 'forbidden'" in MIGRATION
    assert "RETURN 'unknown_user'" in MIGRATION
    # AMD-KYC-05: every decision is audited with from/to and the actor.
    assert "'kyc.decision.' || p_decision" in MIGRATION
    assert "admin_audit_log(" in MIGRATION


def test_migration_avatar_columns_and_pair_avatar_definer():
    # AMD-AVT-01: a shaped key on the display identity, never free text.
    assert "ADD COLUMN avatar_key text" in MIGRATION
    assert "CHECK (avatar_key IS NULL OR avatar_key ~ '^[a-z][a-z0-9-]{2,39}$')" in MIGRATION
    assert "ADD COLUMN avatar_set_at timestamptz" in MIGRATION
    # AMD-KYC-04/AMD-AVT-02: the ONLY pre-OPEN identity read returns the
    # avatar key alone, and only for an active pair or the caller.
    assert "CREATE OR REPLACE FUNCTION pair_avatar(p_viewer uuid, p_counterpart uuid)" in MIGRATION
    assert "m.state IN ('NUDGED', 'EXPRESSED', 'MUTUAL', 'OPEN')" in MIGRATION
    assert "p_viewer IN (m.user_lo, m.user_hi)" in MIGRATION
    assert "p_counterpart IN (m.user_lo, m.user_hi)" in MIGRATION


def test_discovery_gate_views():
    # AMD-KYC-01: discovery = attested AND kyc-verified; attestation itself
    # is a distinct property and its view is unchanged.
    assert (
        "CREATE VIEW kyc_verified_accounts AS\n"
        "    SELECT user_id FROM users WHERE kyc_state = 'verified';"
    ) in MIGRATION
    assert (
        "CREATE VIEW discovery_eligible AS\n"
        "    SELECT a.user_id\n"
        "      FROM attested_accounts a\n"
        "      JOIN kyc_verified_accounts k USING (user_id);"
    ) in MIGRATION


def test_match_service_reads_the_gated_view():
    # The discovery candidate gate moved from attested_accounts to
    # discovery_eligible — fail closed on both properties.
    assert (
        "AND EXISTS (SELECT 1 FROM discovery_eligible\n"
        "                      WHERE discovery_eligible.user_id = profile_interests.user_id)"
        in MATCH_STORE
    )
    assert (
        "SELECT 1 FROM attested_accounts\n"
        "                      WHERE attested_accounts.user_id = profile_interests.user_id"
        not in MATCH_STORE
    )


# ------------------------------------------------------- cross-layer pins


def test_avatar_registry_is_byte_identical_edge_and_client():
    """AMD-AVT-01: the two copies of the registry cannot drift."""
    edge_block = _block(EDGE_IDENTITY, "export const AVATAR_REGISTRY", "];")
    client_block = _block(CLIENT_IA, "export const AVATAR_REGISTRY", "];")
    assert edge_block == client_block


def test_kyc_transition_table_matches_the_definer():
    """AMD-KYC-03: edge mirror and database definer agree on the five moves."""
    ts_block = _block(EDGE_IDENTITY, "export const KYC_TRANSITIONS", "];")
    ts_pairs = set(re.findall(r'\["(\w+)", "(\w+)"\]', ts_block))
    assert len(ts_pairs) == 5
    sql_pairs: set[tuple[str, str]] = set()
    for state, single, multi in re.findall(
        r"\(v_state = '(\w+)'\s+AND p_decision (?:= '(\w+)'|IN \(([^)]*)\))\)",
        MIGRATION,
    ):
        if single:
            sql_pairs.add((state, single))
        else:
            for target in re.findall(r"'(\w+)'", multi):
                sql_pairs.add((state, target))
    assert ts_pairs == sql_pairs


def test_kyc_states_agree_across_layers():
    states_line = 'KYC_STATES = ["pending", "verified", "rejected", "suspended"] as const'
    assert states_line in EDGE_IDENTITY
    assert states_line in CLIENT_IA
    assert "('pending', 'verified', 'rejected', 'suspended')" in MIGRATION


# ------------------------------------------------------------ edge service


def test_edge_identity_module_surface():
    for name in (
        "KYC_STATES",
        "KYC_TRANSITIONS",
        "isKycState",
        "isLegalKycTransition",
        "AVATAR_KEY_PATTERN",
        "AVATAR_REGISTRY",
        "isKnownAvatarKey",
        "AVATAR_CHANGE_COOLDOWN_MS",
        "parseAvatarChoice",
        "parseKycDecision",
    ):
        assert f"export " in EDGE_IDENTITY and name in EDGE_IDENTITY, name
    assert "AVATAR_CHANGE_COOLDOWN_MS = 86_400_000" in EDGE_IDENTITY


def test_edge_routes_are_the_three_amendment_wires():
    assert 'app.get("/v1/identity/status"' in EDGE_ROUTES
    assert 'app.put(\n    "/v1/profile/avatar"' in EDGE_ROUTES
    assert 'app.post(\n    "/v1/moderation/kyc/:userId"' in EDGE_ROUTES
    # Moderation decisions ride the moderator wire; the definer decides.
    assert "preHandler: requireModerator" in EDGE_ROUTES
    assert "SELECT record_kyc_decision($1, $2, $3, NULL) AS outcome" in EDGE_ROUTES
    # AMD-AVT-03 on the wire: open-conversation lock and the 24 h cooldown.
    assert "WHERE state = 'OPEN' AND $1 IN (user_lo, user_hi)" in EDGE_ROUTES
    assert "AVATAR_CHANGE_COOLDOWN_MS" in EDGE_ROUTES
    # TR-23 strict bodies.
    assert "additionalProperties: false" in EDGE_ROUTES


def test_edge_app_registers_the_routes():
    assert 'import { registerIdentityRoutes } from "./routes/identity.js";' in EDGE_APP
    assert "registerIdentityRoutes(authed, ctx);" in EDGE_APP


def test_edge_tests_cover_the_validators():
    assert "isLegalKycTransition" in EDGE_TEST
    assert "parseAvatarChoice" in EDGE_TEST
    assert "parseKycDecision" in EDGE_TEST
    assert "86_400_000" in EDGE_TEST


# ------------------------------------------------------------------ client


def test_client_module_imports_only_the_accessibility_contract():
    assert _imports(CLIENT_IA) == ["./accessibility.js"]


def test_client_module_surface():
    for name in (
        "KYC_STATES",
        "KYC_TRANSITIONS",
        "isLegalKycTransition",
        "canEnterDiscovery",
        "AVATAR_REGISTRY",
        "resolveAvatar",
        "AVATAR_CHANGE_COOLDOWN_MS",
        "planAvatarChange",
        "buildRecognitionAnchor",
        "identityAssuranceHonoursAmendment",
    ):
        assert f"export " in CLIENT_IA and name in CLIENT_IA, name
    # The five pinned refusal reasons.
    for reason in (
        '"invalid-input"',
        '"unknown-avatar"',
        '"same-avatar"',
        '"open-conversation"',
        '"cooldown"',
    ):
        assert reason in CLIENT_IA, reason


def test_recognition_anchor_has_no_photo_by_construction():
    # AMD-AVT-02 + FR-87: the anchor type is {avatar, displayName} — there
    # is no photo field to populate, and the name is null until OPEN.
    anchor_block = _block(CLIENT_IA, "export interface RecognitionAnchor", "}")
    assert "avatar: AvatarEntry;" in anchor_block
    assert "displayName: string | null;" in anchor_block
    assert "photo" not in anchor_block
    assert 'revealState === "pre-open"' in CLIENT_IA
    assert 'revealState === "open"' in CLIENT_IA
    assert "return { avatar, displayName: null };" in CLIENT_IA


def test_client_guard_is_non_vacuous():
    guard = _block(CLIENT_IA, "export function identityAssuranceHonoursAmendment", "\n}")
    assert "keys.size < 12" in guard
    assert "KYC_TRANSITIONS.length !== 5" in guard
    assert 'resolveAvatar("ember-fox") !== null' in guard
    assert 'isLegalKycTransition("verified", "pending") === false' in guard
    assert 'canEnterDiscovery({ attested: true, kycState: "verified" }) === true' in guard
    assert 'canEnterDiscovery({ attested: true, kycState: "pending" }) === false' in guard


def test_match_surface_avatar_unban_is_the_amended_list():
    # AMD-AVT-02: "avatar" left the identity ban; the other five stand.
    assert (
        "FORBIDDEN_MATCH_IDENTITY_FIELDS = [\n"
        '  "photo",\n'
        '  "photoUrl",\n'
        '  "displayName",\n'
        '  "handle",\n'
        '  "fullName",\n'
        "] as const"
    ) in MATCH_SURFACE
    assert '  "avatar",\n' not in _block(
        MATCH_SURFACE, "FORBIDDEN_MATCH_IDENTITY_FIELDS", "] as const"
    )
    assert "AMD-AVT-02" in MATCH_SURFACE


def test_match_screen_carries_the_optional_anchor():
    # The anchor is a header text node from the pair_avatar contract — the
    # MatchSurface descriptor is still built from the diagram alone.
    assert "buildMatchScreen(surface: MatchSurface, avatarLabel?: string)" in SCREENS
    assert 'literalText("match-avatar-anchor", avatarLabel, "subtitle")' in SCREENS
    assert "AMD-AVT-02" in SCREENS


def test_copy_registry_gained_the_identity_keys():
    for key in (
        '"ui.identity.status-title"',
        '"ui.kyc.status.pending"',
        '"ui.kyc.status.verified"',
        '"ui.kyc.status.rejected"',
        '"ui.kyc.status.suspended"',
        '"ui.avatar.choose"',
        '"ui.avatar.cooldown"',
        '"ui.avatar.locked"',
    ):
        assert key in COPY, key


def test_app_shell_asserts_the_amendment():
    assert (
        'import { identityAssuranceHonoursAmendment } from "./src/presence/identityAssurance.js";'
        in APP_TSX
    )
    assert "identityAssuranceHonoursAmendment()," in APP_TSX


def test_client_tests_cover_the_contract():
    for anchor in (
        "the KYC states and the legal-transition table are pinned",
        "discovery is attested AND kyc-verified, fail closed",
        "the registry is twelve unique, well-formed, palette-covered symbols",
        "an avatar change is planned with exactly one refusal reason",
        "the recognition anchor is the symbol pre-OPEN, name only at OPEN",
        "the master guard holds and is not vacuous",
    ):
        assert anchor in CLIENT_TEST, anchor


# ---------------------------------------------------------------- amended pin


def test_batch39_pin_updated_under_the_amendment():
    # The older pin was edited in place with the amendment recorded
    # (precedent: b37 edited the b34 allowlist pin).
    assert "AMD-AVT-02, batch 48" in B39
    assert '  "avatar",\n' not in _block(
        B39, "FORBIDDEN_MATCH_IDENTITY_FIELDS = [", "] as const"
    )


# --------------------------------------------------------------------- docs


def test_readme_row_present():
    assert "`src/presence/identityAssurance.ts`" in README
    assert "AMD-KYC" in README and "AMD-AVT" in README
    assert "byte-identical to the edge copy" in README


def test_ux_doc_declares_the_map_and_the_gaps():
    for anchor in (
        "record_kyc_decision",
        "discovery_eligible",
        "pair_avatar",
        "buildRecognitionAnchor",
        "GET /v1/identity/status",
        "KYC vendor integration",
        "User-uploaded or generated avatars",
        "Peer-to-peer payments",
        "batch 49",
    ):
        assert anchor in UX_DOC, anchor


# ----------------------------------------------------------- traceability


def test_migration_mounted_and_routes_documented():
    # The b23 regression guard: every migration rides the initdb ConfigMap.
    assert "=db/migrations/0024_kyc_avatars.sql" in K8S_README
    # TECH-14: the three amendment wires are in the OpenAPI contract.
    assert "/v1/identity/status:" in OPENAPI
    assert "/v1/profile/avatar:" in OPENAPI
    assert "/v1/moderation/kyc/{userId}:" in OPENAPI
    assert "AMD-KYC-03/05" in OPENAPI and "AMD-AVT-01/03" in OPENAPI


def test_traceability_counts_unchanged():
    # Amendments carry AMD- identifiers in the addendum ledger — the
    # original 306-requirement counts do not move.
    # Batch 70 closed TR-44 (the final phase-gated requirement): 234 → 235, phase-gated 1 → 0.
    assert "| implemented | 235 |" in TRACEABILITY
    assert "| partial | 6 |" in TRACEABILITY
    assert "| gap-p0 | 0 |" in TRACEABILITY
    assert "| client | 0 |" in TRACEABILITY
