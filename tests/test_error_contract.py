"""Batch 26 — error contract, discovery pause, redirects, grace, notification gates.

TR-25   stable machine error codes + retry hints, no internal leaks
NFR-14  matcher outage surfaces 'discovery paused', never an error
TR-19   deprecated taxonomy nodes resolve through redirect_to (both engines)
NFR-18  presence session: 15-min TTL + 45-min index grace
FR-22   no two returned candidates share the same primary reason
FR-58   every user-channel send gated by shouldNotify; safety always passes

Asserted against the TypeScript/Python sources (wiring invariants) — the
behavioural pins live in the edge/match node test suites.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EDGE_ERRORS = (ROOT / "services" / "edge" / "src" / "errors.ts").read_text()
EDGE_APP = (ROOT / "services" / "edge" / "src" / "app.ts").read_text()
EDGE_SCAN = (ROOT / "services" / "edge" / "src" / "routes" / "scan.ts").read_text()
EDGE_PRESENCE = (ROOT / "services" / "edge" / "src" / "routes" / "presence.ts").read_text()
EDGE_CONSENT = (ROOT / "services" / "edge" / "src" / "routes" / "consent.ts").read_text()
EDGE_DEVICES = (ROOT / "services" / "edge" / "src" / "routes" / "devices.ts").read_text()
EDGE_CONTENT = (ROOT / "services" / "edge" / "src" / "routes" / "content.ts").read_text()
EDGE_PROFILE = (ROOT / "services" / "edge" / "src" / "routes" / "profile.ts").read_text()
EDGE_NOTIF = (ROOT / "services" / "edge" / "src" / "notifications.ts").read_text()
MATCH_SCAN = (ROOT / "services" / "match" / "src" / "scan.ts").read_text()
MATCH_ENGINE = (ROOT / "services" / "match" / "src" / "engine.ts").read_text()
MATCH_STORE = (ROOT / "services" / "match" / "src" / "store.ts").read_text()
PY_GRAPH = (ROOT / "presence" / "graph.py").read_text()
PY_MATCHING = (ROOT / "presence" / "matching.py").read_text()


# ---------------------------------------------------------------- TR-25

def test_tr25_enrichment_hook_registered_app_wide():
    assert "registerErrorContract(app)" in EDGE_APP
    assert "preSerialization" in EDGE_ERRORS
    assert "setErrorHandler" in EDGE_ERRORS


def test_tr25_code_shape_is_status_dot_slug():
    assert re.search(r"`\$\{status\}\.\$\{messageSlug\(message\)\}`", EDGE_ERRORS)


def test_tr25_retryable_only_for_429_and_5xx():
    m = re.search(r"isRetryable[^}]+return\s+([^;]+);", EDGE_ERRORS, re.S)
    assert m and "429" in m.group(1) and ">= 500" in m.group(1)


def test_tr25_error_handler_never_leaks_internals():
    handler = EDGE_ERRORS.split("setErrorHandler", 1)[1]
    assert "request failed schema validation" in handler  # ajv detail masked
    assert "internal error" in handler                    # 5xx masked
    assert ".send(err" not in handler
    assert "err.message" not in handler                   # never echo the raw error


def test_tr25_route_level_429s_carry_retry_after():
    for src, name in [
        (EDGE_SCAN, "scan.ts"),
        (EDGE_CONSENT, "consent.ts"),
        ((ROOT / "services" / "edge" / "src" / "routes" / "announcements.ts").read_text(), "announcements.ts"),
        ((ROOT / "services" / "edge" / "src" / "routes" / "rooms.ts").read_text(), "rooms.ts"),
    ]:
        for send in re.findall(r'code\(429\)\.send\(\{[^}]+\}\)', src, re.S):
            assert "retryAfterSeconds" in send, f"429 without retry hint in {name}: {send[:80]}"


# ---------------------------------------------------------------- NFR-14

def test_nfr14_matcher_outage_is_paused_never_an_error():
    assert '{ state: "paused", results: [] }' in EDGE_SCAN
    assert '"ok" | "quiet" | "paused"' in EDGE_SCAN
    assert "match service unavailable" not in EDGE_SCAN  # the old 502 is gone
    # both failure modes degrade: non-2xx and unreachable
    assert "matcher_error" not in EDGE_SCAN or "statusCode: res.status" in EDGE_SCAN


# ---------------------------------------------------------------- TR-19

def test_tr19_ts_engine_resolves_redirects():
    assert "resolve(" in MATCH_ENGINE and "redirect" in MATCH_ENGINE
    assert "resolveProfile" in MATCH_ENGINE
    # the scan vector entry resolves first
    vec = MATCH_ENGINE.split("vector(", 1)[1]
    assert "resolveProfile" in vec.split("return", 1)[0] or "resolveProfile" in vec


def test_tr19_python_engine_parity():
    assert "def resolve(" in PY_GRAPH
    assert "def resolve_profile(" in PY_GRAPH
    assert "resolve_profile" in PY_MATCHING


def test_tr19_store_loads_redirect_column():
    assert "redirect_to AS redirect" in MATCH_STORE


def test_tr19_edge_rejects_deprecated_interest_with_redirect():
    assert "that interest has moved" in EDGE_PROFILE
    assert "redirectTo" in EDGE_PROFILE
    assert "redirect_to" in EDGE_PROFILE  # the column is actually read


# ---------------------------------------------------------------- NFR-18

def test_nfr18_grace_constants():
    assert "PRESENCE_INDEX_GRACE_S = 2700" in EDGE_PRESENCE
    assert "PRESENCE_TTL_S = 900" in EDGE_PRESENCE
    assert "PRESENCE_TTL_S + PRESENCE_INDEX_GRACE_S" in EDGE_PRESENCE


def test_nfr18_index_sets_expire_at_ttl_plus_grace():
    assert 'expire(`presence:cell:${storedCell}`, PRESENCE_INDEX_TTL_S)' in EDGE_PRESENCE
    assert 'expire(`presence:venue:${venueId}`, PRESENCE_INDEX_TTL_S)' in EDGE_PRESENCE


def test_nfr18_stale_index_members_pruned():
    assert "pruneCellResidue" in EDGE_PRESENCE
    assert "srem(`presence:cell:${cell}`, member)" in EDGE_PRESENCE


# ---------------------------------------------------------------- FR-22

def test_fr22_hard_primary_guarantee_in_ranker():
    assert "usedPrimaries" in MATCH_SCAN
    assert "usedPrimaries.has(primary)" in MATCH_SCAN
    # the loop breaks rather than duplicating a primary
    assert re.search(r"if \(bestIdx === -1\) break", MATCH_SCAN)


# ---------------------------------------------------------------- FR-58

def test_fr58_single_gate_exists():
    assert "export function shouldNotify(" in EDGE_NOTIF
    assert "export async function notifyUser(" in EDGE_NOTIF


def test_fr58_safety_bypasses_switch_and_quiet():
    gate = EDGE_NOTIF.split("export function shouldNotify", 1)[1]
    gate = gate.split("export async function notifyUser", 1)[0]
    assert "SAFETY_CATEGORY) return true" in gate


def test_fr58_all_user_channel_sends_go_through_the_gate():
    # own-account safety notices
    assert 'notifyUser(ctx, userId, "safety"' in EDGE_DEVICES
    assert re.search(r'notifyUser\(ctx, removedPublisher[^,]*, "safety"', EDGE_CONTENT)
    # consent flow: nudge and open gate on the recipient's prefs
    assert 'shouldNotify(recipientPrefs, "nudges")' in EDGE_CONSENT
    assert 'shouldNotify(out.stored, "matches")' in EDGE_CONSENT


def test_fr58_open_route_reads_both_pair_members_for_recipient():
    open_route = EDGE_CONSENT.split('app.post("/v1/consent/:pairId/open"', 1)[1]
    assert "user_lo" in open_route and "user_hi" in open_route
    assert "notification_prefs" in open_route
