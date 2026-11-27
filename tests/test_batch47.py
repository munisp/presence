"""Batch 47 invariants — the rendered UI layer: theme derived from the
audited palette (ui/theme.ts), the navigation state machine
(ui/navigation.ts), the screen descriptor trees (ui/screens.ts), and the
thin React Native renderer (src/ui/render.tsx), plus the NFR-27 copy
keys, the App-shell wiring, the README rows and the UX doc.

No requirement status changes: every contract the UI renders was closed
in batches 34–46, so the traceability counts stay 234/6/0 and the pinned
build include is untouched (the renderer lives outside src/presence —
typechecked, never executed under node).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "client"
THEME = (CLIENT / "src/presence/ui/theme.ts").read_text()
NAV = (CLIENT / "src/presence/ui/navigation.ts").read_text()
SCREENS = (CLIENT / "src/presence/ui/screens.ts").read_text()
RENDER = (CLIENT / "src/ui/render.tsx").read_text()
COPY = (CLIENT / "src/presence/copyRegistry.ts").read_text()
APP_TSX = (CLIENT / "App.tsx").read_text()
README = (CLIENT / "README.md").read_text()
UX_DOC = (ROOT / "docs/ux/rendered-ui.md").read_text()
TRACEABILITY = (ROOT / "docs/traceability.md").read_text()


def _imports(source: str) -> list[str]:
    """Return the module specifiers of every import statement."""
    return re.findall(r'import(?:\s+type)?[\s\S]*?from\s+"([^"]+)";', source)


# ------------------------------------------------------------------ files


def test_ui_files_exist():
    for path in (
        "client/src/presence/ui/theme.ts",
        "client/src/presence/ui/navigation.ts",
        "client/src/presence/ui/screens.ts",
        "client/src/ui/render.tsx",
        "client/test/uiTheme.test.ts",
        "client/test/uiNavigation.test.ts",
        "client/test/uiScreens.test.ts",
        "docs/ux/rendered-ui.md",
    ):
        assert (ROOT / path).exists(), path


# ------------------------------------------------------------------ theme


def test_theme_imports_only_the_accessibility_contract():
    assert _imports(THEME) == ["../accessibility.js"]


def test_theme_declares_no_colour_literal():
    # The theme is derived from CLIENT_PALETTE — a hex literal here would
    # be a colour the WCAG audit never sees.
    assert re.search(r"#[0-9A-Fa-f]{6}\b", THEME) is None


def test_theme_pins_grid_motion_and_target():
    assert "SPACING_UNIT_PT = 4" in THEME
    assert "instant: 0" in THEME and "fast: 150" in THEME and "standard: 250" in THEME
    assert "TOUCH_TARGET_MIN_PT" in THEME  # the target floor is cross-pinned
    assert "dynamicTypeScale" in THEME and "motionPlan" in THEME


def test_theme_master_guard_is_non_vacuous():
    assert "themeHonoursA11y" in THEME
    assert 'textStyle("no-such-tone", 1) === null' in THEME


# ------------------------------------------------------------- navigation


def test_navigation_imports_only_the_safety_contract():
    assert _imports(NAV) == ["../reportFlow.js"]


def test_navigation_state_machine_fails_closed():
    assert 'ROOT_SCREEN: AppScreen = "discovery"' in NAV
    assert '...APP_SCREENS, "match"' in NAV
    # Unknown destinations and back-from-root return the unchanged state.
    assert "if (!isNavScreen(screen)) return state;" in NAV
    assert "if (state.stack.length <= 1) return state;" in NAV
    assert "if (currentScreen(state) === screen) return state;" in NAV


def test_match_overlay_is_hosted_on_discovery():
    assert 'return screen === "match" ? "discovery" : screen;' in NAV


# ---------------------------------------------------------------- screens


def test_screens_imports_are_the_contract_set():
    assert _imports(SCREENS) == [
        "../accessibility.js",
        "../copyRegistry.js",
        "../discoverySkeleton.js",
        "../indoorPresence.js",
        "../matchSurface.js",
        "../conversationThread.js",
        "../presenceHalo.js",
        "../reportFlow.js",
        "../surfaceIntegrity.js",
        "./theme.js",
        "./navigation.js",
    ]


def test_screens_builders_and_audits_present():
    for name in (
        "buildDiscoveryScreen",
        "buildMatchScreen",
        "buildConversationScreen",
        "buildCheckinScreen",
        "buildSettingsScreen",
        "buildSafetyTrayActions",
        "collectActions",
        "collectAffordances",
        "auditUiScreen",
        "uiHonoursContracts",
    ):
        assert f"export function {name}" in SCREENS, name


def test_safety_action_copy_covers_the_five():
    block = SCREENS.split("SAFETY_ACTION_COPY: Record<SafetyAction, string> = {", 1)[1].split("};", 1)[0]
    for action in ("report", "block", "withdraw-consent", "delete-account", "privacy-controls"):
        assert f"{action}:" in block or f'"{action}":' in block


def test_audit_enforces_tray_controls_and_prohibitions():
    assert "controlsViolations(collectActions(node))" in SCREENS
    assert "descriptorViolations({ kind: node.id, affordances, fields: {} })" in SCREENS
    assert "safetyScreenViolations({" in SCREENS
    # Non-vacuity: a tray-less screen must fail with safety-entry.
    assert 'auditUiScreen(broken).includes("safety-entry")' in SCREENS


# ------------------------------------------------------------------- copy


def test_copy_registry_gained_the_ui_keys():
    for key in (
        '"ui.safety.tray"',
        '"ui.wave.hold"',
        '"ui.thread.send"',
        '"ui.checkin.title"',
        '"ui.settings.title"',
        '"ui.match.title"',
    ):
        assert key in COPY, key


# --------------------------------------------------------------- renderer


def test_renderer_is_the_thin_rn_half():
    assert 'from "react-native"' in RENDER
    assert "renderNode" in RENDER
    assert "resolveCopy" in RENDER  # locale override at render time
    # The renderer lives outside src/presence — outside the pinned build
    # include, so it is typechecked but never executed under node.
    assert not (CLIENT / "src/presence/ui/render.tsx").exists()


def test_build_include_unchanged():
    build = json.loads((CLIENT / "tsconfig.build.json").read_text())
    assert build["include"] == ["src/presence/**/*.ts", "test/**/*.ts"]


# --------------------------------------------------------------- App.tsx


def test_app_wires_the_ui_layer():
    assert 'from "./src/presence/ui/theme.js"' in APP_TSX
    assert 'from "./src/presence/ui/navigation.js"' in APP_TSX
    assert 'from "./src/presence/ui/screens.js"' in APP_TSX
    assert 'from "./src/ui/render.js"' in APP_TSX
    assert "themeHonoursA11y()" in APP_TSX
    assert "safetyReachable(initialNavigation())" in APP_TSX
    assert "uiHonoursContracts()" in APP_TSX
    assert "function PresenceShell()" in APP_TSX
    assert "rendered shell: every screen is an audited descriptor" in APP_TSX


def test_app_prior_pins_survived():
    # Batch-46 pins still hold — the UI layer was added, not swapped in.
    assert "safetyAccessHonoursBr07()" in APP_TSX
    assert "indoorPresenceHonoursFr89()" in APP_TSX
    assert 'color: "#74879B"' in APP_TSX
    assert '{resolveCopy(ACTIVE_LOCALE, "app.title")}' in APP_TSX
    assert "free, two taps from any screen" in APP_TSX


# ------------------------------------------------------------------- docs


def test_readme_rows_present():
    for row in ("src/presence/ui/theme.ts", "src/presence/ui/navigation.ts",
                "src/presence/ui/screens.ts", "src/ui/render.tsx"):
        assert f"`{row}`" in README, row


def test_ux_doc_declares_what_is_not_here():
    assert "What is deliberately NOT here" in UX_DOC
    assert "Pixel-perfect visual design" in UX_DOC
    assert "VoiceOver/TalkBack" in UX_DOC


# ----------------------------------------------------------- traceability


def test_traceability_counts_unchanged():
    # Batch 47 renders closed contracts — no status moves.
    # Batch 70 closed TR-44 (the final phase-gated requirement): 234 → 235, phase-gated 1 → 0.
    assert "| implemented | 235 |" in TRACEABILITY
    assert "| partial | 6 |" in TRACEABILITY
    assert "| gap-p0 | 0 |" in TRACEABILITY
