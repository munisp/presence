"""Batch 42 invariants — client budget contracts.

Four framework-free modules pin the client-side half of the measurable
NFRs and close out TECH-16:

  - startupBudget.ts (NFR-04, NFR-05): the pinned phase ledger every
    cold start (1800 ms) and warm start (600 ms) must fit into; warm
    pays nothing for the resident native runtime or JS bundle; deferred
    work (BLE start, prefetch, flush) is banned from the critical path
    by construction and audited.
  - powerBudget.ts (NFR-29, NFR-30): the duty-cycle ledger — fixed
    consumers plus publish/cell activations COMPUTED from the FR-85
    power-mode cadence (cross-imported, never duplicated), both modes
    inside the 2 %/h ceiling; the background work registry is EMPTY
    when background presence is off (parity structurally) and holds
    exactly the BLE central wake when on.
  - frameBudget.ts (NFR-35, NFR-36): the render ledger fits the 60 fps
    budget AND the 30 fps floor; the ambient refresh gate enforces one
    refresh per minute with garbage clocks failing closed; "poll" is
    absent from the pinned refresh sources (no idle radio wake) and an
    approved refresh carries the SEC-35 contentless payload built
    locally — zero network fetches.
  - dependencyBudget.ts (TECH-16): the 45 MB bundle cap with one size
    allocation per runtime dependency (cross-pinned to package.json);
    the licence allowlist mirrors the SEC-25 CI set with a
    prohibited-marker screen in front (the TECH-08 libsignal/AGPL
    discipline); the admission gate refuses in pinned order.

NFR-36 and TECH-16 are code properties and reclassify to implemented;
NFR-04/05/29/30/35 are measurable claims — the budget contract lands
here and the device-profiling pass remains the named gap (partial).

Every pin here fails loudly if a future change relaxes one of those
guarantees — module purity and import lists, the pinned constants and
ledger sums, the fail-closed behaviours, the cross-pins into
powerMode.ts / ambientSurfaces.ts / package.json / app.json / ci.yml,
and the reflection of the batch in the client README, the App shell,
the UX doc and the traceability matrix.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT_SRC = ROOT / "client" / "src" / "presence"
CLIENT_TEST = ROOT / "client" / "test"

STARTUP_BUDGET_TS = (CLIENT_SRC / "startupBudget.ts").read_text(encoding="utf-8")
POWER_BUDGET_TS = (CLIENT_SRC / "powerBudget.ts").read_text(encoding="utf-8")
FRAME_BUDGET_TS = (CLIENT_SRC / "frameBudget.ts").read_text(encoding="utf-8")
DEPENDENCY_BUDGET_TS = (CLIENT_SRC / "dependencyBudget.ts").read_text(encoding="utf-8")
STARTUP_BUDGET_TEST = (CLIENT_TEST / "startupBudget.test.ts").read_text(encoding="utf-8")
POWER_BUDGET_TEST = (CLIENT_TEST / "powerBudget.test.ts").read_text(encoding="utf-8")
FRAME_BUDGET_TEST = (CLIENT_TEST / "frameBudget.test.ts").read_text(encoding="utf-8")
DEPENDENCY_BUDGET_TEST = (CLIENT_TEST / "dependencyBudget.test.ts").read_text(encoding="utf-8")

POWER_MODE_TS = (CLIENT_SRC / "powerMode.ts").read_text(encoding="utf-8")
AMBIENT_SURFACES_TS = (CLIENT_SRC / "ambientSurfaces.ts").read_text(encoding="utf-8")
PACKAGE_JSON = json.loads((ROOT / "client" / "package.json").read_text(encoding="utf-8"))
APP_JSON = json.loads((ROOT / "client" / "app.json").read_text(encoding="utf-8"))
CI_YML = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
SDK_ALLOWLIST = json.loads((ROOT / "docs" / "security" / "sdk-allowlist.json").read_text(encoding="utf-8"))

README = (ROOT / "client" / "README.md").read_text(encoding="utf-8")
APP_TSX = (ROOT / "client" / "App.tsx").read_text(encoding="utf-8")
UX_DOC = (ROOT / "docs" / "ux" / "client-budgets.md").read_text(encoding="utf-8")
TRACEABILITY = (ROOT / "docs" / "traceability.md").read_text(encoding="utf-8")


def _imports(source: str) -> list[str]:
    return re.findall(r'from "(\./[^"]+)"', source)


# --------------------------------------------------------------- purity ---

def test_startup_budget_imports() -> None:
    assert _imports(STARTUP_BUDGET_TS) == []


def test_power_budget_imports() -> None:
    assert _imports(POWER_BUDGET_TS) == ["./powerMode.js"]


def test_frame_budget_imports() -> None:
    assert _imports(FRAME_BUDGET_TS) == ["./ambientSurfaces.js"]


def test_dependency_budget_imports() -> None:
    assert _imports(DEPENDENCY_BUDGET_TS) == []


# ----------------------------------------------------- startupBudget ------

def test_startup_budget_constants() -> None:
    assert "export const COLD_START_BUDGET_MS = 1800;" in STARTUP_BUDGET_TS
    assert "export const WARM_START_BUDGET_MS = 600;" in STARTUP_BUDGET_TS


def test_startup_ledger_phases_and_sums() -> None:
    block = STARTUP_BUDGET_TS.split("STARTUP_PHASES: readonly StartupPhase[] = [", 1)[1]
    block = block.split("] as const;", 1)[0]
    entries = re.findall(
        r'\{ phase: "([^"]+)", coldMs: (\d+), warmMs: (\d+) \}', block
    )
    assert [name for name, _, _ in entries] == [
        "native-init",
        "js-bundle-load",
        "secure-store-read",
        "config-cache-read",
        "first-render",
        "interactive-handoff",
    ]
    assert sum(int(cold) for _, cold, _ in entries) == 1800
    assert sum(int(warm) for _, _, warm in entries) == 600
    for _, cold, warm in entries:
        assert int(warm) <= int(cold)
    zero_warm = {name for name, _, warm in entries if int(warm) == 0}
    assert {"native-init", "js-bundle-load"} <= zero_warm


def test_startup_deferred_list_off_critical_path() -> None:
    for work in (
        "ble-advertising-start",
        "ble-scan-start",
        "taxonomy-prefetch",
        "analytics-flush",
        "ambient-widget-sync",
        "push-token-refresh",
    ):
        assert f'"{work}"' in STARTUP_BUDGET_TS
    assert "deferredWorkStaysOffCriticalPath" in STARTUP_BUDGET_TS
    assert "startupBudgetHonoursNfr04Nfr05" in STARTUP_BUDGET_TS


# ------------------------------------------------------- powerBudget ------

def test_power_budget_ceiling() -> None:
    assert "export const FOREGROUND_BUDGET_PERCENT_PER_HOUR = 2;" in POWER_BUDGET_TS
    assert "FOREGROUND_BUDGET_PERCENT_PER_HOUR * 1000" in POWER_BUDGET_TS


def test_power_budget_activations_derive_from_power_mode() -> None:
    assert "publishIntervalS(mode)" in POWER_BUDGET_TS
    assert "3600 / publishIntervalS(mode)" in POWER_BUDGET_TS
    # The cadence constants stay single-sourced in powerMode.ts.
    assert "export const STANDARD_PUBLISH_INTERVAL_S = 5 * 60;" in POWER_MODE_TS
    assert "export const REDUCED_PUBLISH_INTERVAL_S = 10 * 60;" in POWER_MODE_TS
    # The ledger must NOT restate the intervals — a duplicated cadence is
    # exactly the drift this cross-import prevents. ("3600" is the
    # seconds-per-hour constant and is allowed.)
    scrubbed = POWER_BUDGET_TS.replace("3600", "")
    assert "300" not in scrubbed
    assert "600" not in scrubbed


def test_power_budget_fixed_consumers_fit_both_modes() -> None:
    block = POWER_BUDGET_TS.split("FIXED_CONSUMERS = [", 1)[1].split("] as const;", 1)[0]
    entries = re.findall(
        r'\{ consumer: "([^"]+)", milliPercentPerHour: (\d+) \}', block
    )
    assert [name for name, _ in entries] == ["ble-advertise", "ble-scan", "ui-render"]
    fixed = sum(int(cost) for _, cost in entries)
    assert fixed + 12 * 35 <= 2000, "standard mode: 12 activations x 35 mp"
    assert fixed + 6 * 35 <= 2000, "reduced mode: 6 activations x 35 mp"
    assert "export const PUBLISH_COST_MP = 20;" in POWER_BUDGET_TS
    assert "export const CELL_COMPUTE_COST_MP = 15;" in POWER_BUDGET_TS


def test_power_budget_background_registry() -> None:
    assert "BACKGROUND_WORK_WHEN_PRESENCE_OFF: readonly string[] = [];" in POWER_BUDGET_TS
    assert 'BACKGROUND_WORK_WHEN_PRESENCE_ON = ["ble-central-wake"]' in POWER_BUDGET_TS
    assert "backgroundPresenceEnabled === true" in POWER_BUDGET_TS
    assert "backgroundParityHonoursNfr30" in POWER_BUDGET_TS
    # Cross-pin: the BLE central wake is the background mode app.json
    # declares, and Android background location stays blocked.
    assert APP_JSON["expo"]["ios"]["infoPlist"]["UIBackgroundModes"] == ["bluetooth-central"]
    assert "ACCESS_BACKGROUND_LOCATION" in APP_JSON["expo"]["android"]["blockedPermissions"]


# ------------------------------------------------------- frameBudget ------

def test_frame_budget_constants() -> None:
    assert "export const FRAME_BUDGET_MS = 1000 / 60;" in FRAME_BUDGET_TS
    assert "export const FRAME_FLOOR_MS = 1000 / 30;" in FRAME_BUDGET_TS


def test_frame_render_ledger_fits_budget_and_floor() -> None:
    block = FRAME_BUDGET_TS.split("MATCH_SURFACE_RENDER_PHASES: readonly RenderPhase[] = [", 1)[1]
    block = block.split("] as const;", 1)[0]
    entries = re.findall(r'\{ phase: "([^"]+)", ms: (\d+) \}', block)
    assert [name for name, _ in entries] == [
        "layout",
        "path-geometry",
        "label-measure",
        "paint-commit",
    ]
    total = sum(int(ms) for _, ms in entries)
    assert total <= 1000 / 60
    assert total <= 1000 / 30


def test_ambient_refresh_gate_and_sources() -> None:
    assert "export const AMBIENT_REFRESH_MIN_INTERVAL_MS = 60_000;" in FRAME_BUDGET_TS
    assert 'AMBIENT_REFRESH_SOURCES = ["push", "app-active"]' in FRAME_BUDGET_TS
    assert "export const AMBIENT_NETWORK_FETCHES_PER_REFRESH = 0;" in FRAME_BUDGET_TS
    assert "nowMs - lastRefreshAtMs >= AMBIENT_REFRESH_MIN_INTERVAL_MS" in FRAME_BUDGET_TS
    assert "ambientRefreshHonoursNfr36" in FRAME_BUDGET_TS
    # The approved refresh carries the SEC-35 contentless payload.
    assert "buildAmbientPayload(presenceActive)" in FRAME_BUDGET_TS
    assert "ambientPayloadViolations" in AMBIENT_SURFACES_TS


# --------------------------------------------------- dependencyBudget -----

def test_dependency_bundle_cap() -> None:
    assert "export const BUNDLE_CAP_BYTES = 45 * 1024 * 1024;" in DEPENDENCY_BUDGET_TS


def test_licence_allowlist_mirrors_sec25_ci() -> None:
    block = DEPENDENCY_BUDGET_TS.split("ALLOWED_LICENSES = [", 1)[1].split("] as const;", 1)[0]
    module_licences = set(re.findall(r'"([^"]+)"', block))
    assert module_licences == {
        "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "CC0-1.0",
    }
    ci_allowed = set(CI_YML.split('ALLOWED="', 1)[1].split('"', 1)[0].split(";"))
    assert module_licences <= ci_allowed, "the client allowlist may be stricter, never wider"


def test_prohibited_markers_screen_copyleft() -> None:
    for marker in ('"GPL"', '"AGPL"', '"LGPL"', '"SSPL"', '"COMMONS CLAUSE"'):
        assert marker in DEPENDENCY_BUDGET_TS
    assert "toUpperCase" in DEPENDENCY_BUDGET_TS


def test_size_ledger_matches_package_json_runtime_dependencies() -> None:
    block = DEPENDENCY_BUDGET_TS.split("BUNDLE_SIZE_LEDGER: readonly DependencySize[] = [", 1)[1]
    block = block.split("] as const;", 1)[0]
    ledger_names = re.findall(r'\{ name: "([^"]+)", bytes: ', block)
    runtime_deps = sorted(PACKAGE_JSON["dependencies"].keys())
    assert sorted(ledger_names) == runtime_deps
    assert "export const RUNTIME_DEPENDENCY_COUNT = 7;" in DEPENDENCY_BUDGET_TS
    assert len(runtime_deps) == 7
    total = 0
    for m in re.finditer(r"bytes: (\d+) \* 1024( \* 1024)?", block):
        factor = 1024 * 1024 if m.group(2) else 1024
        total += int(m.group(1)) * factor
    assert total == 31 * 1024 * 1024


def test_admission_gate_reasons_pinned() -> None:
    for reason in (
        '"size-not-positive"',
        '"not-on-sec-18-allowlist"',
        '"deprecated"',
        '"licence-refused"',
        '"bundle-over-cap"',
    ):
        assert reason in DEPENDENCY_BUDGET_TS
    assert "dependencyBudgetHonoursTech16" in DEPENDENCY_BUDGET_TS


def test_sdk_allowlist_covers_the_runtime_dependencies() -> None:
    npm_entries = {s["name"] for s in SDK_ALLOWLIST["sdks"] if s["ecosystem"] == "npm"}
    runtime_deps = set(PACKAGE_JSON["dependencies"].keys())
    assert runtime_deps <= npm_entries
    assert len(SDK_ALLOWLIST["sdks"]) == 10


# --------------------------------------------------------- client tests ---

def test_client_suites_cover_the_four_modules() -> None:
    for suite, anchors in (
        (STARTUP_BUDGET_TEST, ("NFR-04", "startupBudgetHonoursNfr04Nfr05", "deferredWorkStaysOffCriticalPath")),
        (POWER_BUDGET_TEST, ("NFR-29", "powerBudgetHonoursNfr29", "backgroundParityHonoursNfr30", "ble-central-wake")),
        (FRAME_BUDGET_TEST, ("NFR-35", "frameBudgetHonoursNfr35", "ambientRefreshHonoursNfr36", "poll")),
        (DEPENDENCY_BUDGET_TEST, ("TECH-16", "dependencyBudgetHonoursTech16", "libsignal", "AGPL")),
    ):
        for anchor in anchors:
            assert anchor in suite, anchor


# ------------------------------------------------------------ reflection ---

def test_readme_maps_the_four_modules() -> None:
    assert "`src/presence/startupBudget.ts`" in README
    assert "NFR-04/NFR-05" in README
    assert "`src/presence/powerBudget.ts`" in README
    assert "NFR-29/NFR-30" in README
    assert "`src/presence/frameBudget.ts`" in README
    assert "NFR-35/NFR-36" in README
    assert "`src/presence/dependencyBudget.ts`" in README
    assert "TECH-16" in README


def test_app_shell_asserts_the_budget_guards() -> None:
    assert "startupBudgetHonoursNfr04Nfr05" in APP_TSX
    assert "powerBudgetHonoursNfr29" in APP_TSX
    assert "backgroundParityHonoursNfr30" in APP_TSX
    assert "frameBudgetHonoursNfr35" in APP_TSX
    assert "ambientRefreshHonoursNfr36" in APP_TSX
    assert "dependencyBudgetHonoursTech16" in APP_TSX


def test_ux_doc_exists_and_maps_the_modules() -> None:
    assert "startupBudget.ts" in UX_DOC
    assert "powerBudget.ts" in UX_DOC
    assert "frameBudget.ts" in UX_DOC
    assert "dependencyBudget.ts" in UX_DOC
    assert "NFR-04" in UX_DOC
    assert "TECH-16" in UX_DOC


# ---------------------------------------------------------- traceability ---

def test_traceability_reclassifies_batch_42() -> None:
    rows = {
        line.split("|")[1].strip(): line
        for line in TRACEABILITY.splitlines()
        if line.startswith("| NFR-") or line.startswith("| TECH-16")
    }
    for rid in ("NFR-04", "NFR-05", "NFR-29", "NFR-30", "NFR-35"):
        assert f"| {rid} | partial |" in rows[rid], rid
    assert "| NFR-36 | implemented |" in rows["NFR-36"]
    assert "| TECH-16 | implemented |" in rows["TECH-16"]
    assert "| implemented | 225 |" in TRACEABILITY
    assert "| partial | 8 |" in TRACEABILITY
    assert "| client | 7 |" in TRACEABILITY
