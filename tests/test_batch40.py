"""Batch 40 invariants — interaction surfaces (FR-81, FR-82, FR-83, FR-84, FR-86, SEC-35).

The interaction surfaces now exist as client presentation contracts:

  - constellationPicker.ts (FR-81): the spatial picker alongside text
    search — every node directly selectable (the selectable:true
    literal), so three declarations always fit the four-interaction
    budget with exactly one spare; k-anonymised popularity renders only
    at or above the k floor cross-pinned to the edge aggregate K_MIN.
  - holdToWave.ts (FR-82): the wave exists only at or beyond a 400 ms
    sustained press on the control — progressive 0..1 ramp with
    quartered haptic stages, early-release and off-control cancels, and
    a proof that no single tap can ever wave.
  - haptics.ts (FR-83): one distinct haptic signature per legal FR-29
    consent transition (cross-pinned to services/consent-go), plus a
    named audio cue and spoken announcement per transition — the
    non-visual channel; unknown transitions fail closed to no feedback.
  - closeOffer.ts (FR-84): after 15 minutes co-located in an open
    conversation, one close offer on the pinned "you have met" basis;
    accepting closes the thread and stops notifications, declining
    returns the conversation snapshot byte-identical and is never
    re-asked.
  - ambientSurfaces.ts (FR-86 + SEC-35): the three ambient surfaces are
    individually opt-in, off by default, one-action disable — and the
    ambient payload is exactly {kind, active}, contentless by
    construction and audited per payload against the forbidden fields.

Every pin here fails loudly if a future change relaxes one of those
guarantees — module purity and import lists, the pinned constants and
registries, the fail-closed behaviours, the decline-safety and
once-only rules, the TR-30 allowlist growth, and the reflection of the
batch in the client README, the App shell, the UX doc and the
traceability matrix.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT_SRC = ROOT / "client" / "src" / "presence"
CLIENT_TEST = ROOT / "client" / "test"

CONSTELLATION_PICKER_TS = (CLIENT_SRC / "constellationPicker.ts").read_text(encoding="utf-8")
HOLD_TO_WAVE_TS = (CLIENT_SRC / "holdToWave.ts").read_text(encoding="utf-8")
HAPTICS_TS = (CLIENT_SRC / "haptics.ts").read_text(encoding="utf-8")
CLOSE_OFFER_TS = (CLIENT_SRC / "closeOffer.ts").read_text(encoding="utf-8")
AMBIENT_SURFACES_TS = (CLIENT_SRC / "ambientSurfaces.ts").read_text(encoding="utf-8")
LOCAL_STATE_TS = (CLIENT_SRC / "localState.ts").read_text(encoding="utf-8")
EDGE_AGGREGATE_TS = (ROOT / "services" / "edge" / "src" / "aggregate.ts").read_text(encoding="utf-8")
CONSENT_GO = (ROOT / "services" / "consent-go" / "statemachine.go").read_text(encoding="utf-8")
CONSTELLATION_PICKER_TEST = (CLIENT_TEST / "constellationPicker.test.ts").read_text(encoding="utf-8")
HOLD_TO_WAVE_TEST = (CLIENT_TEST / "holdToWave.test.ts").read_text(encoding="utf-8")
HAPTICS_TEST = (CLIENT_TEST / "haptics.test.ts").read_text(encoding="utf-8")
CLOSE_OFFER_TEST = (CLIENT_TEST / "closeOffer.test.ts").read_text(encoding="utf-8")
AMBIENT_SURFACES_TEST = (CLIENT_TEST / "ambientSurfaces.test.ts").read_text(encoding="utf-8")
LOCAL_STATE_TEST = (CLIENT_TEST / "localState.test.ts").read_text(encoding="utf-8")
README = (ROOT / "client" / "README.md").read_text(encoding="utf-8")
APP_TSX = (ROOT / "client" / "App.tsx").read_text(encoding="utf-8")
UX_DOC = (ROOT / "docs" / "ux" / "interaction-surfaces.md").read_text(encoding="utf-8")
TRACEABILITY = (ROOT / "docs" / "traceability.md").read_text(encoding="utf-8")


def _imports(source: str) -> list[str]:
    return re.findall(r'from "(\./[^"]+)"', source)


# --------------------------------------------------------------- purity ---

def test_constellation_picker_imports_only_the_registry() -> None:
    assert _imports(CONSTELLATION_PICKER_TS) == ["./surfaceIntegrity.js"]


def test_hold_to_wave_is_import_free() -> None:
    assert _imports(HOLD_TO_WAVE_TS) == []
    assert "require(" not in HOLD_TO_WAVE_TS
    assert "fetch(" not in HOLD_TO_WAVE_TS


def test_haptics_is_import_free() -> None:
    assert _imports(HAPTICS_TS) == []


def test_close_offer_is_import_free() -> None:
    assert _imports(CLOSE_OFFER_TS) == []


def test_ambient_surfaces_imports_are_pinned() -> None:
    assert sorted(_imports(AMBIENT_SURFACES_TS)) == [
        "./localState.js",
        "./surfaceIntegrity.js",
    ]


# ----------------------------------------------------------------- FR-81 ---

def test_picker_budget_constants_are_pinned() -> None:
    assert "export const REQUIRED_DECLARATIONS = 3;" in CONSTELLATION_PICKER_TS
    assert "export const MAX_PICKER_INTERACTIONS = 4;" in CONSTELLATION_PICKER_TS
    assert 'PICKER_MODES = ["constellation", "search"] as const;' in CONSTELLATION_PICKER_TS


def test_picker_popularity_floor_matches_the_edge_k_min() -> None:
    assert "export const POPULARITY_K_FLOOR = 11;" in CONSTELLATION_PICKER_TS
    assert "export const K_MIN = 11;" in EDGE_AGGREGATE_TS


def test_every_picker_node_is_directly_selectable() -> None:
    # The selectable:true literal is the type-level guarantee behind the
    # budget: three selects always suffice, no descend is ever required.
    assert "selectable: true;" in CONSTELLATION_PICKER_TS
    assert "return REQUIRED_DECLARATIONS;" in CONSTELLATION_PICKER_TS
    assert "interactionsToDeclare() <= MAX_PICKER_INTERACTIONS" in CONSTELLATION_PICKER_TS
    assert (
        "CONSTELLATION_AFFORDANCES = [\n"
        '  "select-node",\n'
        '  "descend",\n'
        '  "ascend",\n'
        '  "search",\n'
        "] as const"
    ) in CONSTELLATION_PICKER_TS


def test_picker_runtime_audit_nets_selections() -> None:
    assert "selected.add(interaction.nodeId)" in CONSTELLATION_PICKER_TS
    assert "selected.delete(interaction.nodeId)" in CONSTELLATION_PICKER_TS
    assert "selected.size >= REQUIRED_DECLARATIONS" in CONSTELLATION_PICKER_TS
    assert "interactions.length <= MAX_PICKER_INTERACTIONS" in CONSTELLATION_PICKER_TS


def test_picker_popularity_fails_closed_below_the_floor() -> None:
    assert "kAnonymisedCount < POPULARITY_K_FLOOR" in CONSTELLATION_PICKER_TS
    assert " people nearby picked this" in CONSTELLATION_PICKER_TS
    # The descriptor field set is fixed at {mode, nodes}.
    assert "fields: { mode: picker.mode, nodes: picker.nodes }" in CONSTELLATION_PICKER_TS
    assert "pickerHonoursFr81" in CONSTELLATION_PICKER_TS


def test_picker_tests_cover_the_budget_and_the_floor() -> None:
    assert "the budget constants are pinned (FR-81)" in CONSTELLATION_PICKER_TEST
    assert "three declarations always fit the budget by construction" in CONSTELLATION_PICKER_TEST
    assert "the runtime audit nets selects and deselects against the budget" in CONSTELLATION_PICKER_TEST
    assert "popularity renders only at or above the k floor" in CONSTELLATION_PICKER_TEST
    assert "a hostile affordance is caught by the registry audit" in CONSTELLATION_PICKER_TEST


# ----------------------------------------------------------------- FR-82 ---

def test_hold_to_wave_threshold_and_cancel_paths_are_pinned() -> None:
    assert "export const WAVE_PRESS_MIN_MS = 400;" in HOLD_TO_WAVE_TS
    assert 'WAVE_CANCEL_PATHS = ["early-release", "off-control"] as const;' in HOLD_TO_WAVE_TS


def test_hold_to_wave_progress_is_clamped_and_fail_closed() -> None:
    assert "if (!Number.isFinite(heldMs) || heldMs <= 0) return 0;" in HOLD_TO_WAVE_TS
    assert "Math.min(1, heldMs / WAVE_PRESS_MIN_MS)" in HOLD_TO_WAVE_TS
    # Quartered haptic ramp stages.
    assert "if (progress < 0.25) return 0;" in HOLD_TO_WAVE_TS
    assert "if (progress < 0.5) return 1;" in HOLD_TO_WAVE_TS
    assert "if (progress < 0.75) return 2;" in HOLD_TO_WAVE_TS


def test_hold_to_wave_arbiter_cancels_before_it_waves() -> None:
    # Off-control cancels at ANY duration — checked before the threshold.
    off_control = HOLD_TO_WAVE_TS.index('if (!onControl) return "cancelled-off-control";')
    threshold = HOLD_TO_WAVE_TS.index("heldMs < WAVE_PRESS_MIN_MS")
    assert off_control < threshold
    assert 'released ? "cancelled-early-release" : "pressing"' in HOLD_TO_WAVE_TS
    assert 'return "wave";' in HOLD_TO_WAVE_TS


def test_hold_to_wave_tests_cover_every_path() -> None:
    assert "the threshold and cancel paths are pinned (FR-82)" in HOLD_TO_WAVE_TEST
    assert "the ramp is monotonic non-decreasing in held time" in HOLD_TO_WAVE_TEST
    assert "wave fires only at or beyond the threshold, on the control" in HOLD_TO_WAVE_TEST
    assert "early release cancels — it never waves" in HOLD_TO_WAVE_TEST
    assert "moving off the control cancels at any duration" in HOLD_TO_WAVE_TEST
    assert "a single tap cannot wave at any sub-threshold duration" in HOLD_TO_WAVE_TEST


# ----------------------------------------------------------------- FR-83 ---

def test_haptics_pins_the_fr29_machine() -> None:
    assert (
        "CONSENT_STATES = [\n"
        '  "DETECTED",\n'
        '  "NUDGED",\n'
        '  "EXPRESSED",\n'
        '  "MUTUAL",\n'
        '  "OPEN",\n'
        "] as const"
    ) in HAPTICS_TS
    transitions = re.findall(r'\{ from: "([A-Z]+)", to: "([A-Z]+)" \}', HAPTICS_TS)
    assert transitions == [
        ("DETECTED", "NUDGED"),
        ("DETECTED", "EXPRESSED"),
        ("NUDGED", "EXPRESSED"),
        ("EXPRESSED", "MUTUAL"),
        ("MUTUAL", "OPEN"),
    ]


def test_haptics_machine_matches_the_go_port() -> None:
    # Cross-pin: the same five transitions in services/consent-go.
    assert "case Detected:" in CONSENT_GO
    assert "return to == Nudged || to == Expressed" in CONSENT_GO
    assert "case Nudged:" in CONSENT_GO
    assert "case Expressed:" in CONSENT_GO
    assert "return to == Mutual" in CONSENT_GO
    assert "case Mutual:" in CONSENT_GO
    assert "return to == Open" in CONSENT_GO


def test_haptic_signatures_are_pinned_per_transition() -> None:
    for line in (
        '"DETECTED->NUDGED": { label: "nudge", pattern: [30] },',
        '"DETECTED->EXPRESSED": { label: "wave-sent", pattern: [20, 40, 20] },',
        '"NUDGED->EXPRESSED": { label: "wave-back", pattern: [20, 40, 60] },',
        '"EXPRESSED->MUTUAL": { label: "mutual", pattern: [40, 60, 40, 60, 40] },',
        '"MUTUAL->OPEN": { label: "open", pattern: [80, 40, 160] },',
    ):
        assert line in HAPTICS_TS, line
    assert "hapticsAreDistinct" in HAPTICS_TS


def test_every_transition_has_a_non_visual_channel() -> None:
    for cue in ("nudge-plink", "wave-send", "wave-return", "mutual-chime", "open-bloom"):
        assert f'audioCue: "{cue}"' in HAPTICS_TS, cue
    for spoken in (
        "Someone nearby shares one of your interests.",
        "Wave sent.",
        "Wave sent back.",
        "It's mutual.",
        "You're connected.",
    ):
        assert spoken in HAPTICS_TS, spoken
    assert "audibleWithoutHaptics" in HAPTICS_TS
    assert "everyTransitionHasFeedback" in HAPTICS_TS


def test_transition_feedback_fails_closed_on_unknown_transitions() -> None:
    assert "if (haptic === undefined || announcement === undefined) return null;" in HAPTICS_TS
    assert "the FR-29 states and legal transitions are pinned" in HAPTICS_TEST
    assert "the five signatures are pairwise distinct (FR-83)" in HAPTICS_TEST
    assert "every transition announces itself in audio and words" in HAPTICS_TEST
    assert "transition feedback resolves for legal transitions, fails closed otherwise" in HAPTICS_TEST


# ----------------------------------------------------------------- FR-84 ---

def test_close_offer_threshold_and_basis_are_pinned() -> None:
    assert "export const COLOCATION_CLOSE_OFFER_MIN_MS = 15 * 60 * 1000;" in CLOSE_OFFER_TS
    assert (
        'CLOSE_OFFER_BASIS =\n  "You\'ve been near each other for a while — if '
        "you've met, you can close this thread and stop its notifications.\""
    ) in CLOSE_OFFER_TS
    assert 'CLOSE_OFFER_ACTIONS = ["close-thread", "dismiss"] as const;' in CLOSE_OFFER_TS


def test_close_offer_timing_fails_closed() -> None:
    assert "if (!input.conversationOpen) return false;" in CLOSE_OFFER_TS
    assert 'input.offerState !== "due" && input.offerState !== "not-due"' in CLOSE_OFFER_TS
    assert "Number.isFinite(input.coLocatedMs)" in CLOSE_OFFER_TS
    assert ">= COLOCATION_CLOSE_OFFER_MIN_MS" in CLOSE_OFFER_TS
    assert 'return { action: "offer", basis: CLOSE_OFFER_BASIS };' in CLOSE_OFFER_TS


def test_close_offer_decline_changes_nothing() -> None:
    # Accept: closes the thread and stops notifications.
    assert "snapshot: { conversationOpen: false, notificationsEnabled: false }" in CLOSE_OFFER_TS
    assert 'offerState: "accepted"' in CLOSE_OFFER_TS
    # Decline: the snapshot comes back byte-identical.
    assert 'return { snapshot: { ...snapshot }, offerState: "declined" };' in CLOSE_OFFER_TS
    assert "declineLeavesIntact" in CLOSE_OFFER_TS


def test_close_offer_tests_cover_timing_decline_and_once_only() -> None:
    assert "the fifteen-minute threshold and the stated basis are pinned (FR-84)" in CLOSE_OFFER_TEST
    assert "no open conversation, no offer" in CLOSE_OFFER_TEST
    assert "a broken clock fails closed to no offer" in CLOSE_OFFER_TEST
    assert "declining MUST NOT affect the conversation (FR-84)" in CLOSE_OFFER_TEST
    assert "the offer is asked at most once per conversation" in CLOSE_OFFER_TEST


# --------------------------------------------------------- FR-86 / SEC-35 ---

def test_ambient_surfaces_and_persistence_key_are_pinned() -> None:
    assert (
        "AMBIENT_SURFACES = [\n"
        '  "lockScreenIndicator",\n'
        '  "liveActivity",\n'
        '  "homeScreenWidget",\n'
        "] as const"
    ) in AMBIENT_SURFACES_TS
    assert 'AMBIENT_PREFS_KEY: LocalStateKey = "presence.ambient.prefs";' in AMBIENT_SURFACES_TS


def test_ambient_opt_in_defaults_off_and_one_action_disable() -> None:
    # All three surfaces default to false.
    assert re.search(
        r"defaultAmbientPreferences\(\): AmbientPreferences \{\n"
        r"  return \{\n"
        r"    lockScreenIndicator: false,\n"
        r"    liveActivity: false,\n"
        r"    homeScreenWidget: false,\n"
        r"  \};\n"
        r"\}",
        AMBIENT_SURFACES_TS,
    )
    # Individual opt-in flips exactly one surface.
    assert "return { ...preferences, [surface]: enabled };" in AMBIENT_SURFACES_TS
    # One action, no confirmation step.
    assert 'actions: ["toggle-off"]' in AMBIENT_SURFACES_TS
    assert "confirmation: null" in AMBIENT_SURFACES_TS


def test_ambient_preferences_parse_fail_closed() -> None:
    assert "if (record[surface] === true) result[surface] = true;" in AMBIENT_SURFACES_TS
    assert "catch {\n    return defaults;\n  }" in AMBIENT_SURFACES_TS


def test_ambient_payload_is_contentless_by_construction() -> None:
    assert 'AMBIENT_PAYLOAD_KEYS = ["kind", "active"] as const;' in AMBIENT_SURFACES_TS
    assert 'return { kind: "presence-ambient", active: presenceActive };' in AMBIENT_SURFACES_TS
    # The forbidden-field list is pinned — identity, reason, count, location.
    for field in (
        "identity", "userId", "displayName", "handle", "photo", "reason",
        "reasonText", "interests", "participantCount", "count", "location",
        "cell", "venue", "distance", "map",
    ):
        assert f'  "{field}",\n' in AMBIENT_SURFACES_TS, field
    assert 'record.kind !== "presence-ambient"' in AMBIENT_SURFACES_TS
    assert 'typeof record.active !== "boolean"' in AMBIENT_SURFACES_TS
    assert 'return ["payload-shape"];' in AMBIENT_SURFACES_TS
    assert "ambientHonoursSec35" in AMBIENT_SURFACES_TS


def test_ambient_tests_cover_opt_in_parse_and_smuggling() -> None:
    assert "the three surfaces and the persistence key are pinned (FR-86)" in AMBIENT_SURFACES_TEST
    assert "every surface is off by default (FR-86)" in AMBIENT_SURFACES_TEST
    assert "disable is one action with no confirmation step (FR-86)" in AMBIENT_SURFACES_TEST
    assert "parsing fails closed — malformed or smuggled prefs read as all-off" in AMBIENT_SURFACES_TEST
    assert "the ambient payload carries exactly {kind, active} (SEC-35)" in AMBIENT_SURFACES_TEST
    assert "smuggled content is caught by the payload audit" in AMBIENT_SURFACES_TEST


# ----------------------------------------------------------------- TR-30 ---

def test_local_state_allowlist_grew_to_seven_keys() -> None:
    assert '"presence.ambient.prefs",' in LOCAL_STATE_TS
    assert (
        "// Ambient-surface opt-ins (FR-86) — off by default, wiped on logout."
        in LOCAL_STATE_TS
    )
    assert "assert.equal(LOCAL_STATE_ALLOWLIST.length, 7);" in LOCAL_STATE_TEST
    assert 'LOCAL_STATE_ALLOWLIST.includes("presence.ambient.prefs")' in LOCAL_STATE_TEST


# ------------------------------------------------------------ reflection ---

def test_client_readme_reflects_the_interaction_modules() -> None:
    for module, requirement in (
        ("constellationPicker.ts", "FR-81"),
        ("holdToWave.ts", "FR-82"),
        ("haptics.ts", "FR-83"),
        ("closeOffer.ts", "FR-84"),
        ("ambientSurfaces.ts", "SEC-35"),
    ):
        assert module in README, module
        row = next(line for line in README.splitlines() if module in line)
        assert requirement in row, row


def test_app_shell_reflects_the_interaction_contracts() -> None:
    for import_name in (
        "pickerHonoursFr81",
        "tapCannotWave",
        "everyTransitionHasFeedback",
        "declineLeavesIntact",
        "ambientHonoursSec35",
    ):
        assert import_name in APP_TSX, import_name


def test_ux_doc_maps_components_to_requirements() -> None:
    for component in (
        "ConstellationPicker",
        "HoldToWave",
        "close offer",
        "ambient surfaces",
    ):
        assert component in UX_DOC, component
    for requirement in ("FR-81", "FR-82", "FR-83", "FR-84", "FR-86", "SEC-35"):
        assert requirement in UX_DOC, requirement


# ----------------------------------------------------------- traceability ---

def test_traceability_reclassifies_the_batch() -> None:
    for requirement in ("FR-81", "FR-82", "FR-83", "FR-84", "FR-86", "SEC-35"):
        match = re.search(rf"\| {requirement} \| ([^|]+) \|", TRACEABILITY)
        assert match is not None, requirement
        assert match.group(1).strip() == "implemented", requirement


def test_traceability_counts_after_batch_40() -> None:
    assert "| implemented | 219 |" in TRACEABILITY
    assert "| partial | 7 |" in TRACEABILITY
    assert "| client | 14 |" in TRACEABILITY
