"""Batch 67 invariants — the operations console PWA (AMD-CON-01..06):

  the workforce gets its own zero-dependency web console: a PKCE-only
  sign-in against the workforce realm (memory-only tokens), a
  403-tolerant dashboard that never shows an operator a queue they
  cannot read, a unified worklist mirroring the edge's governed
  moderation vocabulary, a self-contained polygon editor for geofence
  QA, and service-worker update discipline — all served same-origin
  through nginx/APISIX so no CORS surface is added anywhere.

These pins are static mirrors: the live behaviour is proven by
console/test/opsConsole.test.ts (node --test, 25 tests). What pytest
guards is the batch's own contract:

  * the spec addendum carries all six AMD-CON entries and the footer
    records the batch;
  * the console package is zero-runtime-dependency by design (the
    TECH-16 gate scans client/ only and has nothing to admit);
  * the contract modules carry the pinned constants (PKCE sizes,
    refresh margin, request timeout, polygon caps, SW version);
  * the shell pins: viewport-fit, manifest link, module entry point,
    and the SW contract (version cross-pin, precache, navigation
    fallback, /v1/ never cached, once-guarded reload);
  * the deploy wiring: multi-stage Dockerfile, compose service on
    8082, k8s ConfigMaps/Deployment/Service + kustomization +
    NetworkPolicy pair, APISIX host routes in both files;
  * CI runs the console suite; the UX contract doc exists.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
CONSOLE = ROOT / "console"


def _console(rel: str) -> str:
    return (CONSOLE / rel).read_text()


def test_addendum_carries_all_six_con_entries():
    for i in range(1, 7):
        assert f"**AMD-CON-0{i} (" in ADDENDUM
    assert "AMD-CON-01..06 added alongside batch 67" in ADDENDUM
    assert "tests/test_batch67.py" in ADDENDUM
    assert "console/test/opsConsole.test.ts" in ADDENDUM


def test_console_package_is_zero_runtime_dependency():
    pkg = json.loads(_console("package.json"))
    assert pkg["name"] == "@presence/console"
    assert pkg["private"] is True
    # no runtime dependency block at all — the TECH-16 gate has
    # nothing to admit for this package
    assert "dependencies" not in pkg
    assert set(pkg["devDependencies"]) == {"@types/node", "typescript"}
    assert pkg["scripts"]["test"] == "npm run build && node --test dist/test/*.test.js"
    assert (CONSOLE / "tsconfig.json").exists()
    assert (CONSOLE / "tsconfig.build.json").exists()
    assert (CONSOLE / "test" / "opsConsole.test.ts").exists()


def test_oidc_contract_pins():
    src = _console("src/oidc.ts")
    assert "PKCE_VERIFIER_BYTES = 32" in src
    assert "STATE_BYTES = 16" in src
    assert "NONCE_BYTES = 16" in src
    assert "SESSION_REFRESH_MARGIN_MS = 30_000" in src
    assert '"code_challenge_method", "S256"' in src
    assert "malformed token response" in src
    # fail closed on state mismatch
    assert "state-mismatch" in src


def test_transport_and_dashboard_contract_pins():
    api = _console("src/consoleApi.ts")
    assert "CONSOLE_TIMEOUT_MS = 10_000" in api
    assert "presence-console/0.1.0" in api
    assert 'headers["idempotency-key"] = effects.uuid()' in api.replace(
        "\n", " "
    ) or "idempotency-key" in api
    assert "ConsoleAuthError" in api and "ConsoleForbiddenError" in api
    dash = _console("src/dashboard.ts")
    assert "OVERVIEW_STALE_AFTER_MS = 60_000" in dash
    assert "tolerateForbidden" in dash
    surfaces = _console("src/surfaces.ts")
    assert '"moderation"' in surfaces and '"geofences"' in surfaces
    assert '"venue-ops"' in surfaces and '"analyst"' in surfaces


def test_worklist_mirrors_governed_vocabulary():
    src = _console("src/queues.ts")
    # the console mirrors the edge's governed vocabularies verbatim —
    # a resolution can only ever carry a code the edge will accept
    for code in (
        "spam",
        "harassment",
        "scam",
        "underage",
        "impersonation",
        "sexual_content",
        "hate",
        "other_policy",
    ):
        assert f'"{code}"' in src
    assert '"actioned"' in src and '"dismissed"' in src
    assert '"upheld"' in src and '"overturned"' in src
    assert "attestation_key" in src and "payment_instrument" in src
    # guarded refusals never reach the wire
    assert "requireReasonCode" in src
    assert "requireNonEmpty" in src


def test_geofence_editor_contract_pins():
    src = _console("src/geofenceEditor.ts")
    assert "MIN_POLYGON_VERTICES = 3" in src
    assert "MAX_POLYGON_VERTICES = 256" in src
    assert "shoelaceAreaM2" in src
    assert "selfIntersects" in src
    assert "validateForSubmit" in src
    assert "toGeoJSON" in src and "fromGeoJSON" in src
    assert "hitTestVertex" in src and "hitTestEdge" in src
    assert "insertVertexAfter" in src


def test_shell_and_pwa_pins():
    html = _console("public/index.html")
    assert "viewport-fit=cover" in html
    assert 'rel="manifest"' in html
    assert 'type="module" src="/dist/web/app.js"' in html
    pwa = _console("src/pwa.ts")
    assert 'CONSOLE_SW_VERSION = "presence-console-v1"' in pwa
    assert "shouldReloadOnControllerChange" in pwa
    manifest = json.loads(_console("public/manifest.webmanifest"))
    assert manifest["display"] == "standalone"
    assert manifest["start_url"] == "./"
    sizes = {tuple(sorted(icon["sizes"].split("x"))) for icon in manifest["icons"]}
    assert ("192", "192") in sizes and ("512", "512") in sizes
    assert any(icon.get("purpose") == "maskable" for icon in manifest["icons"])


def test_service_worker_contract_pins():
    sw = _console("public/sw.js")
    assert 'VERSION = "presence-console-v1"' in sw
    # the version is cross-pinned between sw.js and src/pwa.ts
    pwa = _console("src/pwa.ts")
    assert re.search(r'CONSOLE_SW_VERSION = "([^"]+)"', pwa).group(1) == re.search(
        r'VERSION = "([^"]+)"', sw
    ).group(1)
    assert "skipWaiting" in sw
    assert "clients.claim" in sw
    assert 'mode === "navigate"' in sw
    # API traffic is NEVER cached
    assert "/v1/" in sw
    nav_at = sw.index('mode === "navigate"')
    api_guard_at = sw.index("/v1/")
    assert api_guard_at < nav_at  # the API guard runs before navigation handling


def test_icons_exist():
    for name in ("icon-192.png", "icon-512.png", "icon-maskable-512.png"):
        icon = CONSOLE / "public" / "icons" / name
        assert icon.exists() and icon.stat().st_size > 1000
        assert icon.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_deploy_wiring_pins():
    dockerfile = _console("Dockerfile")
    assert "FROM node:22-alpine AS build" in dockerfile
    assert "FROM nginx:1.27-alpine" in dockerfile
    nginx = _console("nginx.conf")
    assert "listen 8080;" in nginx
    assert "proxy_pass http://edge:4000;" in nginx
    assert "frame-ancestors 'none'" in nginx
    assert "application/manifest+json" in nginx
    compose = (ROOT / "deploy" / "docker-compose.yml").read_text()
    assert re.search(r"^  console:\n    build: \.\./console", compose, re.MULTILINE)
    assert '"8082:8080"' in compose
    k8s = (ROOT / "deploy" / "k8s" / "console.yaml").read_text()
    assert "name: console-config" in k8s and "name: console-nginx" in k8s
    assert "kind: Deployment" in k8s and "replicas: 2" in k8s
    assert "image: presence/console:p0" in k8s
    assert "readinessProbe:" in k8s
    assert "console.yaml" in (ROOT / "deploy" / "k8s" / "kustomization.yaml").read_text()
    netpol = (ROOT / "deploy" / "k8s" / "networkpolicy.yaml").read_text()
    assert "name: console-from-apisix" in netpol
    assert "name: console-egress-allowlist" in netpol
    apisix = (ROOT / "deploy" / "apisix" / "apisix.yaml").read_text()
    assert "id: ops-console" in apisix
    assert "host: ops.presence.example" in apisix
    k8s_apisix = (ROOT / "deploy" / "k8s" / "apisix.yaml").read_text()
    assert "id: ops-console" in k8s_apisix
    assert '"api.presence.example", "ops.presence.example"' in k8s_apisix


def test_ci_and_docs_pins():
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    assert re.search(r"^  console:\n", ci, re.MULTILINE)
    assert "npm ci --prefix console" in ci
    assert "npm test --prefix console" in ci
    assert (ROOT / "docs" / "ux" / "ops-console.md").exists()
    doc = (ROOT / "docs" / "ux" / "ops-console.md").read_text()
    assert "memory only" in doc
    assert "workforce-console" in doc
