"""Batch 43 invariants — identity-reveal badge and accessibility contracts.

Two framework-free modules close the client halves of FR-70 and the
accessibility triplet:

  - verificationBadge.ts (FR-70): the identity-reveal registry is
    exactly the three surfaces the SRS names — the offer, the table
    roster and the booked slot — and account settings is NOT one; a
    reveal is built from the FR-51 attestation state alone, the badge
    label is pinned so a surface cannot forge a friendlier status, and
    unregistered surfaces / blank names / garbage states fail closed.
  - accessibility.ts (NFR-25, NFR-26, NFR-37): WCAG 2.2 AA as code —
    relative-luminance contrast audited over the pinned shell palette
    (4.5:1 normal, 3:1 large and non-text; the audit caught the note
    colour at 3.50:1 and it moved to #74879B), dynamic type pinned to
    the 200 % resize floor, reduced motion a pinned instant fallback
    (unreadable preference treated as reduce), per-control label /
    role / 44 pt target / unique focus-order audit, and the primary
    action pinned to the lower 40 percent of the display.

Both are code properties the client can guarantee outright, so all
four requirements reclassify client → implemented; on-device
assistive-technology validation is documented as beyond code.

Every pin here fails loudly if a future change relaxes one of those
guarantees — module purity, the pinned registries and constants, the
fail-closed behaviours, the palette re-computed in Python against the
WCAG formula, the App.tsx colour fix, and the reflection of the batch
in the client README, the App shell, the UX doc and the traceability
matrix.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT_SRC = ROOT / "client" / "src" / "presence"
CLIENT_TEST = ROOT / "client" / "test"

VERIFICATION_BADGE_TS = (CLIENT_SRC / "verificationBadge.ts").read_text(encoding="utf-8")
ACCESSIBILITY_TS = (CLIENT_SRC / "accessibility.ts").read_text(encoding="utf-8")
VERIFICATION_BADGE_TEST = (CLIENT_TEST / "verificationBadge.test.ts").read_text(encoding="utf-8")
ACCESSIBILITY_TEST = (CLIENT_TEST / "accessibility.test.ts").read_text(encoding="utf-8")

APP_TSX = (ROOT / "client" / "App.tsx").read_text(encoding="utf-8")
README = (ROOT / "client" / "README.md").read_text(encoding="utf-8")
UX_DOC = (ROOT / "docs" / "ux" / "accessibility-and-reveal.md").read_text(encoding="utf-8")
TRACEABILITY = (ROOT / "docs" / "traceability.md").read_text(encoding="utf-8")


def _imports(source: str) -> list[str]:
    return re.findall(r'from "(\./[^"]+)"', source)


def _luminance(hex_colour: str) -> float:
    r = int(hex_colour[1:3], 16) / 255
    g = int(hex_colour[3:5], 16) / 255
    b = int(hex_colour[5:7], 16) / 255

    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def _contrast(foreground: str, background: str) -> float:
    lf, lb = _luminance(foreground), _luminance(background)
    lo, hi = min(lf, lb), max(lf, lb)
    return (hi + 0.05) / (lo + 0.05)


# --------------------------------------------------------------- purity ---

def test_verification_badge_imports() -> None:
    assert _imports(VERIFICATION_BADGE_TS) == []


def test_accessibility_imports() -> None:
    assert _imports(ACCESSIBILITY_TS) == []


# ---------------------------------------------------- verificationBadge ---

def test_identity_reveal_registry_is_exactly_the_srs_three() -> None:
    m = re.search(
        r"IDENTITY_REVEAL_SURFACES = \[\s*\"([^\"]+)\",\s*\"([^\"]+)\",\s*\"([^\"]+)\",?\s*\]",
        VERIFICATION_BADGE_TS,
    )
    assert m is not None
    assert [m.group(1), m.group(2), m.group(3)] == ["offer", "table-roster", "booked-slot"]
    # Account settings is named only to be EXCLUDED, never registered.
    assert 'isRevealSurface("account-settings")' in VERIFICATION_BADGE_TS
    assert "!isRevealSurface" in VERIFICATION_BADGE_TS


def test_verification_states_and_labels_pinned() -> None:
    m = re.search(r'VERIFICATION_STATES = \[\s*"([^"]+)",\s*"([^"]+)",?\s*\]', VERIFICATION_BADGE_TS)
    assert m is not None
    assert [m.group(1), m.group(2)] == ["verified", "unverified"]
    assert 'verified: "Verified"' in VERIFICATION_BADGE_TS
    assert 'unverified: "Not verified"' in VERIFICATION_BADGE_TS


def test_badge_built_from_state_alone_and_fails_closed() -> None:
    # The builder takes (surface, displayName, state) — no label parameter.
    sig = re.search(
        r"export function buildIdentityReveal\(\s*surface: string,\s*displayName: string,\s*state: string,\s*\)",
        VERIFICATION_BADGE_TS,
    )
    assert sig is not None
    # The label always comes from the pinned registry.
    assert "label: VERIFICATION_LABELS[state]" in VERIFICATION_BADGE_TS
    # Fail closed on surface, name and state.
    assert VERIFICATION_BADGE_TS.count("return null;") >= 3


def test_audit_flags_forged_label() -> None:
    assert "VERIFICATION_LABELS[reveal.verification.state]" in VERIFICATION_BADGE_TS
    assert '"verification-label"' in VERIFICATION_BADGE_TS


# ------------------------------------------------------- accessibility ---

def test_accessibility_constants_pinned() -> None:
    assert "TOUCH_TARGET_MIN_PT = 44" in ACCESSIBILITY_TS
    assert "CONTRAST_TEXT_NORMAL_MIN = 4.5" in ACCESSIBILITY_TS
    assert "CONTRAST_TEXT_LARGE_MIN = 3.0" in ACCESSIBILITY_TS
    assert "CONTRAST_NON_TEXT_MIN = 3.0" in ACCESSIBILITY_TS
    assert "LARGE_TEXT_MIN_PT = 18" in ACCESSIBILITY_TS
    assert "LARGE_TEXT_BOLD_MIN_PT = 14" in ACCESSIBILITY_TS
    assert "TEXT_SCALE_MAX_SUPPORTED = 2" in ACCESSIBILITY_TS
    assert "PRIMARY_ACTION_ZONE_MIN_FRACTION = 0.6" in ACCESSIBILITY_TS
    assert 'name: "6.1-inch"' in ACCESSIBILITY_TS
    assert "logicalHeightPt: 844" in ACCESSIBILITY_TS


def test_palette_entries_meet_wcag_aa_in_python() -> None:
    entries = re.findall(
        r'\{\s*role: "([^"]+)",\s*foreground: "(#[0-9A-Fa-f]{6})",\s*background: "(#[0-9A-Fa-f]{6})",\s*sizePt: (\d+),\s*bold: (true|false),?\s*\}',
        ACCESSIBILITY_TS,
    )
    assert len(entries) >= 3
    roles = set()
    for role, fg, bg, size, bold in entries:
        roles.add(role)
        ratio = _contrast(fg, bg)
        required = (
            3.0 if int(size) >= 18 or (bold == "true" and int(size) >= 14) else 4.5
        )
        assert ratio >= required, (role, ratio, required)
    assert {"title", "subtitle", "note"} <= roles
    # The note colour the contract caught: 3.50:1 — below the 4.5 floor.
    assert _contrast("#5C6B77", "#0B0F14") < 4.5
    assert _contrast("#74879B", "#0B0F14") >= 4.5


def test_palette_matches_app_tsx_styles() -> None:
    assert 'color: "#74879B"' in APP_TSX
    assert "#5C6B77" not in APP_TSX
    for colour in ("#F2F5F7", "#9FB0BC", "#0B0F14"):
        assert colour in APP_TSX
        assert colour in ACCESSIBILITY_TS


def test_unparseable_colours_fail_closed() -> None:
    assert "!/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;" in ACCESSIBILITY_TS
    assert "if (lf === null || lb === null) return null;" in ACCESSIBILITY_TS


def test_dynamic_type_clamps_and_fails_closed() -> None:
    assert "if (preferredScale > TEXT_SCALE_MAX_SUPPORTED) return TEXT_SCALE_MAX_SUPPORTED;" in ACCESSIBILITY_TS
    assert "if (preferredScale < 1) return 1;" in ACCESSIBILITY_TS
    assert re.search(
        r"!Number\.isFinite\(preferredScale\)\) \{\s*return 1;",
        ACCESSIBILITY_TS,
    )


def test_reduced_motion_fallback_pinned_and_garbage_reduces() -> None:
    assert 'REDUCED_MOTION_FALLBACK = "instant"' in ACCESSIBILITY_TS
    assert ACCESSIBILITY_TS.count('{ animated: false, fallback: REDUCED_MOTION_FALLBACK }') == 2
    assert '{ animated: true, fallback: null }' in ACCESSIBILITY_TS
    assert "prefersReducedMotion === true" in ACCESSIBILITY_TS


def test_control_audit_covers_label_role_target_focus() -> None:
    assert '"button"' in ACCESSIBILITY_TS
    assert 'violations.push("label");' in ACCESSIBILITY_TS
    assert 'violations.push("role");' in ACCESSIBILITY_TS
    assert 'violations.push("target");' in ACCESSIBILITY_TS
    assert 'violations.push("focus-order");' in ACCESSIBILITY_TS
    assert ":focus-order-duplicate" in ACCESSIBILITY_TS
    assert "target.width >= TOUCH_TARGET_MIN_PT" in ACCESSIBILITY_TS
    assert "target.height >= TOUCH_TARGET_MIN_PT" in ACCESSIBILITY_TS


def test_reach_zone_geometry_and_fail_closed() -> None:
    assert "return actionTopPt / screenHeightPt >= PRIMARY_ACTION_ZONE_MIN_FRACTION;" in ACCESSIBILITY_TS
    assert "screenHeightPt <= 0" in ACCESSIBILITY_TS
    assert "actionTopPt < 0" in ACCESSIBILITY_TS
    assert "actionTopPt > screenHeightPt" in ACCESSIBILITY_TS
    assert "return screenHeightPt * PRIMARY_ACTION_ZONE_MIN_FRACTION;" in ACCESSIBILITY_TS


def test_master_guard_covers_all_three_requirements() -> None:
    guard = re.search(
        r"export function accessibilityHonoursNfr25Nfr26Nfr37\(\): boolean \{(?P<body>.*?)\n\}",
        ACCESSIBILITY_TS,
        re.DOTALL,
    )
    assert guard is not None
    body = guard.group("body")
    for pin in (
        "paletteHonoursNfr25()",
        "TEXT_SCALE_MAX_SUPPORTED >= 2",
        'REDUCED_MOTION_FALLBACK === "instant"',
        "TOUCH_TARGET_MIN_PT === 44",
        "PRIMARY_ACTION_ZONE_MIN_FRACTION === 0.6",
        "REACH_REFERENCE_DEVICE.logicalHeightPt === 844",
    ):
        assert pin in body, pin


# ------------------------------------------------------- client suites ---

def test_client_suites_pin_the_contract() -> None:
    assert "table-roster" in VERIFICATION_BADGE_TEST
    assert "booked-slot" in VERIFICATION_BADGE_TEST
    assert "account-settings" in VERIFICATION_BADGE_TEST
    assert '"verification-label"' in VERIFICATION_BADGE_TEST
    assert "#5C6B77" in ACCESSIBILITY_TEST  # the caught violation, kept as evidence
    assert "#74879B" in ACCESSIBILITY_TEST
    assert "focus-order-duplicate" in ACCESSIBILITY_TEST
    assert "REACH_REFERENCE_DEVICE.logicalHeightPt" in ACCESSIBILITY_TEST


# ------------------------------------------------------------ reflection ---

def test_readme_reflects_batch_43() -> None:
    assert "`src/presence/verificationBadge.ts` | FR-70:" in README
    assert "`src/presence/accessibility.ts` | NFR-25/NFR-26/NFR-37:" in README


def test_app_shell_guards_and_note() -> None:
    assert "revealHonoursFr70()" in APP_TSX
    assert 'buildIdentityReveal("offer", "Ada", "verified")' in APP_TSX
    assert "accessibilityHonoursNfr25Nfr26Nfr37()" in APP_TSX
    assert "primaryActionInReachZone(" in APP_TSX
    assert "verification badge on every reveal" in APP_TSX
    assert "lower 40 %" in APP_TSX
    assert "FR-70" in APP_TSX and "NFR-25/26/37" in APP_TSX


def test_ux_doc_exists_and_covers_the_batch() -> None:
    assert "verificationBadge.ts" in UX_DOC
    assert "accessibility.ts" in UX_DOC
    for surface in ("offer", "table roster", "booked slot"):
        assert surface in UX_DOC
    assert "#74879B" in UX_DOC
    assert "NFR-27" in UX_DOC and "NFR-28" in UX_DOC and "TECH-08" in UX_DOC


# ---------------------------------------------------------- traceability ---

def test_traceability_reclassifies_batch_43() -> None:
    rows = {
        line.split("|")[1].strip(): line
        for line in TRACEABILITY.splitlines()
        if line.startswith("| FR-70") or line.startswith("| NFR-2") or line.startswith("| NFR-37")
    }
    for rid in ("FR-70", "NFR-25", "NFR-26", "NFR-37"):
        assert f"| {rid} | implemented |" in rows[rid], rid
    assert "| implemented | 232 |" in TRACEABILITY
    assert "| partial | 8 |" in TRACEABILITY
    assert "| client | 0 |" in TRACEABILITY
