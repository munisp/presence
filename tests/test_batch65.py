"""Batch 65 invariants — the offline and poor-connectivity pack
(AMD-NET-01..05):

  the client gains a FIFO action outbox (enqueue-time idempotency keys,
  bounded full-jitter retries, deliberate poison rules, hard caps), a
  four-document bounded read cache (timestamped, wholesale-replace,
  corruption-absent), a three-state connectivity classifier with
  hysteresis, a bounded session refresh retry inside the 30-second
  margin, and last-mile transfer budgets asserted against a 2G profile;
  the edge gains brotli/gzip compression and a conditional (ETag/304)
  client-config endpoint.

These pins are static mirrors: the live behaviour is proven by
client/test/connectivityPack.test.ts (node --test) and the edge suites
(clientConfig.test.ts ETag/304 + wire-size, wireEfficiency.test.ts
compression). What pytest guards is the pack's own contract:

  * the spec addendum carries all five AMD-NET entries and the footer
    records the batch;
  * the four client modules exist with the pinned constants (caps,
    backoff schedule, TTLs, budgets, link profiles);
  * the TR-30 allowlist gains exactly the outbox and read-cache keys, so
    the wipe covers them by construction;
  * the edge registers compression with the pinned options and the
    client-config route answers conditionally;
  * no new client dependency was admitted (the dependency budget and the
    SDK allowlist stay untouched);
  * the UX note documents the degradation contract.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
CLIENT = ROOT / "client"
EDGE = ROOT / "services" / "edge"


def _client(rel: str) -> str:
    return (CLIENT / rel).read_text()


def test_addendum_carries_all_five_net_entries():
    for i in range(1, 6):
        assert f"**AMD-NET-0{i} (" in ADDENDUM
    assert "AMD-NET-01..05 added alongside batch 65" in ADDENDUM
    assert "tests/test_batch65.py" in ADDENDUM
    # The batch's own verification-anchor line names the client suite.
    assert "connectivityPack.test.ts" in ADDENDUM


def test_outbox_contract_pinned():
    src = _client("src/presence/outbox.ts")
    assert "OUTBOX_MAX_ENTRIES = 100" in src
    assert "OUTBOX_MAX_BODY_BYTES = 64 * 1024" in src
    assert "OUTBOX_MAX_ATTEMPTS = 5" in src
    assert "OUTBOX_BACKOFF_BASE_MS = 2_000" in src
    assert "OUTBOX_BACKOFF_CAP_MS = 5 * 60_000" in src
    assert '"presence.outbox.queue"' in src
    # Idempotency keys are minted at enqueue, and the response classes
    # are the pinned four: ack / pause (401) / poison (426, 4xx) / retry.
    assert 'if (status === 401) return "pause"' in src
    assert 'if (status === 426) return "poison"' in src
    assert "random() * capped" in src  # full jitter


def test_read_cache_contract_pinned():
    src = _client("src/presence/readCache.ts")
    assert "READ_CACHE_MAX_BYTES = 256 * 1024" in src
    assert '"presence.cache.read"' in src
    for key in ('"scan:last"', '"conversations:list"', '"venues:nearby"'):
        assert key in src
    assert "messages:" in src and ":page0" in src
    # Wholesale replace, never merge; corruption reads absent.
    assert "wholesale" in src.lower()
    assert "catch {" in src


def test_connectivity_classifier_contract_pinned():
    src = _client("src/presence/connectivity.ts")
    assert "DEGRADED_RTT_MS = 1_500" in src
    assert "FAILURE_WINDOW = 8" in src
    assert "MIN_WINDOW_OBSERVATIONS = 4" in src
    assert "FAILURE_RATE_DEGRADED = 0.25" in src
    assert "OFFLINE_CONSECUTIVE_FAILURES = 2" in src
    assert "PROMOTION_HEALTHY_PROBES = 2" in src
    assert 'return "full"' in src and 'return "reduced"' in src and 'return "none"' in src


def test_session_bounded_retry_inside_margin():
    src = _client("src/presence/session.ts")
    assert "REFRESH_ATTEMPTS = 3" in src
    assert "REFRESH_BACKOFF_MS = [0, 2_000, 8_000]" in src
    assert "REFRESH_MARGIN_S = 30" in src
    assert "refreshScheduleFitsMargin" in src
    # The reactive 401 path is untouched: exactly one retry, never a loop.
    assert '"refresh-retry" | "reauthenticate"' in src


def test_transfer_budgets_pinned():
    src = _client("src/presence/transferBudget.ts")
    assert "edge2g: { downKbps: 50, rttMs: 1_200 }" in src
    assert "rural3g: { downKbps: 400, rttMs: 600 }" in src
    assert "scan: { profile:" in src and "maxSeconds: 8" in src
    assert "maxSeconds: 4" in src  # publish
    assert "maxSeconds: 6" in src  # config bootstrap + message
    assert "maxSeconds: 1.3" in src  # config revalidate ~ one RTT


def test_tr30_allowlist_gains_exactly_two_keys():
    src = _client("src/presence/localState.ts")
    assert '"presence.outbox.queue"' in src
    assert '"presence.cache.read"' in src
    # The wipe still iterates the allowlist — coverage by construction.
    assert "LOCAL_STATE_ALLOWLIST.map((key) => backend.deleteItem(key))" in src
    assert src.count('"presence.') == 9  # seven legacy + two new


def test_copy_registry_has_connectivity_keys():
    src = _client("src/presence/copyRegistry.ts")
    for key in (
        "ui.connectivity.offline",
        "ui.connectivity.degraded",
        "ui.connectivity.outboxPending",
        "ui.connectivity.staleCopy",
        "ui.connectivity.poisonPrompt",
    ):
        assert f'"{key}"' in src


def test_edge_wire_efficiency_wired():
    app = (EDGE / "src" / "app.ts").read_text()
    assert "@fastify/compress" in app
    assert "threshold: 1024" in app
    assert '"br", "gzip"' in app
    pkg = (EDGE / "package.json").read_text()
    assert '"@fastify/compress"' in pkg
    config = (EDGE / "src" / "clientConfig.ts").read_text()
    assert "clientConfigETag" in config
    assert "max-age=60" in config
    assert 'if-none-match' in config
    assert ".code(304)" in config
    assert (EDGE / "test" / "wireEfficiency.test.ts").exists()
    assert (EDGE / "test" / "clientConfig.test.ts").read_text().count("304") >= 1


def test_no_new_client_dependency():
    # AMD-NET-01..05 ship as framework-free contract modules — no new
    # client dependency, so the 45 MB budget and the SDK allowlist are
    # untouched. (Centrifuge or a networking runtime, when it comes,
    # arrives through the dependency-budget admission path in batch 66.)
    pkg = (CLIENT / "package.json").read_text()
    for forbidden in ("axios", "node-fetch", "centrifuge", "pusher", "socket.io"):
        assert forbidden not in pkg


def test_docs_and_client_suite_exist():
    doc = (ROOT / "docs" / "ux" / "connectivity.md").read_text()
    for needle in ("AMD-NET-01", "AMD-NET-02", "AMD-NET-03", "AMD-NET-04", "AMD-NET-05"):
        assert needle in doc
    suite = _client("test/connectivityPack.test.ts")
    for needle in (
        "outbox: ",
        "read cache: ",
        "classifier: ",
        "session: ",
        "transfer budgets: ",
        "wipe: ",
    ):
        assert needle in suite
