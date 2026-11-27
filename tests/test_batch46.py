"""Batch 46 invariants — close-out: BR-07 two-tap free safety (reportFlow.ts),
FR-89 check-in-primary indoor presence (indoorPresence.ts), and the
device-profiling harness (scripts/profile_device_budgets.py) for the five
measurable partials.

These tests pin the contract sources, the App-shell wiring, the README
rows, the UX doc, the harness behaviour (budgets read from the client
contracts, fail-closed validation), and the regenerated traceability
counts.
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = (ROOT / "client/src/presence/reportFlow.ts").read_text()
INDOOR = (ROOT / "client/src/presence/indoorPresence.ts").read_text()
HARNESS_SRC = (ROOT / "scripts/profile_device_budgets.py").read_text()
APP_TSX = (ROOT / "client/App.tsx").read_text()
README = (ROOT / "client/README.md").read_text()
UX_DOC = (ROOT / "docs/ux/safety-and-indoor-presence.md").read_text()
TRACEABILITY = (ROOT / "docs/traceability.md").read_text()


def _imports(source: str) -> list[str]:
    """Return the module specifiers of every import statement."""
    return re.findall(r'import(?:\s+type)?[\s\S]*?from\s+"([^"]+)";', source)


def _load_harness():
    spec = importlib.util.spec_from_file_location(
        "profile_device_budgets", ROOT / "scripts/profile_device_budgets.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- reportFlow


def test_report_flow_imports_only_the_fr03_anchor():
    assert _imports(REPORT) == ["./journeyContracts.js"]


def test_client_test_suites_exist():
    assert (ROOT / "client/test/reportFlow.test.ts").exists()
    assert (ROOT / "client/test/indoorPresence.test.ts").exists()


def test_safety_registry_is_exactly_the_five_srs_actions():
    block = REPORT.split("SAFETY_ACTIONS = [", 1)[1].split("] as const", 1)[0]
    assert block.count('"') == 10  # five quoted actions
    for action in ("report", "block", "withdraw-consent", "delete-account", "privacy-controls"):
        assert f'"{action}"' in block


def test_two_tap_budget_and_tray_entry_pinned():
    assert "MAX_SAFETY_TAPS = 2" in REPORT
    assert 'SAFETY_TRAY_ENTRY = "safety-entry" as const' in REPORT


def test_safety_wires_pinned_and_delete_cross_pinned_to_fr03():
    assert 'report: "POST /v1/reports"' in REPORT
    assert 'block: "POST /v1/blocks"' in REPORT
    assert '"withdraw-consent": "DELETE /v1/account/consents/{purpose}"' in REPORT
    assert '"delete-account": ACCOUNT_DELETE_ENDPOINT' in REPORT
    assert '"privacy-controls": "GET /v1/account/consents"' in REPORT
    # The delete wire is not re-declared — it IS the FR-03 constant.
    journeys = (ROOT / "client/src/presence/journeyContracts.ts").read_text()
    assert 'ACCOUNT_DELETE_ENDPOINT = "DELETE /v1/account"' in journeys


def test_monetisation_fields_are_audit_violations():
    block = REPORT.split("MONETISATION_FIELDS = [", 1)[1].split("] as const", 1)[0]
    for field in ("price", "paywall", "premium", "subscription", "upsell"):
        assert f'"{field}"' in block
    assert 'violations.push(`monetisation:${field}`);' in REPORT


def test_fail_closed_and_master_guard():
    assert "if (!isAppScreen(screen)) return null;" in REPORT
    assert "if (!isSafetyAction(action)) return null;" in REPORT
    assert "safetyAccessHonoursBr07" in REPORT


# ---------------------------------------------------------------- indoorPresence


def test_indoor_presence_imports_the_fr48_contract():
    assert _imports(INDOOR) == ["./journeyContracts.js"]


def test_indoor_fallback_notice_pinned():
    assert "INDOOR_FALLBACK_NOTICE =" in INDOOR
    assert "the map estimate is the fallback indoors" in INDOOR


def test_indoor_plan_delegates_ranking_to_fr48_ordering():
    assert 'preferredPresenceSource(["venue-checkin", "cell"])' in INDOOR
    assert 'if (primary !== "venue-checkin") return null;' in INDOOR
    assert "planVenueCheckin(context.checkinCode)" in INDOOR


def test_indoor_fail_closed():
    assert 'if (typeof context.insidePartnerVenue !== "boolean") return null;' in INDOOR
    assert 'if (typeof context.checkinCode !== "string") return null;' in INDOOR
    assert "if (!context.insidePartnerVenue) return null;" in INDOOR


def test_indoor_master_guard_walks_the_contract():
    assert "indoorPresenceHonoursFr89" in INDOOR
    assert 'plan.primary !== "venue-checkin" || plan.fallback !== "cell"' in INDOOR
    assert 'emptyCode.checkin.action !== "refuse"' in INDOOR


# ---------------------------------------------------------------- harness


def test_harness_reads_budgets_from_the_client_contracts():
    assert '_pinned(STARTUP, "COLD_START_BUDGET_MS")' in HARNESS_SRC
    assert '_pinned(STARTUP, "WARM_START_BUDGET_MS")' in HARNESS_SRC
    assert '_pinned(FRAME, "FRAME_BUDGET_MS")' in HARNESS_SRC
    assert '_pinned(FRAME, "FRAME_FLOOR_MS")' in HARNESS_SRC
    # Division expressions (1000 / 60) are evaluated, not truncated.
    assert "numerator / int(divisor)" in HARNESS_SRC


def test_harness_validates_fail_closed():
    harness = _load_harness()
    assert harness.COLD_BUDGET_MS == 1800
    assert harness.WARM_BUDGET_MS == 600
    assert abs(harness.FRAME_TARGET_MS - 1000 / 60) < 1e-9
    assert abs(harness.FRAME_FLOOR_MS - 1000 / 30) < 1e-9
    # The reference report passes.
    assert harness.validate_report(harness.PASSING_REPORT) == []
    # An over-budget cold start fails NFR-04.
    breach = json.loads(json.dumps(harness.PASSING_REPORT))
    breach["startup"]["coldMs"] = [1900, 1901, 1899]
    assert any("NFR-04" in failure for failure in harness.validate_report(breach))
    # Background work with presence off fails NFR-30.
    background = json.loads(json.dumps(harness.PASSING_REPORT))
    background["power"]["backgroundOffMilliPercentPerHour"] = 12
    assert any("NFR-30" in failure for failure in harness.validate_report(background))
    # Garbage readings fail closed, not silently.
    garbage = json.loads(json.dumps(harness.PASSING_REPORT))
    garbage["frames"]["matchSurfaceP95Ms"] = "fast"
    assert any("NFR-35" in failure for failure in harness.validate_report(garbage))
    # Too few runs fail closed.
    short = json.loads(json.dumps(harness.PASSING_REPORT))
    short["startup"]["warmMs"] = [400]
    assert any("NFR-05" in failure for failure in harness.validate_report(short))


# ---------------------------------------------------------------- App shell


def test_app_wires_both_contracts():
    assert 'from "./src/presence/reportFlow.js"' in APP_TSX
    assert 'from "./src/presence/indoorPresence.js"' in APP_TSX
    assert "safetyAccessHonoursBr07()" in APP_TSX
    assert "indoorPresenceHonoursFr89()" in APP_TSX


def test_app_note_line_carries_batch_summary():
    assert "free, two taps from any screen" in APP_TSX
    assert "check-in first, cell is the fallback" in APP_TSX


# ---------------------------------------------------------------- docs


def test_readme_rows_use_full_requirement_ids():
    assert "`src/presence/reportFlow.ts` | BR-07:" in README
    assert "`src/presence/indoorPresence.ts` | FR-89:" in README


def test_ux_doc_maps_both_modules():
    assert "reportFlow.ts" in UX_DOC
    assert "indoorPresence.ts" in UX_DOC
    assert "profile_device_budgets.py" in UX_DOC
    assert "safety-entry" in UX_DOC


# ---------------------------------------------------------------- traceability


def test_traceability_reclassifies_batch_46():
    rows = {
        line.split("|")[1].strip(): line
        for line in TRACEABILITY.splitlines()
        if line.startswith("| BR-") or line.startswith("| FR-89 ")
    }
    assert "| BR-07 | implemented |" in rows["BR-07"]
    assert "| FR-89 | implemented |" in rows["FR-89"]
    # Batch 46: BR-07 + FR-89 client halves → implemented: 232 → 234, 8 → 6, 0 → 0.
    # Batch 70 closed TR-44 (the final phase-gated requirement): 234 → 235, phase-gated 1 → 0.
    assert "| implemented | 235 |" in TRACEABILITY
    assert "| partial | 6 |" in TRACEABILITY
    assert "| client | 0 |" in TRACEABILITY


def test_the_five_measurable_partials_stay_partial_with_the_harness_named():
    for req in ("NFR-04", "NFR-05", "NFR-29", "NFR-30", "NFR-35"):
        row = next(
            line for line in TRACEABILITY.splitlines() if line.startswith(f"| {req} |")
        )
        assert "| partial |" in row, req
