"""Batch 30 — TECH-18 Go service cores.

The ARC language allocation (Go for presence/venue/consent) is delivered as
verified service cores alongside the Rust match core. These invariants pin
every constant, regular expression, transition and lifecycle rule in the Go
ports to the TS sources and SQL migrations they migrate from — the same
discipline that pins match-core to the shared golden corpus.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PRESENCE_VELOCITY_GO = (ROOT / "services" / "presence-go" / "velocity.go").read_text()
PRESENCE_BUDGET_GO = (ROOT / "services" / "presence-go" / "budget.go").read_text()
PRESENCE_KEYS_GO = (ROOT / "services" / "presence-go" / "keys.go").read_text()
VENUE_AGGREGATE_GO = (ROOT / "services" / "venue-go" / "aggregate.go").read_text()
VENUE_SCHEDULE_GO = (ROOT / "services" / "venue-go" / "schedule.go").read_text()
VENUE_PARTNER_GO = (ROOT / "services" / "venue-go" / "partner.go").read_text()
CONSENT_STATE_GO = (ROOT / "services" / "consent-go" / "statemachine.go").read_text()
CONSENT_LIFECYCLE_GO = (ROOT / "services" / "consent-go" / "lifecycle.go").read_text()

TS_VELOCITY = (ROOT / "services" / "edge" / "src" / "velocity.ts").read_text()
TS_BUDGET = (ROOT / "services" / "edge" / "src" / "budget.ts").read_text()
TS_AGGREGATE = (ROOT / "services" / "edge" / "src" / "aggregate.ts").read_text()
TS_CONTEXT = (ROOT / "services" / "edge" / "src" / "context.ts").read_text()
TS_LIFECYCLE = (ROOT / "services" / "edge" / "src" / "lifecycle.ts").read_text()
MIGRATION_0001 = (ROOT / "db" / "migrations" / "0001_init.sql").read_text()
MIGRATION_0020 = (ROOT / "db" / "migrations" / "0020_venue_registry.sql").read_text()
CI = (ROOT / ".github" / "workflows" / "ci.yml").read_text()

GO_MODULES = ["presence-go", "venue-go", "consent-go"]


# ---------------- presence-go ↔ TS edge ----------------

def test_velocity_edge_km_parity() -> None:
    for res, km in ((9, "0.1744"), (10, "0.0659"), (11, "0.0249")):
        assert f"{res}: {km}" in TS_VELOCITY, f"TS EDGE_KM missing res {res}"
        assert f"{res}: {km}" in PRESENCE_VELOCITY_GO, f"Go EdgeKM missing res {res}"


def test_velocity_constants_parity() -> None:
    assert "MAX_PLAUSIBLE_KMH = 500" in TS_VELOCITY
    assert "MaxPlausibleKmh = 500.0" in PRESENCE_VELOCITY_GO
    assert "SCAN_HOURLY_MAX = 200" in TS_VELOCITY
    assert "ScanHourlyMax = 200" in PRESENCE_VELOCITY_GO
    assert "WAVE_DAILY_MAX = 20" in TS_VELOCITY
    assert "WaveDailyMax  = 20" in PRESENCE_VELOCITY_GO
    # Strictly-greater comparison in both ports.
    assert "> MAX_PLAUSIBLE_KMH" in TS_VELOCITY
    assert "> MaxPlausibleKmh" in PRESENCE_VELOCITY_GO


def test_budget_ladder_parity() -> None:
    assert "BUDGET_BUSY_MIN_POP = 25" in TS_BUDGET
    assert "BudgetBusyMinPop  = 25" in PRESENCE_BUDGET_GO
    assert "BUDGET_CROWD_MIN_POP = 100" in TS_BUDGET
    assert "BudgetCrowdMinPop = 100" in PRESENCE_BUDGET_GO
    for limit, window in ((1, "86_400"), (2, "3_600"), (3, "3_600")):
        assert f"limit: {limit}, windowSeconds: {window}" in TS_BUDGET
        assert f"Limit: {limit}" in PRESENCE_BUDGET_GO
        assert f"{window} * time.Second" in PRESENCE_BUDGET_GO


def test_key_model_parity() -> None:
    # Canonical ordering, prefixes and TTLs identical in both implementations.
    assert "SUPPRESSION_TTL_S = 600" in TS_CONTEXT
    assert "SuppressionTTL = 600 * time.Second" in PRESENCE_KEYS_GO
    assert "ROTATION_TTL_S = 604_800" in TS_CONTEXT
    assert "RotationTTL = 604_800 * time.Second" in PRESENCE_KEYS_GO
    for prefix in ("suppress", "rotate", "block"):
        assert f'"{prefix}:' in PRESENCE_KEYS_GO or f'"{prefix}:"' in PRESENCE_KEYS_GO
    assert "suppress:${a}:${b}" in TS_CONTEXT and "rotate:${a}:${b}" in TS_CONTEXT
    assert 'return "suppress:" + lo + ":" + hi' in PRESENCE_KEYS_GO
    assert 'return "rotate:" + lo + ":" + hi' in PRESENCE_KEYS_GO
    assert 'return "block:" + lo + ":" + hi' in PRESENCE_KEYS_GO
    # FR-16: 128-bit hex session ids in both.
    assert "randomBytes(16)" in TS_CONTEXT
    assert "var buf [16]byte" in PRESENCE_KEYS_GO
    assert "presence:session:" in TS_CONTEXT and '"presence:session:" + sessionID' in PRESENCE_KEYS_GO


# ---------------- venue-go ↔ TS edge + migration 0020 ----------------

def test_k_min_parity() -> None:
    assert "K_MIN = 11" in TS_AGGREGATE
    assert "KMin = 11" in VENUE_AGGREGATE_GO


def test_schedule_regex_parity() -> None:
    day_re = r"^(mon|tue|wed|thu|fri|sat|sun)$"
    time_re = r"^([01][0-9]|2[0-3]):[0-5][0-9]$"
    # The SQL CHECK is the source of truth; the Go port must use it verbatim.
    assert day_re in MIGRATION_0020
    assert time_re in MIGRATION_0020
    assert f"`{day_re}`" in VENUE_SCHEDULE_GO
    assert f"`{time_re}`" in VENUE_SCHEDULE_GO
    # NULL schedules pass the SQL check; the Go port mirrors that.
    assert "s IS NULL OR" in MIGRATION_0020
    assert "if s == nil {\n\t\treturn true\n\t}" in VENUE_SCHEDULE_GO


def test_partner_status_set_parity() -> None:
    m = re.search(r"partner_status IN \(([^)]+)\)", MIGRATION_0020)
    assert m, "partner_status CHECK not found in migration 0020"
    sql_statuses = {s.strip().strip("'") for s in m.group(1).split(",")}
    go_statuses = set(re.findall(r'Status\w+\s+PartnerStatus = "(\w+)"', VENUE_PARTNER_GO))
    assert sql_statuses == go_statuses == {"prospect", "active", "suspended", "offboarded"}
    # SyncActive mirrors the trigger: derived active, stamp on entering
    # suspended, clear on leaving, keep while staying.
    assert "NEW.active := (NEW.partner_status = 'active')" in MIGRATION_0020
    assert "active = newStatus == StatusActive" in VENUE_PARTNER_GO
    assert "NEW.suspended_at := now()" in MIGRATION_0020
    assert "NEW.suspended_at := NULL" in MIGRATION_0020


# ---------------- consent-go ↔ migration 0001 + TS lifecycle ----------------

def test_consent_transition_table_parity() -> None:
    # The SQL function is the source of truth for every legal transition.
    for arm in (
        "WHEN 'DETECTED'  THEN to_state IN ('NUDGED','EXPRESSED')",
        "WHEN 'NUDGED'    THEN to_state = 'EXPRESSED'",
        "WHEN 'EXPRESSED' THEN to_state = 'MUTUAL'",
        "WHEN 'MUTUAL'    THEN to_state = 'OPEN'",
        "WHEN NULL        THEN to_state = 'DETECTED'",
    ):
        assert arm in MIGRATION_0001, f"missing transition arm: {arm}"
    for arm in (
        "if from == nil {\n\t\treturn to == Detected\n\t}",
        "case Detected:\n\t\treturn to == Nudged || to == Expressed",
        "case Nudged:\n\t\treturn to == Expressed",
        "case Expressed:\n\t\treturn to == Mutual",
        "case Mutual:\n\t\treturn to == Open",
    ):
        assert arm in CONSENT_STATE_GO, f"missing Go transition arm: {arm}"


def test_lifecycle_constants_parity() -> None:
    assert "OFFER_TTL_MS = 30 * 60 * 1000" in TS_LIFECYCLE
    assert "OfferTTL        = 30 * time.Minute" in CONSENT_LIFECYCLE_GO
    assert "CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000" in TS_LIFECYCLE
    assert "ConversationTTL = 24 * time.Hour" in CONSENT_LIFECYCLE_GO
    assert "PURGE_AFTER_CLOSE_MS = 24 * 60 * 60 * 1000" in TS_LIFECYCLE
    assert "PurgeAfterClose = 24 * time.Hour" in CONSENT_LIFECYCLE_GO
    assert "LIFECYCLE_TICK_MS = 60 * 1000" in TS_LIFECYCLE
    assert "LifecycleTick   = time.Minute" in CONSENT_LIFECYCLE_GO


def test_mask_close_reason_parity() -> None:
    # FR-32 silent decline + FR-34 invisible blocks, identical in both ports.
    assert 'if (reason === "blocked") return null;' in TS_LIFECYCLE
    assert 'if (reason === "declined") return "expired";' in TS_LIFECYCLE
    assert "case ReasonBlocked:\n\t\treturn nil" in CONSENT_LIFECYCLE_GO
    assert "case ReasonDeclined:\n\t\tmasked := ReasonExpired\n\t\treturn &masked" in CONSENT_LIFECYCLE_GO


def test_is_offer_live_parity() -> None:
    ts_arm = 'state !== "OPEN" && closedAt == null && (expiresAt == null || new Date(expiresAt as string) > new Date())'
    assert ts_arm in TS_LIFECYCLE
    assert "state != Open && closedAt == nil && (expiresAt == nil || expiresAt.After(now))" in CONSENT_LIFECYCLE_GO


# ---------------- modules, CI and docs ----------------

def test_go_modules_stdlib_only() -> None:
    for m in GO_MODULES:
        mod = (ROOT / "services" / m / "go.mod").read_text()
        assert f"module github.com/munisp/presence/services/{m}" in mod
        assert "require" not in mod, f"{m} must stay stdlib-only"
        assert re.search(r"^go 1\.27$", mod, re.M), f"{m} must target Go 1.27"


def test_go_services_ci_job() -> None:
    assert "go-services:" in CI
    assert CI.count("go vet ./... && go test ./...") >= 3
    assert CI.count("gofmt -l . | (! grep .)") >= 3
    for m in GO_MODULES:
        assert f"working-directory: services/{m}" in CI


def test_readmes_document_contract_and_serving() -> None:
    for m in GO_MODULES:
        readme = (ROOT / "services" / m / "README.md").read_text()
        assert "TECH-18" in readme
        assert "serving stand-in" in readme
        assert "go vet ./... && go test ./..." in readme
