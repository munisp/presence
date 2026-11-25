"""Batch 39 invariants — discovery surfaces (FR-76, FR-77, FR-78, FR-79, FR-80, FR-87).

The discovery surfaces now exist as client presentation contracts:

  - surfaceIntegrity.ts (FR-87 + FR-77): ONE prohibition registry —
    engagement mechanics (infinite/auto-loading scroll, typing
    indicators, read receipts, streaks, daily-login rewards, like/view
    counts, photo-at-match) and proximity elements (map, direction,
    distance, radius, heat-map, proximity arrangement) — that every
    surface descriptor is audited against.
  - matchSurface.ts (FR-76): the match surface is built only from the
    TR-35 MatchDiagram — convergence of two interest paths on the
    shared nodes, a commonality headline, a fixed {headline, paths}
    field set no identity can occupy.
  - presenceHalo.ts (FR-78): density as an undirected field — a 0..1
    intensity over the aggregate count and a qualitative level that
    cannot carry digits; invalid counts fail closed to calm.
  - offerWindow.ts (FR-79): expiry as a closing perimeter fraction;
    the numeric form exists only behind an explicit preference, and
    the default render physically never computes seconds.
  - discoverySkeleton.ts (FR-80): one pinned skeleton for all three
    modes (only the result region differs), a pinned one-sentence
    explanation shown once per user, and mode changes deferred while
    a conversation is open.

Every pin here fails loudly if a future change relaxes one of those
guarantees — module purity and import lists, the pinned registries and
constants, the fail-closed behaviours, the once-only/never-interrupt
rules, the TR-30 allowlist growth, and the reflection of the batch in
the client README, the App shell, the UX doc and the traceability
matrix.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT_SRC = ROOT / "client" / "src" / "presence"
CLIENT_TEST = ROOT / "client" / "test"

SURFACE_INTEGRITY_TS = (CLIENT_SRC / "surfaceIntegrity.ts").read_text(encoding="utf-8")
MATCH_SURFACE_TS = (CLIENT_SRC / "matchSurface.ts").read_text(encoding="utf-8")
PRESENCE_HALO_TS = (CLIENT_SRC / "presenceHalo.ts").read_text(encoding="utf-8")
OFFER_WINDOW_TS = (CLIENT_SRC / "offerWindow.ts").read_text(encoding="utf-8")
DISCOVERY_SKELETON_TS = (CLIENT_SRC / "discoverySkeleton.ts").read_text(encoding="utf-8")
LOCAL_STATE_TS = (CLIENT_SRC / "localState.ts").read_text(encoding="utf-8")
EDGE_LIFECYCLE_TS = (ROOT / "services" / "edge" / "src" / "lifecycle.ts").read_text(encoding="utf-8")
SURFACE_INTEGRITY_TEST = (CLIENT_TEST / "surfaceIntegrity.test.ts").read_text(encoding="utf-8")
MATCH_SURFACE_TEST = (CLIENT_TEST / "matchSurface.test.ts").read_text(encoding="utf-8")
PRESENCE_HALO_TEST = (CLIENT_TEST / "presenceHalo.test.ts").read_text(encoding="utf-8")
OFFER_WINDOW_TEST = (CLIENT_TEST / "offerWindow.test.ts").read_text(encoding="utf-8")
DISCOVERY_SKELETON_TEST = (CLIENT_TEST / "discoverySkeleton.test.ts").read_text(encoding="utf-8")
LOCAL_STATE_TEST = (CLIENT_TEST / "localState.test.ts").read_text(encoding="utf-8")
README = (ROOT / "client" / "README.md").read_text(encoding="utf-8")
APP_TSX = (ROOT / "client" / "App.tsx").read_text(encoding="utf-8")
UX_DOC = (ROOT / "docs" / "ux" / "discovery-surfaces.md").read_text(encoding="utf-8")
TRACEABILITY = (ROOT / "docs" / "traceability.md").read_text(encoding="utf-8")


def _imports(source: str) -> list[str]:
    return re.findall(r'from "(\./[^"]+)"', source)


# --------------------------------------------------------------- purity ---

def test_surface_integrity_is_import_free() -> None:
    assert _imports(SURFACE_INTEGRITY_TS) == []
    assert "require(" not in SURFACE_INTEGRITY_TS
    assert "fetch(" not in SURFACE_INTEGRITY_TS


def test_match_surface_imports_only_the_diagram_and_registry() -> None:
    assert sorted(_imports(MATCH_SURFACE_TS)) == [
        "./matchDiagram.js",
        "./surfaceIntegrity.js",
    ]


def test_presence_halo_imports_only_the_registry() -> None:
    assert _imports(PRESENCE_HALO_TS) == ["./surfaceIntegrity.js"]


def test_offer_window_is_import_free() -> None:
    assert _imports(OFFER_WINDOW_TS) == []


def test_discovery_skeleton_imports_are_pinned() -> None:
    assert sorted(_imports(DISCOVERY_SKELETON_TS)) == [
        "./localState.js",
        "./surfaceIntegrity.js",
    ]


# ----------------------------------------------------- FR-87 / FR-77 registry ---

def test_engagement_prohibition_registry_is_pinned() -> None:
    assert (
        "PROHIBITED_ENGAGEMENT_PATTERNS = [\n"
        '  "infinite-scroll",\n'
        '  "auto-loading-scroll",\n'
        '  "typing-indicator",\n'
        '  "read-receipt",\n'
        '  "streak",\n'
        '  "daily-login-reward",\n'
        '  "like-count",\n'
        '  "view-count",\n'
        '  "photo-at-match",\n'
        "] as const"
    ) in SURFACE_INTEGRITY_TS


def test_proximity_prohibition_registry_is_pinned() -> None:
    assert (
        "PROHIBITED_PROXIMITY_ELEMENTS = [\n"
        '  "map",\n'
        '  "direction-indicator",\n'
        '  "distance-value",\n'
        '  "radius",\n'
        '  "heat-map",\n'
        '  "proximity-arrangement",\n'
        "] as const"
    ) in SURFACE_INTEGRITY_TS


def test_registry_guard_scans_affordances_and_field_keys() -> None:
    assert "descriptor.affordances" in SURFACE_INTEGRITY_TS
    assert "Object.keys(descriptor.fields)" in SURFACE_INTEGRITY_TS
    assert "honoursSurfaceProhibitions" in SURFACE_INTEGRITY_TS
    # The guard is exercised against every banned entry in the unit tests.
    assert "every prohibited affordance is caught" in SURFACE_INTEGRITY_TEST
    assert "every prohibited field key is caught" in SURFACE_INTEGRITY_TEST


# ----------------------------------------------------------------- FR-76 ---

def test_match_surface_built_only_from_the_diagram() -> None:
    # The single data input is the TR-35 diagram — rendered entirely from
    # the reason payload, two steps removed from the wire.
    assert "buildMatchSurface(diagram: MatchDiagram): MatchSurface" in MATCH_SURFACE_TS
    assert 'from "./matchDiagram.js"' in MATCH_SURFACE_TS


def test_match_surface_identity_ban_is_pinned() -> None:
    # SRS Addendum 001 (AMD-AVT-02, batch 48): "avatar" left the forbidden
    # list — a curated registry symbol is not identity and MAY serve as the
    # pre-OPEN recognition anchor (delivered via buildMatchScreen's
    # avatarLabel, never inside this descriptor). The remaining keys stand.
    assert (
        "FORBIDDEN_MATCH_IDENTITY_FIELDS = [\n"
        '  "photo",\n'
        '  "photoUrl",\n'
        '  "displayName",\n'
        '  "handle",\n'
        '  "fullName",\n'
        "] as const"
    ) in MATCH_SURFACE_TS
    assert 'MATCH_SURFACE_AFFORDANCES = ["hold-to-wave"] as const' in MATCH_SURFACE_TS
    assert "showsCommonalityNotIdentity" in MATCH_SURFACE_TS
    assert "matchSurfaceViolations" in MATCH_SURFACE_TS


def test_match_surface_headline_names_commonality() -> None:
    assert "} — what you have in common.`" in MATCH_SURFACE_TS
    assert '"Your paths cross here."' in MATCH_SURFACE_TS
    # The descriptor field set is fixed at {headline, paths}.
    assert "fields: { headline: surface.headline, paths: surface.paths }" in MATCH_SURFACE_TS
    assert (
        'Object.keys(descriptor.fields).sort(), [\n    "headline",\n    "paths",\n  ]'
        in MATCH_SURFACE_TEST
    )


# ----------------------------------------------------------------- FR-78 ---

def test_presence_halo_contract_is_pinned() -> None:
    assert 'HALO_LEVELS = ["calm", "stirring", "lively", "buzzing"] as const' in PRESENCE_HALO_TS
    assert "HALO_FULL_SCALE = 20" in PRESENCE_HALO_TS
    # Intensity rises with the aggregate count and clamps at 1.
    assert "Math.min(1, sane / HALO_FULL_SCALE)" in PRESENCE_HALO_TS
    # The level label cannot carry the raw count.
    assert "/\\d/.test(halo.level)" in PRESENCE_HALO_TS
    # Fail closed: invalid counts render the calmest field.
    assert "Number.isFinite(compatibleCount) && compatibleCount > 0" in PRESENCE_HALO_TS
    assert "haloHonoursFr77" in PRESENCE_HALO_TS


def test_presence_halo_tests_pin_monotonicity_and_fail_closed() -> None:
    assert "intensity rises monotonically with the aggregate count" in PRESENCE_HALO_TEST
    assert "invalid counts fail closed to the calmest field" in PRESENCE_HALO_TEST
    assert "rejects a level label carrying digits" in PRESENCE_HALO_TEST
    assert "rejects a positional affordance (FR-77)" in PRESENCE_HALO_TEST


# ----------------------------------------------------------------- FR-79 ---

def test_offer_window_mirrors_the_server_ttl() -> None:
    assert "OFFER_WINDOW_MS = 30 * 60 * 1000" in OFFER_WINDOW_TS
    assert re.search(r"OFFER_TTL_MS = 30 \* 60 \* 1000;\s+// FR-33", EDGE_LIFECYCLE_TS)


def test_offer_window_defaults_to_the_perimeter() -> None:
    assert 'DEFAULT_EXPIRY_PRESENTATION = "perimeter" as const' in OFFER_WINDOW_TS
    # Numeric exists only behind an explicit preference.
    assert 'preference?.numericCountdown === true ? "numeric" : "perimeter"' in OFFER_WINDOW_TS
    # The default render physically never computes seconds.
    assert 'presentation === "numeric"' in OFFER_WINDOW_TS
    assert ": null," in OFFER_WINDOW_TS
    assert "secondsRemaining: number | null" in OFFER_WINDOW_TS
    # The fraction is clamped and fails closed on an invalid window.
    assert "Math.min(1, Math.max(0, remaining / windowMs))" in OFFER_WINDOW_TS
    assert "if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;" in OFFER_WINDOW_TS


def test_offer_window_tests_pin_the_default_and_opt_in() -> None:
    assert "the default presentation is the perimeter (FR-79)" in OFFER_WINDOW_TEST
    assert "numeric appears only behind an explicit preference" in OFFER_WINDOW_TEST
    assert "secondsRemaining is null" in OFFER_WINDOW_TEST
    assert "monotonic non-increasing in time" in OFFER_WINDOW_TEST


# ----------------------------------------------------------------- FR-80 ---

def test_discovery_skeleton_contract_is_pinned() -> None:
    assert 'DISCOVERY_MODES = ["pairs", "rooms", "tables"] as const' in DISCOVERY_SKELETON_TS
    assert (
        "SKELETON_REGIONS = [\n"
        '  "header",\n'
        '  "modeSelector",\n'
        '  "resultRegion",\n'
        '  "statusTray",\n'
        "] as const"
    ) in DISCOVERY_SKELETON_TS
    # Only the result content differs between modes.
    assert "return { regions: SKELETON_REGIONS, resultContent: mode };" in DISCOVERY_SKELETON_TS
    assert 'a.regions.join("|") === b.regions.join("|")' in DISCOVERY_SKELETON_TS


def test_mode_explanations_are_one_sentence_each() -> None:
    block = re.search(
        r"MODE_EXPLANATIONS: Record<DiscoveryMode, string> = \{(.*?)\};",
        DISCOVERY_SKELETON_TS,
        re.DOTALL,
    )
    assert block is not None
    sentences = re.findall(r'"(.*?)"', block.group(1))
    assert len(sentences) == 3
    for sentence in sentences:
        terminals = re.findall(r"[.!?]+", sentence)
        assert len(terminals) == 1, sentence
        assert sentence.endswith(terminals[0]), sentence


def test_explanations_show_once_and_never_interrupt() -> None:
    # Once per user: the seen-set persists under an allowlisted key, and
    # the parse fails toward explaining again.
    assert 'SEEN_EXPLANATIONS_KEY: LocalStateKey =\n  "presence.ui.seenExplanations"' in DISCOVERY_SKELETON_TS
    assert "return !seen.includes(mode);" in DISCOVERY_SKELETON_TS
    assert "catch {\n    return [];\n  }" in DISCOVERY_SKELETON_TS
    # Never interrupt an open conversation.
    assert 'return { action: "defer", reason: "conversation-open" };' in DISCOVERY_SKELETON_TS
    # No load-more affordance anywhere on the skeleton.
    assert 'SKELETON_AFFORDANCES = ["mode-switch", "refresh"] as const' in DISCOVERY_SKELETON_TS
    assert "skeletonHonoursFr87" in DISCOVERY_SKELETON_TS


# ----------------------------------------------------------------- TR-30 ---

def test_local_state_allowlist_grew_to_seven_keys() -> None:
    assert '"presence.ui.seenExplanations",' in LOCAL_STATE_TS
    assert (
        "// Mode explanations already shown (FR-80) — one sentence, once per user."
        in LOCAL_STATE_TS
    )
    # Batch 40 added presence.ambient.prefs (FR-86): 6 → 7 keys.
    assert "assert.equal(LOCAL_STATE_ALLOWLIST.length, 7);" in LOCAL_STATE_TEST
    assert 'LOCAL_STATE_ALLOWLIST.includes("presence.ui.seenExplanations")' in LOCAL_STATE_TEST


# ------------------------------------------------------------ reflection ---

def test_client_readme_reflects_the_surface_modules() -> None:
    for module, requirement in (
        ("surfaceIntegrity.ts", "FR-87"),
        ("matchSurface.ts", "FR-76"),
        ("presenceHalo.ts", "FR-78"),
        ("offerWindow.ts", "FR-79"),
        ("discoverySkeleton.ts", "FR-80"),
    ):
        assert module in README, module
        row = next(line for line in README.splitlines() if module in line)
        assert requirement in row, row


def test_app_shell_reflects_the_surface_contracts() -> None:
    for import_name in (
        "showsCommonalityNotIdentity",
        "haloHonoursFr77",
        "DEFAULT_EXPIRY_PRESENTATION",
        "skeletonSharedAcrossModes",
        "honoursSurfaceProhibitions",
    ):
        assert import_name in APP_TSX, import_name


def test_ux_doc_maps_components_to_requirements() -> None:
    for component in (
        "MatchDiagram",
        "PresenceHalo",
        "OfferWindow",
        "discovery skeleton",
        "surfaceIntegrity",
    ):
        assert component in UX_DOC, component
    for requirement in ("FR-76", "FR-77", "FR-78", "FR-79", "FR-80", "FR-87"):
        assert requirement in UX_DOC, requirement
    # The §4.13.10 acceptance sentence anchors the doc.
    assert (
        "it shows you what you have in common with someone nearby before you "
        "know who they are" in UX_DOC
    )


# ----------------------------------------------------------- traceability ---

def test_traceability_reclassifies_the_batch() -> None:
    for requirement in ("FR-76", "FR-78", "FR-79", "FR-80", "FR-87"):
        match = re.search(rf"\| {requirement} \| ([^|]+) \|", TRACEABILITY)
        assert match is not None, requirement
        assert match.group(1).strip() == "implemented", requirement
    # FR-77 stays implemented; its note now covers the client half too.
    fr77 = re.search(r"\| FR-77 \| ([^|]+) \| ([^|]+) \| ([^|]+) \|", TRACEABILITY)
    assert fr77 is not None
    assert fr77.group(1).strip() == "implemented"
    assert "presenceHalo.ts" in fr77.group(3)


def test_traceability_counts_after_batch_43() -> None:
    # Batch 40 reclassified six interaction-surface requirements
    # (FR-81/82/83/84/86/SEC-35) client → implemented: 213 → 219.
    # Batch 41 closed the four journey partials (FR-03/08/41/48)
    # partial → implemented: 219 → 223, 7 → 3.
    # Batch 42: NFR-36 + TECH-16 client → implemented,
    # NFR-04/05/29/30/35 client → partial: 223 → 225, 3 → 8, 14 → 7.
    # Batch 43: FR-70 + NFR-25/26/37 client → implemented: 225 → 229, 8 → 8, 7 → 3.
    # Batch 44: NFR-27 + NFR-28 client → implemented: 229 → 231, 8 → 8, 3 → 1.
    # Batch 45: TECH-08 client → implemented: 231 → 232, 8 → 8, 1 → 0.
    # Batch 46: BR-07 + FR-89 client halves → implemented: 232 → 234, 8 → 6, 0 → 0.
    assert "| implemented | 234 |" in TRACEABILITY
    assert "| partial | 6 |" in TRACEABILITY
    assert "| client | 0 |" in TRACEABILITY
