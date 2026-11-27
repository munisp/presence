"""Batch 66 invariants — client runtime wiring (AMD-CRT-01..04):

  the batch-65 contracts gain their runtime: a single-chokepoint API
  client (observation-fed, idempotency-keyed mutations that re-enqueue
  the SAME key on a wire failure), a proactive single-flight session
  refresh driver on the bounded AMD-NET-03 schedule, a single-flight
  outbox pump with persist-after-mutation, and a link-gated realtime
  adapter — plus the edge's Centrifugo connection-token endpoint and
  the centrifuge dependency admitted through the TECH-16 gate.

These pins are static mirrors: the live behaviour is proven by
client/test/runtimeWiring.test.ts (node --test) and the edge suites
(realtimeToken.test.ts, clientConfig.test.ts realtime block). What
pytest guards is the batch's own contract:

  * the spec addendum carries all four AMD-CRT entries and the footer
    records the batch;
  * the four client modules exist with the pinned constants (timeouts,
    refresh schedule, token lifetimes, reconnect backoff);
  * the mutation path mints the idempotency key BEFORE the send and
    re-enqueues the same key (outbox.ts carries the optional draft key);
  * the edge token route is fail-closed (503 without the HMAC secret),
    member-scoped (RLS matches query, closed pairs excluded), and
    registered inside the authed scope;
  * the bootstrap config carries the realtime wsUrl block with an
    empty-string default (fail closed);
  * the TECH-16 gate recorded the centrifuge admission: package.json,
    SEC-18 allowlist, ledger count 8, 39 MB against the 45 MB cap;
  * the deploy wiring ships the secret and the public URL (k8s +
    compose), and clients reach Centrifugo through APISIX only.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
CLIENT = ROOT / "client"
EDGE = ROOT / "services" / "edge"


def _client(rel: str) -> str:
    return (CLIENT / rel).read_text()


def _edge(rel: str) -> str:
    return (EDGE / rel).read_text()


def test_addendum_carries_all_four_crt_entries():
    for i in range(1, 5):
        assert f"**AMD-CRT-0{i} (" in ADDENDUM
    assert "AMD-CRT-01..04 added alongside batch 66" in ADDENDUM
    assert "tests/test_batch66.py" in ADDENDUM
    assert "runtimeWiring.test.ts" in ADDENDUM


def test_api_client_chokepoint_pinned():
    src = _client("src/presence/apiClient.ts")
    assert "DEFAULT_TIMEOUT_MS = 10_000" in src
    # The idempotency key is minted BEFORE the send…
    assert "const idempotencyKey = effects.uuid();" in src
    assert '"idempotency-key": idempotencyKey' in src
    # …and an offline link skips the doomed attempt entirely.
    assert 'connectivity.state === "offline"' in src
    # Observations feed the AMD-NET-03 classifier on both outcomes.
    assert "effects.record({ ok: true" in src
    assert "effects.record({ ok: false" in src
    # The 401 decision is re-exported, never re-implemented.
    assert "return onUnauthorized(alreadyRetried);" in src


def test_outbox_draft_carries_the_wire_key():
    src = _client("src/presence/outbox.ts")
    assert "idempotencyKey?: string;" in src
    assert "idempotencyKey: draft.idempotencyKey ?? ctx.uuid()," in src


def test_session_runtime_pinned():
    src = _client("src/presence/sessionRuntime.ts")
    assert "nextRefreshDelayMs" in src
    assert "runProactiveRefresh" in src
    assert "createRefreshCoordinator" in src
    # Bounded by the AMD-NET-03 schedule, joined single-flight.
    assert "attempt < REFRESH_ATTEMPTS" in src
    assert "if (pending !== null) return pending;" in src


def test_outbox_pump_pinned():
    src = _client("src/presence/outboxPump.ts")
    # Offline kicks are skipped, never buffered.
    assert '"skipped-offline"' in src
    assert 'connectivity.state !== "offline"' in src
    # Single-flight with exactly one dirty follow-up.
    assert "dirty = true;" in src
    # Persist after mutation, never on an untouched queue.
    assert "serializeOutbox(after) !== before" in src
    assert "await effects.persist(serializeOutbox(after));" in src


def test_realtime_adapter_pinned():
    src = _client("src/presence/realtime.ts")
    assert "REALTIME_TOKEN_LIFESPAN_S = 600" in src
    assert "REALTIME_TOKEN_REFRESH_MARGIN_S = 60" in src
    assert "REALTIME_RECONNECT_BASE_MS = 1_000" in src
    assert "REALTIME_RECONNECT_CAP_MS = 60_000" in src
    # Fail closed on an unconfigured tier.
    assert 'config.wsUrl.trim().length === 0' in src
    # Degraded links never churn unsubscriptions.
    assert "unsubscribe: []," in src


def test_edge_realtime_token_route_pinned():
    src = _edge("src/realtimeToken.ts")
    assert "CENTRIFUGO_TOKEN_TTL_S = 600" in src
    assert "CENTRIFUGO_TOKEN_HMAC_SECRET_KEY" in src
    assert "503" in src
    assert "closed_at IS NULL" in src
    assert "user_lo = $1::uuid" in src
    assert 'createHmac("sha256", secret)' in src
    app = _edge("src/app.ts")
    assert "registerRealtimeTokenRoute(authed, ctx);" in app


def test_client_config_carries_the_realtime_block():
    src = _edge("src/clientConfig.ts")
    assert "REALTIME_PUBLIC_WS_URL" in src
    assert "realtime: { wsUrl" in src
    assert '"realtime"' in src


def test_centrifuge_admitted_through_the_tech16_gate():
    pkg = json.loads(_client("package.json"))
    assert pkg["dependencies"]["centrifuge"].startswith("^5.")
    assert len(pkg["dependencies"]) == 8
    allowlist = json.loads((ROOT / "docs/security/sdk-allowlist.json").read_text())
    entries = {s["name"]: s for s in allowlist["sdks"]}
    assert "centrifuge" in entries
    assert entries["centrifuge"]["versionConstraint"].startswith("^5.")
    budget = _client("src/presence/dependencyBudget.ts")
    assert "export const RUNTIME_DEPENDENCY_COUNT = 8;" in budget
    assert '{ name: "centrifuge", bytes: 8 * 1024 * 1024 },' in budget
    block = budget.split("BUNDLE_SIZE_LEDGER: readonly DependencySize[] = [", 1)[1]
    block = block.split("] as const;", 1)[0]
    total = 0
    for m in re.finditer(r"bytes: (\d+) \* 1024( \* 1024)?", block):
        factor = 1024 * 1024 if m.group(2) else 1024
        total += int(m.group(1)) * factor
    assert total == 39 * 1024 * 1024
    # The lockfile records the admission (reproducible installs).
    lock = json.loads(_client("package-lock.json"))
    assert "node_modules/centrifuge" in lock["packages"]


def test_openapi_and_docs_carry_the_batch():
    openapi = (ROOT / "docs/api/openapi.yaml").read_text()
    assert "/v1/realtime/token:" in openapi
    assert "realtime:" in openapi
    doc = (ROOT / "docs/ux/runtime-wiring.md").read_text()
    for i in range(1, 5):
        assert f"AMD-CRT-0{i}" in doc


def test_deploy_wiring_ships_secret_and_public_url():
    k8s = (ROOT / "deploy/k8s/edge.yaml").read_text()
    assert "CENTRIFUGO_TOKEN_HMAC_SECRET_KEY" in k8s
    assert "REALTIME_PUBLIC_WS_URL" in k8s
    compose = (ROOT / "deploy/docker-compose.yml").read_text()
    assert "CENTRIFUGO_TOKEN_HMAC_SECRET_KEY" in compose
    assert "REALTIME_PUBLIC_WS_URL" in compose
    # Clients reach Centrifugo through APISIX only.
    apisix = (ROOT / "deploy/apisix/apisix.yaml").read_text()
    assert "enable_websocket: true" in apisix
