"""Batch 36 — client compatibility & surface contracts: TR-27 unsupported-
version detection, SEC-34 link interstitial (client half), TR-35 versioned
match-surface diagram spec.

These invariants pin the batch across all layers: the pure-TS client
modules (import-free, zero new dependencies per SEC-18), the edge version
contract (header + 426 floor + exempt bootstrap), the versioned diagram
spec stamped on every scan result, the client/server mirrors that must
never drift (link allowlist, diagram spec version), the API contract, and
the deploy documentation — so a drift in any layer fails CI.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT = ROOT / "client"

VERSIONING_TS = (CLIENT / "src" / "presence" / "versioning.ts").read_text()
LINKS_TS = (CLIENT / "src" / "presence" / "linkInterstitial.ts").read_text()
DIAGRAM_TS = (CLIENT / "src" / "presence" / "matchDiagram.ts").read_text()
VERSIONING_TEST = (CLIENT / "test" / "versioning.test.ts").read_text()
LINKS_TEST = (CLIENT / "test" / "linkInterstitial.test.ts").read_text()
DIAGRAM_TEST = (CLIENT / "test" / "matchDiagram.test.ts").read_text()
CLIENT_README = (CLIENT / "README.md").read_text()
APP_TSX = (CLIENT / "App.tsx").read_text()
PKG = json.loads((CLIENT / "package.json").read_text())

EDGE_VERSIONING = (ROOT / "services" / "edge" / "src" / "versioning.ts").read_text()
EDGE_DIAGRAM_SPEC = (ROOT / "services" / "edge" / "src" / "diagramSpec.ts").read_text()
EDGE_LINKS = (ROOT / "services" / "edge" / "src" / "links.ts").read_text()
EDGE_CLIENT_CONFIG = (ROOT / "services" / "edge" / "src" / "clientConfig.ts").read_text()
EDGE_APP = (ROOT / "services" / "edge" / "src" / "app.ts").read_text()
EDGE_SCAN = (ROOT / "services" / "edge" / "src" / "routes" / "scan.ts").read_text()
EDGE_VERSION_TEST = (ROOT / "services" / "edge" / "test" / "versioning.test.ts").read_text()
EDGE_CONFIG_TEST = (ROOT / "services" / "edge" / "test" / "clientConfig.test.ts").read_text()

OPENAPI = (ROOT / "docs" / "api" / "openapi.yaml").read_text()
K8S_EDGE = (ROOT / "deploy" / "k8s" / "edge.yaml").read_text()
COMPOSE = (ROOT / "deploy" / "docker-compose.yml").read_text()
ALLOWLIST = json.loads((ROOT / "docs" / "security" / "sdk-allowlist.json").read_text())

ALL_DEPS = {
    **PKG.get("dependencies", {}),
    **PKG.get("devDependencies", {}),
}


# ------------------------------------------------------------- purity pins ---

def test_new_client_modules_are_import_free() -> None:
    # Same discipline as sha256.ts: no new dependencies (SEC-18), and the
    # no-fetch guarantee of SEC-34/TR-35 is structural, not aspirational.
    for name, src in (("versioning.ts", VERSIONING_TS), ("linkInterstitial.ts", LINKS_TS),
                      ("matchDiagram.ts", DIAGRAM_TS)):
        assert not re.search(r'^import ', src, flags=re.M), f"{name} must be import-free"
        assert "fetch(" not in src, f"{name} must not fetch"
        assert "XMLHttpRequest" not in src


def test_no_new_dependencies() -> None:
    assert set(ALL_DEPS) == {
        "expo", "expo-dev-client", "expo-secure-store", "expo-status-bar",
        "h3-js", "react", "react-native",
        "@types/node", "@types/react", "typescript",
    }


# ------------------------------------------------------------------- TR-27 ---

def test_tr27_client_verdict_contract() -> None:
    assert "export const CLIENT_PROTOCOL_VERSION = 1" in VERSIONING_TS
    for symbol in ("evaluateBootstrapVersion", "evaluateResponseVersion",
                   "evaluateDiagramSpec", "UPDATE_PROMPT"):
        assert f"export" in VERSIONING_TS and symbol in VERSIONING_TS
    # The prompt is an explicit path, never a silent gap.
    assert '"no longer supported"' in VERSIONING_TS or "no longer supported" in VERSIONING_TS
    # Fail-open rule pinned in code: malformed signals never condemn a build.
    assert "isWellFormedVersion" in VERSIONING_TS
    assert "server bug must not brick installs" in VERSIONING_TS


def test_tr27_client_tests_cover_both_channels_and_fail_open() -> None:
    assert "below-minimum" in VERSIONING_TEST
    assert "api-too-new" in VERSIONING_TEST
    assert "server-refused" in VERSIONING_TEST
    assert "diagram-spec" in VERSIONING_TEST
    assert "fail open" in VERSIONING_TEST
    assert "426" in VERSIONING_TEST


def test_tr27_edge_publishes_all_three_channels() -> None:
    # Channel 1: bootstrap config carries the version posture.
    assert "api: { version: API_VERSION, minClientVersion: resolveMinClientVersion(env) }" in EDGE_CLIENT_CONFIG
    assert '"api"' in EDGE_CLIENT_CONFIG
    # Channel 2: x-api-version on every response.
    assert 'reply.header(API_VERSION_HEADER, String(API_VERSION))' in EDGE_VERSIONING
    assert 'export const API_VERSION = 1' in EDGE_VERSIONING
    # Channel 3: 426 through the error contract, registered in app.ts.
    assert 'reply.code(426).send({ error: "client version is no longer supported (TR-27)" })' in EDGE_VERSIONING
    assert "registerVersionContract(app)" in EDGE_APP


def test_tr27_detection_channel_is_never_refused() -> None:
    # The bootstrap config must be exempt from the floor — refusing it
    # would be failing silently by another name.
    assert '"/healthz", "/metrics", "/v1/client/config"' in EDGE_VERSIONING
    exempt_test = "the bootstrap config and probes are exempt"
    assert exempt_test in EDGE_VERSION_TEST


def test_tr27_floor_env_is_documented_in_both_manifests() -> None:
    assert "CLIENT_MIN_VERSION" in K8S_EDGE
    assert "CLIENT_MIN_VERSION" in COMPOSE
    assert 'CLIENT_MIN_VERSION?: string | undefined' in EDGE_VERSIONING
    assert 'resolveMinClientVersion({ CLIENT_MIN_VERSION: "4" })' in EDGE_VERSION_TEST


# ------------------------------------------------------------------ SEC-34 ---

def _allowlist_of(src: str) -> list[str]:
    m = re.search(r"ALLOWED_LINK_DOMAINS(?:: readonly string\[\])? = \[(.*?)\];", src, flags=re.S)
    assert m, "allowlist literal not found"
    return re.findall(r'"([a-z0-9.-]+)"', m.group(1))


def test_sec34_client_allowlist_mirrors_the_server() -> None:
    # The render policy and the write-time validation must never drift —
    # widening is a reviewed change on BOTH sides.
    assert _allowlist_of(LINKS_TS) == _allowlist_of(EDGE_LINKS)
    assert len(_allowlist_of(LINKS_TS)) == 11


def test_sec34_render_policy_is_plain_text_behind_an_interstitial() -> None:
    assert 'render: "plain-text"' in LINKS_TS
    assert 'preview: "forbidden"' in LINKS_TS
    assert 'open: "interstitial" | "never"' in LINKS_TS
    assert "LINK_INTERSTITIAL" in LINKS_TS
    assert "This link opens an external site" in LINKS_TS
    # Non-allowlisted → no open affordance at all.
    assert 'open: allowed ? "interstitial" : "never"' in LINKS_TS
    assert 'choice === "confirm" ? "open" : "dismiss"' in LINKS_TS


def test_sec34_client_tests_pin_the_degradations() -> None:
    assert "no open affordance" in LINKS_TEST
    assert "http://instagram.com/insecure" in LINKS_TEST
    assert "https://user:pass@instagram.com/x" in LINKS_TEST
    assert "instagram.com.evil.example" in LINKS_TEST
    assert 'resolveInterstitial("confirm")' in LINKS_TEST


# ------------------------------------------------------------------- TR-35 ---

def test_tr35_diagram_spec_versions_match_across_client_and_server() -> None:
    client_v = re.search(r"DIAGRAM_SPEC_VERSION = (\d+)", DIAGRAM_TS)
    server_v = re.search(r"DIAGRAM_SPEC_VERSION = (\d+)", EDGE_DIAGRAM_SPEC)
    assert client_v and server_v
    assert client_v.group(1) == server_v.group(1) == "1"
    # The client's supported set contains exactly the mirrored version.
    assert f"SUPPORTED_DIAGRAM_SPEC_VERSIONS: readonly number[] = [{client_v.group(1)}]" in VERSIONING_TS


def test_tr35_every_scan_result_is_stamped() -> None:
    assert "diagramSpec: DIAGRAM_SPEC_VERSION" in EDGE_SCAN
    assert 'import { DIAGRAM_SPEC_VERSION } from "../diagramSpec.js"' in EDGE_SCAN


def test_tr35_build_is_renderable_from_the_payload_alone() -> None:
    # Nodes carry normalised shares; edges carry role, label and kind —
    # everything derives from the reason payload, nothing is fetched.
    assert "Math.max(0, r.contribution) / total" in DIAGRAM_TS
    assert 'from: "you"' in DIAGRAM_TS and 'to: "them"' in DIAGRAM_TS
    assert "via: r.kind" in DIAGRAM_TS
    assert "renderableFromPayloadAlone" in DIAGRAM_TS
    # An unknown spec refuses — never a guessed render.
    assert 'reason: "unsupported-spec"' in DIAGRAM_TS
    assert 'reason: "incomplete-payload"' in DIAGRAM_TS
    # A null declarer still renders, labelled by the shared node.
    assert "r.yours !== null ? r.yoursLabel : r.label" in DIAGRAM_TS


def test_tr35_client_tests_pin_refusals_and_semantics() -> None:
    assert "unsupported-spec" in DIAGRAM_TEST
    assert "incomplete-payload" in DIAGRAM_TEST
    assert "sum - 1) < 1e-9" in DIAGRAM_TEST
    assert "null declarer" in DIAGRAM_TEST
    assert "renderableFromPayloadAlone(candidate())" in DIAGRAM_TEST


# ----------------------------------------------------------- api & docs -----

def test_openapi_documents_the_version_contract_and_diagram_spec() -> None:
    assert "x-api-version" in OPENAPI
    assert "426 upgrade_required (TR-27)" in OPENAPI
    assert "minClientVersion" in OPENAPI
    assert "required: [configVersion, pinning, api]" in OPENAPI
    assert "required: [pairId, sessionId, score, band, reasons, icebreaker, diagramSpec]" in OPENAPI
    assert "TR-35" in OPENAPI


def test_client_readme_and_app_reflect_the_new_modules() -> None:
    assert "src/presence/versioning.ts" in CLIENT_README
    assert "src/presence/linkInterstitial.ts" in CLIENT_README
    assert "src/presence/matchDiagram.ts" in CLIENT_README
    assert "TR-27" in CLIENT_README and "SEC-34" in CLIENT_README and "TR-35" in CLIENT_README
    assert "TR-27" in APP_TSX and "TR-35" in APP_TSX
