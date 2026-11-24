"""Batch 34 — client foundation: TECH-01 dev client, TR-29 on-device cells,
TR-30 minimum local state.

The React Native client is the largest remaining workstream (36 client
requirements). These invariants pin its foundation: the Expo custom dev
client configuration with Expo Go prohibited (BLE needs native modules),
the platform floors, the privacy contract modules (on-device H3 cells —
coordinates never travel; allowlisted local state wiped on logout), the
SEC-18 allowlist coverage of every declared dependency, and the CI job —
cross-layer, so a drift in any one layer fails CI.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT = ROOT / "client"

PKG = json.loads((CLIENT / "package.json").read_text())
APP_JSON = json.loads((CLIENT / "app.json").read_text())["expo"]
APP_TSX = (CLIENT / "App.tsx").read_text()
CELL_TS = (CLIENT / "src" / "presence" / "cell.ts").read_text()
LOCAL_STATE_TS = (CLIENT / "src" / "presence" / "localState.ts").read_text()
SECURE_STORE_TS = (CLIENT / "src" / "platform" / "secureStore.ts").read_text()
CELL_TEST = (CLIENT / "test" / "cell.test.ts").read_text()
LOCAL_STATE_TEST = (CLIENT / "test" / "localState.test.ts").read_text()
CLIENT_README = (CLIENT / "README.md").read_text()
ALLOWLIST = json.loads((ROOT / "docs" / "security" / "sdk-allowlist.json").read_text())
CI_YML = (ROOT / ".github" / "workflows" / "ci.yml").read_text()

ALL_DEPS = {
    **PKG.get("dependencies", {}),
    **PKG.get("devDependencies", {}),
}


# ---------------------------------------------------------------- TECH-01 ---

def test_client_scaffold_is_a_custom_dev_client() -> None:
    assert PKG["name"] == "@presence/client"
    # The dev client is declared…
    assert "expo-dev-client" in PKG["dependencies"]
    assert "expo-dev-client" in APP_JSON["plugins"]
    assert "expo start --dev-client" in PKG["scripts"]["start"]
    # …and Expo Go is prohibited (BLE needs native modules) — documented
    # in the manifest description, the README and pinned by this test.
    assert "Expo Go is prohibited" in PKG["description"]
    assert "Expo Go is prohibited" in CLIENT_README
    assert "expo-go" not in ALL_DEPS


def test_platform_floors_and_permissions() -> None:
    # NFR-28: iOS 16+, Android 10+ (API 29).
    assert APP_JSON["ios"]["deploymentTarget"] == "16.0"
    assert APP_JSON["android"]["minSdkVersion"] == 29
    # BLE + when-in-use location only; background location is blocked
    # (FR-19/NFR-30: background presence is opt-in, off by default).
    plist = APP_JSON["ios"]["infoPlist"]
    assert "NSBluetoothAlwaysUsageDescription" in plist
    assert "NSLocationWhenInUseUsageDescription" in plist
    perms = APP_JSON["android"]["permissions"]
    assert "BLUETOOTH_SCAN" in perms and "BLUETOOTH_CONNECT" in perms
    assert "ACCESS_BACKGROUND_LOCATION" in APP_JSON["android"]["blockedPermissions"]


def test_rn_surface_typechecks_and_tests_like_the_services() -> None:
    assert PKG["scripts"]["typecheck"] == "tsc --noEmit -p tsconfig.json"
    assert PKG["scripts"]["test"] == "npm run build && node --test dist/test/"
    # The build config compiles only the framework-free modules — the RN
    # surface is typechecked, never executed under node.
    build = json.loads((CLIENT / "tsconfig.build.json").read_text())
    assert build["include"] == ["src/presence/**/*.ts", "test/**/*.ts"]


# ----------------------------------------------------------------- TR-29 ---

def test_cell_module_pins_the_privacy_contract() -> None:
    assert 'from "h3-js"' in CELL_TS
    assert "PRESENCE_H3_RESOLUTION = 9" in CELL_TS
    # The payload is a cell id and nothing else.
    assert "interface PresencePublishPayload" in CELL_TS
    assert "readonly cell: string" in CELL_TS
    assert "payloadDiscardsCoordinates" in CELL_TS
    for key in ("latitude", "longitude", "lat", "lng", "lon"):
        assert f'"{key}"' in CELL_TS
    # FR-88: approximate-only fixes refuse to publish.
    assert "MAX_FIX_ACCURACY_M = 100" in CELL_TS
    assert "fix.accuracyM > MAX_FIX_ACCURACY_M" in CELL_TS


def test_cell_tests_cover_the_contract() -> None:
    assert "payloadDiscardsCoordinates(payload), true" in CELL_TEST
    assert 'Object.keys(payload), ["cell"]' in CELL_TEST
    assert "MAX_FIX_ACCURACY_M + 1" in CELL_TEST
    assert "deterministic" in CELL_TEST


# ----------------------------------------------------------------- TR-30 ---

def test_local_state_is_allowlisted_and_wiped() -> None:
    keys = re.findall(r'"(presence\.[\w.]+)"', LOCAL_STATE_TS)
    allowlist = [k for k in keys if k in (
        "presence.session.refreshToken",
        "presence.device.id",
        "presence.notifications.prefs",
        "presence.taxonomy.version",
        # FR-85 (batch 37): the reduced-power selection persists locally.
        "presence.powerMode",
        # FR-80 (batch 39): the seen-once mode explanations persist locally.
        "presence.ui.seenExplanations",
    )]
    assert len(set(allowlist)) == 6
    # The wipe iterates the allowlist itself — retention and wipe cannot drift.
    assert "LOCAL_STATE_ALLOWLIST.map((key) => backend.deleteItem(key))" in LOCAL_STATE_TS
    assert "createMemoryBackend" in LOCAL_STATE_TS
    # The secrets backend is the platform keystore, not plain storage.
    assert 'from "expo-secure-store"' in SECURE_STORE_TS
    assert "createSecureStoreBackend" in SECURE_STORE_TS


def test_local_state_tests_cover_the_wipe() -> None:
    assert "clearLocalState" in LOCAL_STATE_TEST
    assert "backend.keys().length, 0" in LOCAL_STATE_TEST
    assert "LOCAL_STATE_ALLOWLIST.length" in LOCAL_STATE_TEST


# ------------------------------------------------------------- governance ---

def test_every_client_dependency_is_allowlisted() -> None:
    entries = {(e["ecosystem"], e["name"]) for e in ALLOWLIST["sdks"]}
    assert len(ALLOWLIST["sdks"]) == len(entries), "no duplicate entries"
    for name in ALL_DEPS:
        assert ("npm", name) in entries, f"{name} missing from the SEC-18 allowlist"
    for entry in ALLOWLIST["sdks"]:
        for field in ("justification", "dataAccess", "approvedBy", "versionConstraint"):
            assert entry.get(field), f"{entry['name']} missing {field}"


def test_sdk_allowlist_gate_passes() -> None:
    proc = subprocess.run(
        [sys.executable, "scripts/check_sdk_allowlist.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "all allowlisted" in proc.stdout


def test_client_ci_job_exists() -> None:
    assert "  client:" in CI_YML
    assert "npm ci --prefix client" in CI_YML
    assert "npm run typecheck --prefix client" in CI_YML
    assert "npm test --prefix client" in CI_YML


def test_app_renders_the_foundation() -> None:
    assert 'from "react-native"' in APP_TSX
    assert "PRESENCE_H3_RESOLUTION" in APP_TSX
    assert "LOCAL_STATE_ALLOWLIST" in APP_TSX
