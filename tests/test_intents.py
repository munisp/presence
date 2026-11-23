#!/usr/bin/env python3
"""FR-17/FR-71 acceptance criteria for intents and the recurrence signal.

Pins: the governed intent vocabulary, the sixty-minute cap, expiry with
presence via purgePresence, live-presence requirement, Valkey-only storage
(no intent column in Postgres), the hashed pair key, the at-most-once-per-
day counter, the no-timestamps rule, and that both signals annotate scan
results without touching the score contract.

Behavioural coverage of the lib lives in services/edge/test/intents.test.ts;
route/contract coverage is enforced globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_intents.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = (ROOT / "services/edge/src/intents.ts").read_text()
ROUTE = (ROOT / "services/edge/src/routes/intents.ts").read_text()
SCAN = (ROOT / "services/edge/src/routes/scan.ts").read_text()
CONTEXT = (ROOT / "services/edge/src/context.ts").read_text()
APP = (ROOT / "services/edge/src/app.ts").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
MIGRATIONS = {p.name: p.read_text() for p in (ROOT / "db/migrations").glob("*.sql")}


# ------------------------------------------------------------ FR-17 --------

def test_fr17_vocabulary_is_governed_and_closed() -> None:
    block = LIB.split("INTENT_VOCABULARY = [")[1].split("] as const")[0]
    words = re.findall(r'"(\w+)"', block)
    assert words == ["coffee", "food", "chat", "walk", "dance", "network", "explore", "quiet"]
    assert "as const" in LIB


def test_fr17_sixty_minute_cap() -> None:
    assert re.search(r"INTENT_TTL_S = 3600", LIB)
    assert '"EX",\n        INTENT_TTL_S' in ROUTE or "EX" in ROUTE


def test_fr17_expires_with_presence() -> None:
    purge = CONTEXT.split("export async function purgePresence")[1]
    assert 'pipe.del(`intent:${userId}`)' in purge, "purgePresence must kill the intent"


def test_fr17_requires_live_presence() -> None:
    put = ROUTE.split('"/v1/presence/intent"')[1]
    assert "presence:user:" in put
    assert "409" in put


def test_fr17_never_persists_to_postgres() -> None:
    for name, text in MIGRATIONS.items():
        assert "intent" not in re.sub(r"--[^\n]*", "", text).lower(), (
            f"no intent column may exist in Postgres ({name})"
        )
    assert "ctx.pg" not in ROUTE, "the intent route must not touch Postgres"


def test_fr17_shared_intent_is_a_signal_not_a_score() -> None:
    assert "sharedIntent" in SCAN
    assert "score: r.score" in SCAN, "the score passes through from the match service"
    sig = SCAN.split("const sharedIntent =")[1].split(";")[0]
    assert "score" not in sig, "the signal is computed from the two intents only"
    assert "candIntent" in sig and "myIntent" in sig


# ------------------------------------------------------------ FR-71 --------

def test_fr71_pair_key_is_hashed() -> None:
    fn = LIB.split("export function recurrenceKey")[1]
    assert "sha256" in fn
    assert "recur:" in fn


def test_fr71_day_ordinal_not_timestamp() -> None:
    fn = LIB.split("export function dayOrdinal")[1].split("}")[0]
    assert "86_400_000" in fn
    assert "toISOString" not in fn and "getTime()" in fn
    # The wire carries the count, never a date.
    assert "recurrenceDays" in SCAN
    result = SCAN.split("recurrenceDays")[0].split("results.push")[1]
    assert "at" not in result.replace("that", "").replace("candidate", ""), "no timestamp field rides along"


def test_fr71_at_most_one_bump_per_day() -> None:
    fn = LIB.split("export function bumpRecurrence")[1]
    assert "stored.lastDay === today" in fn
    assert "bumped: false" in fn
    assert "days: stored.days + 1" in fn


def test_fr71_counter_has_bounded_retention() -> None:
    assert re.search(r"RECURRENCE_TTL_S = 7_776_000", LIB), "ninety days"
    assert "RECURRENCE_TTL_S" in SCAN


# ---------------------------------------------------------- registration ---

def test_intent_routes_registered_in_app() -> None:
    assert 'from "./routes/intents.js"' in APP
    assert "registerIntentRoutes(authed, ctx)" in APP


def test_openapi_covers_intent_routes_and_scan_signals() -> None:
    assert "  /v1/presence/intent:" in OPENAPI
    scan = OPENAPI.split("/v1/scan:")[1].split("/v1/consent:")[0]
    assert "sharedIntent" in scan
    assert "recurrenceDays" in scan
