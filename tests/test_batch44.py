"""Batch 44 invariants — NFR-27 localisation + NFR-28 OS/BLE floors.

NFR-27 (copyRegistry.ts): one copy registry keyed off the English
baseline; locales are pure data; the English floor sits under every
missing key; unknown keys fail closed to null; launch readiness means
full coverage. NFR-28 (bleFloor.ts): the iOS 16 / Android API 29 floors
pinned in code AND cross-checked against app.json; the BLE capability
ladder degrades two-way -> witness-only -> off with pinned notices and
no dead ends, proven through the TR-32 resolver; garbage fails closed
to the least radio.

These tests pin the contract sources, the App-shell wiring, the README
rows, the UX doc and the regenerated traceability counts.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COPY_REGISTRY = (ROOT / "client/src/presence/copyRegistry.ts").read_text()
BLE_FLOOR = (ROOT / "client/src/presence/bleFloor.ts").read_text()
COPY_TEST = (ROOT / "client/test/copyRegistry.test.ts").read_text()
BLE_TEST = (ROOT / "client/test/bleFloor.test.ts").read_text()
APP_TSX = (ROOT / "client/App.tsx").read_text()
APP_JSON = json.loads((ROOT / "client/app.json").read_text())
README = (ROOT / "client/README.md").read_text()
UX_DOC = (ROOT / "docs/ux/localisation-and-degradation.md").read_text()
REVEAL_DOC = (ROOT / "docs/ux/accessibility-and-reveal.md").read_text()
TRACEABILITY = (ROOT / "docs/traceability.md").read_text()


def _imports(source: str) -> list[str]:
    """Return the module specifiers of every import statement."""
    return re.findall(r'import(?:\s+type)?[\s\S]*?from\s+"([^"]+)";', source)


# ---------------------------------------------------------------- module shape


def test_copy_registry_is_import_free():
    assert _imports(COPY_REGISTRY) == []


def test_ble_floor_imports_only_the_tr32_resolver():
    assert _imports(BLE_FLOOR) == ["./permissions.js"]


def test_client_test_suites_exist():
    assert (ROOT / "client/test/copyRegistry.test.ts").exists()
    assert (ROOT / "client/test/bleFloor.test.ts").exists()


# ---------------------------------------------------------------- NFR-27 pins


def test_launch_locale_and_commitment_pinned():
    assert 'LAUNCH_LOCALE = "en"' in COPY_REGISTRY
    assert "ADDITIONAL_LOCALES_COMMITTED = 2" in COPY_REGISTRY
    assert "ADDITIONAL_LOCALES_WINDOW_MONTHS = 3" in COPY_REGISTRY


def test_locale_tag_pattern_pinned():
    assert "LOCALE_TAG_PATTERN" in COPY_REGISTRY
    assert "^[a-z]{2,3}" in COPY_REGISTRY


def test_english_baseline_has_no_empty_strings():
    body = COPY_REGISTRY.split("ENGLISH_COPY: Readonly<Record<string, string>> = {", 1)[1].split("};", 1)[0]
    entries = re.findall(r'("[a-z0-9.\-]+")\s*:\s*"((?:[^"\\]|\\.)*)"', body)
    assert len(entries) >= 8, entries
    for key, value in entries:
        assert value.strip() != "", f"empty baseline string at {key}"


def test_unknown_key_fails_closed_to_null():
    assert "if (baseline === undefined) return null;" in COPY_REGISTRY


def test_english_floor_under_every_missing_key():
    # resolveCopy ends by returning the baseline — the fallback floor.
    assert "return baseline;" in COPY_REGISTRY
    # Blank translations are refused before the floor.
    assert 'translated.trim() !== ""' in COPY_REGISTRY


def test_launch_readiness_requires_full_coverage_and_valid_tag():
    assert "if (!isValidLocaleTag(bundle.tag)) return false;" in COPY_REGISTRY
    assert "localeCoverage(bundle).missing.length === 0" in COPY_REGISTRY


def test_master_guard_proves_data_only_locale_addition():
    # The "without code changes" proof: a synthetic locale constructed at
    # runtime resolves its override inside copyHonoursNfr27.
    assert "copyHonoursNfr27" in COPY_REGISTRY
    assert 'tag: "yo"' in COPY_REGISTRY
    assert 'resolveCopy(synthetic, "app.title") !== "Iwalaye"' in COPY_REGISTRY
    assert 'resolveCopy(synthetic, "no.such.key") !== null' in COPY_REGISTRY


# ---------------------------------------------------------------- NFR-28 pins


def test_os_floors_pinned_in_code():
    assert "IOS_FLOOR_MAJOR = 16" in BLE_FLOOR
    assert "ANDROID_FLOOR_API = 29" in BLE_FLOOR


def test_os_floors_cross_checked_against_app_json():
    assert APP_JSON["expo"]["ios"]["deploymentTarget"] == "16.0"
    assert APP_JSON["expo"]["android"]["minSdkVersion"] == 29


def test_capability_ladder_exactly_three_levels():
    assert 'BLE_CAPABILITIES = ["advertise+scan", "scan-only", "none"] as const' in BLE_FLOOR


def test_pinned_notices_present():
    for name in ("BLE_WITNESS_ONLY_NOTICE", "BLE_UNAVAILABLE_NOTICE", "UNSUPPORTED_OS_NOTICE"):
        match = re.search(rf"{name} =\s*\n?\s*\"([^\"]+)\"", BLE_FLOOR)
        assert match is not None, name
        assert match.group(1).strip() != ""


def test_garbage_fails_closed_to_least_radio():
    assert 'if (raw === "advertise+scan" || raw === "scan-only") return raw;' in BLE_FLOOR
    assert 'return "none";' in BLE_FLOOR
    assert "if (!Number.isFinite(reading.version) || reading.version < 0) return false;" in BLE_FLOOR


def test_master_guard_proves_no_dead_ends_through_tr32():
    assert "bleFloorHonoursNfr28" in BLE_FLOOR
    assert "assertNoDeadEnds(resolveCapabilities(matrix))" in BLE_FLOOR
    # The unsupported refusal is pinned too.
    assert 'refused.tier === "unsupported"' in BLE_FLOOR
    assert "refused.notice === UNSUPPORTED_OS_NOTICE" in BLE_FLOOR


# ---------------------------------------------------------------- App shell


def test_app_wires_both_contracts():
    assert 'from "./src/presence/copyRegistry.js"' in APP_TSX
    assert 'from "./src/presence/bleFloor.js"' in APP_TSX
    assert "copyHonoursNfr27()" in APP_TSX
    assert "bleFloorHonoursNfr28()" in APP_TSX


def test_app_renders_shell_copy_through_the_registry():
    assert "const ACTIVE_LOCALE: LocaleBundle | null = null;" in APP_TSX
    assert '{resolveCopy(ACTIVE_LOCALE, "app.title")}' in APP_TSX
    assert '{resolveCopy(ACTIVE_LOCALE, "app.subtitle")}' in APP_TSX


def test_app_note_line_carries_batch_summary():
    assert "copy registry: English at launch, locales are data" in APP_TSX
    assert "BLE degrades, never dead-ends" in APP_TSX


# ---------------------------------------------------------------- docs


def test_readme_rows_use_full_requirement_ids():
    assert "`src/presence/copyRegistry.ts` | NFR-27:" in README
    assert "`src/presence/bleFloor.ts` | NFR-28:" in README


def test_ux_doc_maps_both_modules():
    assert "copyRegistry.ts" in UX_DOC
    assert "bleFloor.ts" in UX_DOC
    assert "TECH-08" in UX_DOC  # the one remaining client-gated item
    # The earlier doc's NOT-here section no longer lists NFR-27/28 as open.
    section = REVEAL_DOC.split("## What is deliberately NOT here", 1)[1]
    assert "copyRegistry.ts" in section and "bleFloor.ts" in section


# ---------------------------------------------------------------- traceability


def test_traceability_reclassifies_batch_44():
    rows = {
        line.split("|")[1].strip(): line
        for line in TRACEABILITY.splitlines()
        if line.startswith("| NFR-2")
    }
    for rid in ("NFR-27", "NFR-28"):
        assert f"| {rid} | implemented |" in rows[rid], rid
    # Batch 44: NFR-27 + NFR-28 client → implemented: 229 → 231, 8 → 8, 3 → 1.
    assert "| implemented | 231 |" in TRACEABILITY
    assert "| partial | 8 |" in TRACEABILITY
    assert "| client | 1 |" in TRACEABILITY
