"""Batch 27 — scan-path discipline, event attribution, metrics, injectability,
ciphertext access.

TR-02    the scan path performs no synchronous primary-database call
FR-43    event = venue + time window; presence in the window is attributable
BR-05    event-scoped mode: live event surfaced on dashboard/registry
NFR-07   message delivery p95 ≤ 500 ms — realtime leg timed + alerted
TECH-15  time, randomness and identifiers are injectable
SEC-05   no service account may directly read message ciphertext tables

Asserted against the TypeScript/Python/SQL sources (wiring invariants) — the
behavioural pins live in the edge/match node test suites and validate_deploy.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EDGE_APP = (ROOT / "services" / "edge" / "src" / "app.ts").read_text()
EDGE_CONTEXT = (ROOT / "services" / "edge" / "src" / "context.ts").read_text()
EDGE_CLOCK = (ROOT / "services" / "edge" / "src" / "clock.ts").read_text()
EDGE_METRICS = (ROOT / "services" / "edge" / "src" / "metrics.ts").read_text()
EDGE_PRESENCE = (ROOT / "services" / "edge" / "src" / "routes" / "presence.ts").read_text()
EDGE_SCAN = (ROOT / "services" / "edge" / "src" / "routes" / "scan.ts").read_text()
EDGE_VENUE = (ROOT / "services" / "edge" / "src" / "routes" / "venue.ts").read_text()
EDGE_MODERATION = (ROOT / "services" / "edge" / "src" / "routes" / "moderation.ts").read_text()
MATCH_SERVER = (ROOT / "services" / "match" / "src" / "server.ts").read_text()
MATCH_STORE = (ROOT / "services" / "match" / "src" / "store.ts").read_text()
MATCH_CLOCK = (ROOT / "services" / "match" / "src" / "clock.ts").read_text()
MATCH_METRICS = (ROOT / "services" / "match" / "src" / "metrics.ts").read_text()
ALERTS = (ROOT / "deploy" / "k8s" / "prometheusrules.yaml").read_text()
RUNBOOK = (ROOT / "docs" / "runbook.md").read_text()
OPENAPI = (ROOT / "docs" / "api" / "openapi.yaml").read_text()
AN_SCHEMAS = (ROOT / "analytics" / "schemas.py").read_text()
AN_EXTRACT = (ROOT / "analytics" / "extract.py").read_text()
MIGRATIONS = {p.name: p.read_text() for p in sorted((ROOT / "db" / "migrations").glob("*.sql"))}


# ------------------------------------------------------------------- TR-02 --

def test_tr02_scan_path_uses_cache_only_profile_reads():
    # Every profile read in the match HTTP surface is the cache-only variant.
    assert "store.cachedProfile(" in MATCH_SERVER
    assert "store.profile(" not in MATCH_SERVER
    assert "await store.profile" not in MATCH_SERVER


def test_tr02_cached_profile_never_awaits_postgres():
    body = MATCH_STORE.split("cachedProfile(userId: string)", 1)[1]
    body = body.split("/**", 1)[0]  # up to the next method's doc block
    assert "await this.pg" not in body
    assert "this.profile(userId)" in body  # fire-and-forget warm only


def test_tr02_corpus_loop_still_warms_live_members():
    # The 60 s corpus refresh keeps the cold-start bound: every live presence
    # member's profile is warmed within one refresh of their first publish.
    assert "CORPUS_REFRESH_MS" in MATCH_STORE


# ------------------------------------------------------------------- FR-43 --

def test_fr43_event_lookup_is_venue_plus_window():
    assert re.search(r"FROM events\s+WHERE venue_id = \$1\s+AND starts_at <= now\(\)\s+AND ends_at > now\(\)", EDGE_PRESENCE)


def test_fr43_presence_entry_carries_event_attribution():
    assert "eventId: string | null" in EDGE_PRESENCE
    assert "presence:event:${eventId}" in EDGE_PRESENCE


def test_fr43_attribution_moves_between_events():
    # Switching events removes the user from the previous event's live set.
    assert "prev.eventId" in EDGE_PRESENCE
    assert "srem(`presence:event:" in EDGE_PRESENCE


def test_fr43_leave_and_venue_purge_strip_event_attribution():
    assert "prev.eventId) pipe.srem(`presence:event:" in EDGE_CONTEXT
    assert "delete entry.eventId" in EDGE_VENUE
    assert "writes.srem(`presence:event:" in EDGE_VENUE


def test_br05_live_event_surfaced_k_suppressed():
    assert "liveEvent" in EDGE_VENUE
    assert "liveEventPresence: kSuppressed(" in EDGE_VENUE
    # Documented on the public contract for both venue surfaces.
    dash = OPENAPI.split("/v1/venues/{venueId}/dashboard:", 1)[1].split("/v1/", 1)[0]
    assert "liveEvent" in dash and "liveEventPresence" in dash
    reg = OPENAPI.split("/v1/venues/{venueId}/registry:", 1)[1].split("/v1/", 1)[0]
    assert "liveEvent" in reg
    pres = OPENAPI.split("/v1/presence:", 1)[1].split("/v1/", 1)[0]
    assert re.search(r"event:\s*\n\s*type: \[object", pres)


# ------------------------------------------------------------------ NFR-07 --

def test_nfr07_realtime_publish_is_timed():
    assert "realtimePublishDuration().observe(" in EDGE_CONTEXT
    assert "presence_realtime_publish_duration_seconds" in EDGE_METRICS


def test_nfr07_publish_failures_counted():
    assert "realtimePublishFailures().inc(" in EDGE_CONTEXT


def test_nfr07_alert_carries_the_500ms_budget():
    assert "RealtimeDeliverySlow" in ALERTS
    block = ALERTS.split("alert: RealtimeDeliverySlow", 1)[1]
    assert "> 0.5" in block
    assert "owner: realtime-oncall" in block
    assert "presence_realtime_publish_duration_seconds_bucket" in block
    assert "## RealtimeDeliverySlow" in RUNBOOK


def test_nfr33_alert_inputs_are_emitted():
    # Every series the standing alert set reads has an emitter.
    for series in (
        "presence_http_request_duration_seconds",
        "presence_http_requests_total",
        "presence_publish_failures_total",
        "moderation_oldest_open_report_seconds",
    ):
        assert series in EDGE_METRICS, series
    for series in ("match_scan_requests_total", "match_served_total"):
        assert series in MATCH_METRICS, series
    assert "match_served_total" in ALERTS and "match_scan_requests_total" in ALERTS


def test_nfr33_scrape_endpoints_outside_auth_scope():
    # Edge: /metrics sits beside /healthz, before the authed scope opens.
    assert 'app.get("/metrics"' in EDGE_APP
    assert EDGE_APP.index('app.get("/metrics"') < EDGE_APP.index("app.register(async (authed)")
    assert 'app.get("/metrics"' in MATCH_SERVER
    # Aggregates only — the moderation gauge reads an aggregate age, not rows.
    scrape = EDGE_APP.split('app.get("/metrics"', 1)[1].split("});", 1)[0]
    assert "min(created_at)" in scrape
    assert "report_id" not in scrape


# ----------------------------------------------------------------- TECH-15 --

def test_tech15_clock_and_ids_injectable_at_edge():
    assert "clock: Clock" in EDGE_CONTEXT and "ids: IdSource" in EDGE_CONTEXT
    assert "systemClock" in EDGE_CLOCK and "randomIds" in EDGE_CLOCK
    assert "ctx.clock.now()" in EDGE_PRESENCE
    assert "ctx.ids.sessionId()" in EDGE_PRESENCE
    assert "new Date(ctx.clock.now())" in EDGE_SCAN


def test_tech15_match_store_clock_injected():
    assert "clock: Clock = systemClock" in MATCH_STORE
    assert "this.clock.now()" in MATCH_STORE
    assert "systemClock" in MATCH_CLOCK


# ------------------------------------------------------------------ SEC-05 --

def test_sec05_only_two_service_roles_and_match_cannot_read_messages():
    grants_to_match = [
        line for name, src in MIGRATIONS.items() for line in src.splitlines()
        if "TO presence_match" in line or "presence_match;" in line and "GRANT" in line
    ]
    assert not any("messages" in g for g in grants_to_match)
    init = MIGRATIONS["0001_init.sql"]
    assert "CREATE ROLE presence_match" in init and "BYPASSRLS" in init


def test_sec05_app_role_message_reads_are_pair_member_rls_only():
    init = MIGRATIONS["0001_init.sql"]
    assert "ALTER TABLE messages          ENABLE ROW LEVEL SECURITY" in init
    policy = init.split("CREATE POLICY messages_open_members", 1)[1].split(";", 1)[0]
    assert "m.state = 'OPEN'" in policy
    assert "app_user() IN (m.user_lo, m.user_hi)" in policy


def test_sec05_no_definer_function_reads_ciphertext():
    for name, src in MIGRATIONS.items():
        for m in re.finditer(
            r"CREATE OR REPLACE FUNCTION\s+(\w+).*?SECURITY DEFINER.*?(?=\nCREATE (?:OR REPLACE )?FUNCTION|\Z)",
            src, re.S,
        ):
            body = m.group(0)
            for line in body.splitlines():
                stripped = line.strip()
                if stripped.startswith("--"):
                    continue
                assert not (
                    "select" in stripped.lower() and "envelope" in stripped.lower()
                ), f"{name}:{m.group(1)} reads ciphertext: {stripped}"


def test_sec05_analytics_pipeline_never_extracts_messages():
    kinds = re.search(r"EVENT_KINDS = \(([^)]*)\)", AN_SCHEMAS).group(1)
    assert "message" not in kinds
    for term in ("envelope", "ciphertext", "content", "body", "message", "text"):
        assert f'"{term}"' in AN_SCHEMAS, f"denylist lost {term}"
    # The extractor is allowlist-per-kind: nothing outside KIND_FIELDS survives.
    assert "KIND_FIELDS[kind]" in AN_EXTRACT


def test_sec05_moderation_console_never_selects_envelopes():
    assert "FROM messages" not in EDGE_MODERATION
    assert "envelope" not in re.sub(r"//.*", "", EDGE_MODERATION)
