"""Batch 68 invariants — the member PWA (AMD-PWA-01..06):

  members get their own zero-dependency lite web client: a passkey-realm
  PKCE sign-in (memory-only tokens), a tolerant home fan-out across
  their own read models with an attention model and app badge, the
  offline pack mirrored from the native client (link classifier, bounded
  read cache, FIFO outbox), service-worker update discipline, and
  privacy self-service with a typed-confirmation account deletion — all
  served same-origin through nginx/APISIX so no CORS surface is added
  anywhere.

These pins are static mirrors: the live behaviour is proven by
pwa/test/memberPwa.test.ts (node --test). What pytest guards is the
batch's own contract:

  * the spec addendum carries all six AMD-PWA entries and the footer
    records the batch;
  * the pwa package is zero-runtime-dependency by design (the TECH-16
    gate scans client/ only and has nothing to admit);
  * the contract modules carry the pinned constants (PKCE sizes,
    refresh margin, request timeout, classifier thresholds, cache caps,
    outbox caps, SW version);
  * the shell pins: viewport-fit, manifest link, root-relative module
    entry point, and the SW contract (version cross-pin, precache,
    network-first discipline, /v1/ never cached, once-guarded reload);
  * the deploy wiring: multi-stage Dockerfile, compose service on 8081,
    k8s ConfigMaps/Deployment/Service + kustomization + NetworkPolicy
    pair, APISIX host routes in both files, the SNI extension, and the
    dedicated presence-web consumer-realm client;
  * CI runs the pwa suite; the UX contract doc exists.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
PWA = ROOT / "pwa"


def test_addendum_records_batch_68() -> None:
    for req in ("AMD-PWA-01", "AMD-PWA-02", "AMD-PWA-03", "AMD-PWA-04", "AMD-PWA-05", "AMD-PWA-06"):
        assert req in ADDENDUM, req
    assert "AMD-PWA-01..06 added alongside batch 68" in ADDENDUM
    assert "tests/test_batch68.py" in ADDENDUM
    assert "pwa/test/memberPwa.test.ts" in ADDENDUM


def test_package_is_zero_runtime_dependency() -> None:
    pkg = json.loads((PWA / "package.json").read_text())
    assert pkg["name"] == "@presence/member-pwa"
    assert "dependencies" not in pkg
    assert set(pkg["devDependencies"]) == {"@types/node", "typescript"}


def test_oidc_pins() -> None:
    oidc = (PWA / "src" / "oidc.ts").read_text()
    assert "PKCE_VERIFIER_BYTES = 32" in oidc
    assert "STATE_BYTES = 16" in oidc
    assert "NONCE_BYTES = 16" in oidc
    assert "SESSION_REFRESH_MARGIN_MS = 30_000" in oidc
    assert '"code_challenge_method", "S256"' in oidc
    assert "malformed token response" in oidc
    assert "state-mismatch" in oidc
    assert 'PKCE_STORAGE_KEY = "presence-pwa-pkce"' in oidc


def test_member_api_pins() -> None:
    api = (PWA / "src" / "memberApi.ts").read_text()
    assert "MEMBER_TIMEOUT_MS = 10_000" in api
    assert '"presence-pwa/0.1.0"' in api
    assert "idempotency-key" in api
    assert "MemberAuthError" in api
    assert "MemberForbiddenError" in api
    assert "MemberNotFoundError" in api


def test_offline_pack_pins() -> None:
    connectivity = (PWA / "src" / "connectivity.ts").read_text()
    assert "DEGRADED_RTT_MS = 1_500" in connectivity
    assert "FAILURE_RATE_DEGRADED = 0.25" in connectivity
    assert "OFFLINE_CONSECUTIVE_FAILURES = 2" in connectivity
    assert "PROMOTION_HEALTHY_PROBES = 2" in connectivity
    cache = (PWA / "src" / "readCache.ts").read_text()
    assert "READ_CACHE_MAX_BYTES = 128 * 1024" in cache
    for key in ("identity:self", "identity:kyc", "consent:pairs", "wallets:list", "account:visibility"):
        assert f'"{key}"' in cache
    outbox = (PWA / "src" / "outbox.ts").read_text()
    assert "OUTBOX_MAX_ENTRIES = 50" in outbox
    assert "OUTBOX_MAX_ATTEMPTS = 5" in outbox
    assert "OUTBOX_BACKOFF_CAP_MS = 5 * 60_000" in outbox
    assert "outbox-full" in outbox


def test_home_and_account_pins() -> None:
    home = (PWA / "src" / "home.ts").read_text()
    for state in ("DETECTED", "NUDGED", "EXPRESSED", "MUTUAL", "OPEN"):
        assert f'"{state}"' in home
    assert "badgeCountFor" in home
    assert '"en-NG"' in home
    account = (PWA / "src" / "account.ts").read_text()
    assert 'DELETE_CONFIRMATION_PHRASE = "DELETE"' in account
    assert "PERSISTED_KEYS" in account
    assert "wipeAll" in account


def test_shell_pins() -> None:
    html = (PWA / "public" / "index.html").read_text()
    assert "viewport-fit=cover" in html
    assert 'rel="manifest"' in html
    # Root-relative assets: the OIDC callback lands on the deep path
    # /auth/callback, where ./… would resolve to /auth/… and 404.
    assert 'type="module" src="/dist/web/app.js"' in html
    assert 'href="/styles.css"' in html
    app = (PWA / "web" / "app.ts").read_text()
    assert 'serviceWorker.register("/sw.js")' in app
    assert 'fetch("/config.json")' in app


def test_pwa_contract_pins() -> None:
    pwa = (PWA / "src" / "pwa.ts").read_text()
    assert 'PWA_SW_VERSION = "presence-member-pwa-v1"' in pwa
    assert "shouldReloadOnControllerChange" in pwa
    manifest = json.loads((PWA / "public" / "manifest.webmanifest").read_text())
    assert manifest["display"] == "standalone"
    sizes = {icon["sizes"] for icon in manifest["icons"]}
    assert "192x192" in sizes and "512x512" in sizes
    assert any(icon.get("purpose") == "maskable" for icon in manifest["icons"])


def test_service_worker_contract() -> None:
    sw = (PWA / "public" / "sw.js").read_text()
    pwa = (PWA / "src" / "pwa.ts").read_text()
    version = re.search(r'VERSION = "([^"]+)"', sw)
    assert version is not None
    # The SW version constant cross-pins to the TS contract.
    assert f'PWA_SW_VERSION = "{version.group(1)}"' in pwa
    assert "skipWaiting" in sw
    assert "clients.claim" in sw
    assert 'mode === "navigate"' in sw
    # /v1/ is never cached, and the guard precedes the navigate branch.
    api_guard_at = sw.index('"/v1/"')
    nav_at = sw.index('mode === "navigate"')
    assert api_guard_at < nav_at


def test_icons_exist_and_are_png() -> None:
    for name in ("icon-192.png", "icon-512.png", "icon-maskable-512.png"):
        icon = PWA / "public" / "icons" / name
        assert icon.exists(), name
        assert icon.read_bytes()[:4] == b"\x89PNG"


def test_deploy_wiring() -> None:
    dockerfile = (PWA / "Dockerfile").read_text()
    assert "FROM node:22-alpine" in dockerfile
    assert "FROM nginx:1.27-alpine" in dockerfile
    nginx = (PWA / "nginx.conf").read_text()
    assert "listen 8080;" in nginx
    assert "proxy_pass http://edge:4000;" in nginx
    assert "frame-ancestors 'none'" in nginx
    assert "application/manifest+json" in nginx
    compose = (ROOT / "deploy" / "docker-compose.yml").read_text()
    assert re.search(r"^  pwa:\n    build: \.\./pwa", compose, re.MULTILINE)
    assert '"8081:8080"' in compose
    k8s = (ROOT / "deploy" / "k8s" / "pwa.yaml").read_text()
    assert "name: pwa-config" in k8s
    assert "name: pwa-nginx" in k8s
    assert "image: presence/pwa:p0" in k8s
    assert "replicas: 2" in k8s
    assert "readinessProbe" in k8s
    assert "pwa.yaml" in (ROOT / "deploy" / "k8s" / "kustomization.yaml").read_text()
    netpol = (ROOT / "deploy" / "k8s" / "networkpolicy.yaml").read_text()
    assert "name: pwa-from-apisix" in netpol
    assert "name: pwa-egress-allowlist" in netpol
    for apisix_path in ("deploy/apisix/apisix.yaml", "deploy/k8s/apisix.yaml"):
        apisix = (ROOT / apisix_path).read_text()
        assert "id: member-pwa" in apisix
        assert "host: app.presence.example" in apisix
    k8s_apisix = (ROOT / "deploy" / "k8s" / "apisix.yaml").read_text()
    assert '"api.presence.example", "ops.presence.example", "app.presence.example"' in k8s_apisix


def test_keycloak_and_ci_and_docs() -> None:
    realm = json.loads((ROOT / "deploy" / "keycloak" / "realm-consumer.json").read_text())
    clients = {c["clientId"]: c for c in realm["clients"]}
    web = clients["presence-web"]
    assert web["publicClient"] is True
    assert web["attributes"]["pkce.code.challenge.method"] == "S256"
    assert "https://app.presence.example/auth/callback" in web["redirectUris"]
    assert "presence-app" in clients  # the native client is untouched
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    assert "npm ci --prefix pwa" in ci
    assert "npm test --prefix pwa" in ci
    doc = (ROOT / "docs" / "ux" / "member-pwa.md").read_text()
    assert "memory only" in doc
    assert "presence-web" in doc
