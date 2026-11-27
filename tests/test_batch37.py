"""Batch 37 invariants — device presence lifecycle (FR-88, FR-92, FR-85, FR-19).

The client publishes presence under four disciplines landed in this
batch: the platform accuracy grant is read before any publish and
approximate-only refuses with one sentence and the check-in offer
(FR-88); the published cell is the modal cell of a five-minute window
unless the device really moved (FR-92); a reduced-power mode caps the
publish cadence at once per ten minutes with a pinned timeliness notice
(FR-85); and presence withdraws within 60 seconds of backgrounding
unless the user opted into background presence (FR-19).

Every pin here fails loudly if a future change relaxes one of those
guarantees — module purity, the pinned constants, the one-sentence
refusal, the wire target, and the reflection of the batch in the client
README, the App shell and the OpenAPI contract.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT_SRC = ROOT / "client" / "src" / "presence"
CLIENT_TEST = ROOT / "client" / "test"

PUBLISH_GATE_TS = (CLIENT_SRC / "publishGate.ts").read_text(encoding="utf-8")
CELL_STABILISER_TS = (CLIENT_SRC / "cellStabiliser.ts").read_text(encoding="utf-8")
POWER_MODE_TS = (CLIENT_SRC / "powerMode.ts").read_text(encoding="utf-8")
LIFECYCLE_TS = (CLIENT_SRC / "presenceLifecycle.ts").read_text(encoding="utf-8")
LOCAL_STATE_TS = (CLIENT_SRC / "localState.ts").read_text(encoding="utf-8")
GATE_TEST = (CLIENT_TEST / "publishGate.test.ts").read_text(encoding="utf-8")
STABILISER_TEST = (CLIENT_TEST / "cellStabiliser.test.ts").read_text(encoding="utf-8")
POWER_TEST = (CLIENT_TEST / "powerMode.test.ts").read_text(encoding="utf-8")
LIFECYCLE_TEST = (CLIENT_TEST / "presenceLifecycle.test.ts").read_text(encoding="utf-8")
README = (ROOT / "client" / "README.md").read_text(encoding="utf-8")
APP_TSX = (ROOT / "client" / "App.tsx").read_text(encoding="utf-8")
OPENAPI = (ROOT / "docs" / "api" / "openapi.yaml").read_text(encoding="utf-8")

IMPORT_FREE = {
    "publishGate.ts": PUBLISH_GATE_TS,
    "powerMode.ts": POWER_MODE_TS,
    "presenceLifecycle.ts": LIFECYCLE_TS,
}


def _imports_of(source: str) -> list[str]:
    return re.findall(r'^\s*import\s.*?from\s+"([^"]+)"', source, flags=re.M)


# ------------------------------------------------------------- purity ---

def test_new_modules_are_import_free_where_required() -> None:
    # Hermes safety + SEC-18 discipline: the three policy modules import
    # nothing at all; the stabiliser may import h3-js only (the TR-29
    # cell dependency it measures distance with).
    for name, source in IMPORT_FREE.items():
        assert _imports_of(source) == [], f"{name} must stay import-free"
        assert "fetch(" not in source
    assert _imports_of(CELL_STABILISER_TS) == ["h3-js"]
    assert "fetch(" not in CELL_STABILISER_TS


def test_dependency_allowlist_stays_exactly_eleven() -> None:
    # Batch 66 (AMD-CRT-04): was ten; centrifuge joined through the TECH-16
    # admission gate (sdk-allowlist entry + dependencyBudget ledger).
    import json

    allowlist = json.loads((ROOT / "docs" / "security" / "sdk-allowlist.json").read_text())
    npm = sorted(e["name"] for e in allowlist["sdks"] if e["ecosystem"] == "npm")
    assert npm == sorted([
        "@types/node", "@types/react", "expo", "expo-dev-client",
        "expo-secure-store", "expo-status-bar", "h3-js", "react",
        "react-native", "typescript", "centrifuge",
    ])


# ---------------------------------------------------------------- FR-88 ---

def test_fr88_refusal_is_one_sentence_with_checkin_alternative() -> None:
    m = re.search(r'ACCURACY_REFUSAL_SENTENCE =\s*\n?\s*"([^"]+)"', PUBLISH_GATE_TS)
    assert m, "the pinned refusal sentence exists"
    sentences = [s for s in re.split(r"[.!?]+", m.group(1)) if s.strip()]
    assert len(sentences) == 1, "FR-88: exactly one sentence"
    assert 'ACCURACY_REFUSAL_ALTERNATIVE = "venue-checkin"' in PUBLISH_GATE_TS
    # Fail closed: only an explicit precise grant publishes.
    assert 'if (grant === "precise") return { publish: true }' in PUBLISH_GATE_TS
    assert 'reason: "accuracy-grant"' in PUBLISH_GATE_TS
    assert "refusalHonoursFr88" in PUBLISH_GATE_TS


def test_fr88_client_tests_pin_the_gate() -> None:
    assert 'evaluateAccuracyGrant("precise")' in GATE_TEST
    assert 'evaluateAccuracyGrant("approximate")' in GATE_TEST
    assert "fail closed" in GATE_TEST
    assert "venue-checkin" in GATE_TEST
    assert "sentences.length, 1" in GATE_TEST


# ---------------------------------------------------------------- FR-92 ---

def test_fr92_window_threshold_and_modal_rule() -> None:
    assert "STABILISATION_WINDOW_MS = 5 * 60 * 1000" in CELL_STABILISER_TS
    assert "MOVEMENT_THRESHOLD_CELLS = 1" in CELL_STABILISER_TS
    # Modal cell of the window, deterministic: frequency, then hysteresis
    # (ties keep the published cell), then recency, then cell id.
    assert "function modalCell" in CELL_STABILISER_TS
    assert "count > bestCount" in CELL_STABILISER_TS
    assert "isPublished && !bestIsPublished" in CELL_STABILISER_TS
    assert "lastAt > bestLastAt" in CELL_STABILISER_TS
    assert "cell < best" in CELL_STABILISER_TS
    assert "modalCell(samples, lastPublished)" in CELL_STABILISER_TS
    # Real movement publishes fresh; unmeasurable pairs count as movement.
    assert "gridDistance(from, to) > MOVEMENT_THRESHOLD_CELLS" in CELL_STABILISER_TS
    assert re.search(r"catch\s*{\s*//[^\n]*\n\s*//[^\n]*\n\s*return true;", CELL_STABILISER_TS), (
        "unmeasurable distance must fall through to 'moved'"
    )
    # The window actually slides.
    assert "at - s.at < STABILISATION_WINDOW_MS" in CELL_STABILISER_TS


def test_fr92_client_tests_cover_flap_move_and_eviction() -> None:
    assert "boundary flapping settles to the modal cell" in STABILISER_TEST
    assert "real movement publishes fresh immediately" in STABILISER_TEST
    assert "unmeasurable pair is treated as movement" in STABILISER_TEST
    assert "samples older than the window are evicted" in STABILISER_TEST
    assert 'reason: "initial"' in STABILISER_TEST


# ---------------------------------------------------------------- FR-85 ---

def test_fr85_cadence_constants_and_ttl_margin() -> None:
    assert "STANDARD_PUBLISH_INTERVAL_S = 5 * 60" in POWER_MODE_TS
    assert "REDUCED_PUBLISH_INTERVAL_S = 10 * 60" in POWER_MODE_TS
    assert "PRESENCE_SESSION_TTL_S = 900" in POWER_MODE_TS
    # Both cadences stay below the FR-14 session TTL (server: 900 s).
    assert 300 < 900 and 600 < 900
    assert "REDUCED_POWER_NOTICE" in POWER_MODE_TS
    assert 'POWER_MODES: readonly PowerMode[] = ["standard", "reduced"]' in POWER_MODE_TS


def test_fr85_notice_says_matches_are_less_timely() -> None:
    m = re.search(r'REDUCED_POWER_NOTICE =\s*\n?\s*"([^"]+)"', POWER_MODE_TS)
    assert m, "the pinned notice exists"
    assert re.search(r"slower|longer", m.group(1), re.I), (
        "FR-85: the visible indication must say matches are less timely"
    )


def test_fr85_selection_persists_in_the_allowlist_and_wipes() -> None:
    assert '"presence.powerMode"' in LOCAL_STATE_TS
    keys = re.findall(r'"(presence\.[\w.]+)"', LOCAL_STATE_TS)
    # Batch 39 added presence.ui.seenExplanations (FR-80): 5 → 6 keys.
    # Batch 40 added presence.ambient.prefs (FR-86): 6 → 7 keys.
    # Batch 65 added presence.outbox.queue + presence.cache.read
    # (AMD-NET-01/02): 7 → 9 keys.
    assert len(set(keys)) == 9
    # The wipe iterates the allowlist itself, so the new key wipes too.
    assert "LOCAL_STATE_ALLOWLIST.map((key) => backend.deleteItem(key))" in LOCAL_STATE_TS


def test_fr85_client_tests_pin_the_ceiling_and_switch_semantics() -> None:
    assert "REDUCED_PUBLISH_INTERVAL_S, 600" in POWER_TEST
    assert "PRESENCE_SESSION_TTL_S, 900" in POWER_TEST
    assert "isPublishDueAfterSwitch" in POWER_TEST
    assert "never early, never skipped" in POWER_TEST


# ---------------------------------------------------------------- FR-19 ---

def test_fr19_deadline_and_wire_target() -> None:
    assert "BACKGROUND_WITHDRAWAL_DEADLINE_S = 60" in LIFECYCLE_TS
    m = re.search(
        r'WITHDRAWAL_WIRE = {\s*method: "DELETE",\s*path: "([^"]+)",\s*} as const',
        LIFECYCLE_TS,
    )
    assert m and m.group(1) == "/v1/presence", "FR-19 withdraws via DELETE /v1/presence"
    assert 'action: "withdraw"' in LIFECYCLE_TS
    assert 'reason: "background-presence-enabled"' in LIFECYCLE_TS
    assert 'action: "cancel-pending-withdrawal"' in LIFECYCLE_TS
    assert "withdrawalHonoursFr19" in LIFECYCLE_TS


def test_fr19_client_tests_pin_the_guarantee() -> None:
    assert "deadlineS, 60" in LIFECYCLE_TEST
    assert 'path: "/v1/presence"' in LIFECYCLE_TEST
    assert "cancel-pending-withdrawal" in LIFECYCLE_TEST


# ------------------------------------------------------------ reflection ---

def test_readme_and_app_reflect_the_lifecycle_modules() -> None:
    for mod in ("publishGate", "cellStabiliser", "powerMode", "presenceLifecycle"):
        assert mod in README, f"client README documents {mod}"
    for mod, req in (
        ("publishGate", "FR-88"),
        ("cellStabiliser", "FR-92"),
        ("powerMode", "FR-85"),
        ("presenceLifecycle", "FR-19"),
    ):
        assert mod in APP_TSX, f"App.tsx imports {mod}"
        assert req in APP_TSX, f"App.tsx header names {req}"


def test_openapi_documents_the_client_lifecycle_contract() -> None:
    # The presence ops name the client-side disciplines they serve.
    assert "FR-19" in OPENAPI and "FR-85" in OPENAPI
    assert "FR-88" in OPENAPI and "FR-92" in OPENAPI
