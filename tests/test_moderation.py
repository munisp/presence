#!/usr/bin/env python3
"""FR-52/53/54/55/57 acceptance criteria for the trust & moderation stack.

These tests pin the invariants that must hold no matter what the edge code
does: the suspension dimension enum and one-active-partial-unique index, the
report outcome vocabulary, the deterministic trust score, the handle mask
inside the group directory, the moderator GUC gate on every console route,
the never-message-content boundary, the FR-60 audit discipline, and the
silent-by-construction investigation removal.

Behavioural coverage of the parsers and quiet window lives in
services/edge/test/moderation.test.ts; route/contract coverage is enforced
globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_moderation.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0008_moderation.sql").read_text()
MOD_ROUTE = (ROOT / "services/edge/src/routes/moderation.ts").read_text()
CONSENT_ROUTE = (ROOT / "services/edge/src/routes/consent.ts").read_text()
ACCOUNT_ROUTE = (ROOT / "services/edge/src/routes/account.ts").read_text()
PRESENCE_ROUTE = (ROOT / "services/edge/src/routes/presence.ts").read_text()
AUTH = (ROOT / "services/edge/src/auth.ts").read_text()
APP = (ROOT / "services/edge/src/app.ts").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()

CONSOLE_ROUTES = [
    ("get", "/v1/moderation/queue"),
    ("get", "/v1/moderation/accounts/:userId"),
    ("post", "/v1/moderation/reports/:reportId/resolve"),
    ("post", "/v1/moderation/accounts/:userId/investigation-remove"),
    ("post", "/v1/moderation/accounts/:userId/investigation-restore"),
    ("post", "/v1/moderation/suspensions/:suspensionId/lift"),
    ("get", "/v1/moderation/appeals"),
    ("post", "/v1/moderation/appeals/:appealId/resolve"),
]


# ------------------------------------------------------------ FR-55 --------
# Independent suspension dimensions with one active suspension per pair.

def test_fr55_dimension_enum_is_exactly_three() -> None:
    assert re.search(
        r"CREATE TYPE suspension_dimension AS ENUM "
        r"\('attestation_key','handle','payment_instrument'\)",
        MIGRATION,
    )


def test_fr55_one_active_suspension_per_user_dimension() -> None:
    assert re.search(
        r"CREATE UNIQUE INDEX suspensions_one_active\s+ON suspensions \(user_id, dimension\) "
        r"WHERE lifted_at IS NULL",
        MIGRATION,
    )


def test_fr55_handle_suspension_masks_display_handle() -> None:
    fn = MIGRATION.split("CREATE OR REPLACE FUNCTION display_handle")[1].split("$$;")[0]
    assert "dimension = 'handle'" in fn
    assert "lifted_at IS NULL" in fn
    assert "THEN NULL" in fn, "suspended handle must disappear from display"


def test_fr55_group_directory_uses_the_mask() -> None:
    fn = MIGRATION.split("CREATE OR REPLACE FUNCTION group_member_directory")[1].split("$$;")[0]
    assert "display_handle(gm.user_id)" in fn


def test_fr55_attestation_suspension_gates_presence() -> None:
    assert "has_active_suspension" in PRESENCE_ROUTE
    assert "'attestation_key'" in PRESENCE_ROUTE
    block = PRESENCE_ROUTE.split("has_active_suspension")[1]
    assert "DISCOVERY_BLOCKED_ERROR" in block
    # The client hears the neutral discovery error — no response in the file
    # names a suspension.
    for err_arg in re.findall(r"reply\.code\(\d+\)\.send\(\{ error: ([^,}]+)", block):
        assert "suspend" not in err_arg.lower()


# ------------------------------------------------------------ FR-52 --------
# The trust score is deterministic, moderation-only, and clamped.

def test_fr52_trust_score_function_and_inputs() -> None:
    fn = MIGRATION.split("CREATE OR REPLACE FUNCTION trust_score")[1].split("END $$;")[0]
    assert "SECURITY DEFINER" in fn
    assert "0.50" in fn, "base score"
    assert "age_declared_at" in fn, "verification input"
    assert "interval '30 days'" in fn and "interval '180 days'" in fn, "age inputs"
    assert "outcome = 'actioned'" in fn and "outcome = 'dismissed'" in fn, "report outcomes"
    assert "greatest(0.0, least(1.0" in fn, "clamped to [0,1]"


def test_fr52_report_outcome_vocabulary() -> None:
    assert re.search(
        r"ADD COLUMN outcome text CHECK \(outcome IN \('actioned','dismissed'\)\)",
        MIGRATION,
    )


def test_fr52_queue_orders_by_trust() -> None:
    queue = MOD_ROUTE.split('"/v1/moderation/queue"')[1].split("reply.send")[0]
    assert "ORDER BY trust_score(r.reported) ASC" in queue
    assert "WHERE r.status <> 'closed'" in queue


# ------------------------------------------------------------ FR-53 --------
# Silent investigation removal plus the always-open appeal path.

def test_fr53_investigation_removal_columns_and_flag() -> None:
    assert "ADD COLUMN investigation_removed_at timestamptz" in MIGRATION
    assert "ADD COLUMN investigation_reason_code text" in MIGRATION


def test_fr53_one_open_appeal_per_account() -> None:
    assert re.search(
        r"CREATE UNIQUE INDEX appeals_one_open ON appeals \(user_id\) WHERE state = 'open'",
        MIGRATION,
    )


def test_fr53_removal_is_silent_by_construction() -> None:
    # The investigation-remove route must purge presence without publishing
    # any realtime event to the removed account.
    route = MOD_ROUTE.split('"/v1/moderation/accounts/:userId/investigation-remove"')[1]
    route = route.split('"/v1/moderation/accounts/:userId/investigation-restore"')[0]
    assert "purgePresence" in route
    assert "publishRealtime" not in route


def test_fr53_discovery_gate_includes_investigation_removal() -> None:
    gate = ACCOUNT_ROUTE.split("export async function isDiscoveryAllowed")[1]
    gate = gate.split("export const DISCOVERY_BLOCKED_ERROR")[0]
    assert "investigation_removed_at" in gate


def test_fr53_appeal_body_is_screened() -> None:
    route = MOD_ROUTE.split('"/v1/account/appeals"')[1]
    assert "screenText" in route
    assert "screeningErrorMessage" in route


def test_fr53_overturn_makes_the_user_whole() -> None:
    route = MOD_ROUTE.split('"/v1/moderation/appeals/:appealId/resolve"')[1]
    overturned = route.split('"overturned"')[1]
    assert "lifted_at = now()" in overturned, "overturn lifts the suspension"
    assert "investigation_removed_at = NULL" in overturned, "overturn clears the removal"


# ------------------------------------------------------------ FR-54 --------
# The console: workforce gate everywhere, moderator GUC, audit discipline,
# and the never-message-content boundary.

def test_fr54_every_console_route_requires_the_moderator_role() -> None:
    for method, path in CONSOLE_ROUTES:
        needle = f'app.{method}(\n    "{path}"'
        assert needle in MOD_ROUTE, f"route missing: {method} {path}"
        block = MOD_ROUTE.split(needle)[1].split("async (req, reply)")[0]
        assert "requireModerator" in block, f"requireModerator missing on {path}"


def test_fr54_console_queries_run_under_the_moderator_guc() -> None:
    assert "withModerator" in MOD_ROUTE
    assert 'withGuc(pool, "app.moderator", fn)' in AUTH, (
        "withModerator must run its transaction with the app.moderator GUC set"
    )
    assert "set_config('${guc}', 'on', true)" in AUTH
    assert "CREATE OR REPLACE FUNCTION app_moderator()" in MIGRATION


def test_fr54_moderation_policies_key_on_the_guc() -> None:
    for policy in [
        "reports_moderation_select",
        "reports_moderation_update",
        "suspensions_moderation_select",
        "suspensions_moderation_insert",
        "suspensions_moderation_update",
        "appeals_moderation_select",
        "appeals_moderation_update",
    ]:
        assert re.search(rf"CREATE POLICY {policy}", MIGRATION), f"policy missing: {policy}"
        block = MIGRATION.split(f"CREATE POLICY {policy}")[1].split(";")[0]
        assert "app_moderator()" in block, f"{policy} must key on app_moderator()"


def test_fr54_never_message_content() -> None:
    # Moderators act on metadata and aggregates — the console never reads
    # message storage. No query in the route file may reference the envelope
    # store; the only tolerated occurrence of the word is the design comment
    # that documents the boundary itself.
    for banned in ["FROM messages", "JOIN messages", "FROM message_envelopes",
                   "INTO messages", "screenEnvelope", "decrypt"]:
        assert banned not in MOD_ROUTE, f"{banned} must not appear in moderation routes"
    assert MOD_ROUTE.count("envelope") == 1, "only the boundary comment may mention envelopes"


def test_fr54_account_card_uses_aggregate_ledger_stats() -> None:
    assert "account_ledger_stats" in MOD_ROUTE
    fn = MIGRATION.split("CREATE OR REPLACE FUNCTION account_ledger_stats")[1].split("END $$;")[0]
    assert "IF NOT app_moderator() THEN RETURN NULL" in fn
    assert "jsonb_object_agg" in fn, "aggregate counts only"


def test_fr54_every_action_writes_the_audit_trail() -> None:
    for action in [
        "moderation.report.resolve",
        "moderation.investigation.remove",
        "moderation.investigation.restore",
        "moderation.suspension.lift",
        "moderation.appeal.resolve",
    ]:
        assert action in MOD_ROUTE, f"audit action missing: {action}"
    assert MOD_ROUTE.count("admin_audit_log") >= 5


def test_fr54_rls_enabled_on_new_tables() -> None:
    for table in ["suspensions", "appeals"]:
        assert re.search(
            rf"ALTER TABLE {table}\s+ENABLE ROW LEVEL SECURITY", MIGRATION
        ), f"RLS missing on {table}"


def test_fr54_function_grants_are_scoped() -> None:
    for fn in [
        "trust_score(uuid)",
        "display_handle(uuid)",
        "has_active_suspension(uuid, suspension_dimension)",
        "account_ledger_stats(uuid)",
    ]:
        assert f"REVOKE ALL ON FUNCTION {fn} FROM PUBLIC" in MIGRATION
        assert f"GRANT EXECUTE ON FUNCTION {fn} TO presence_app" in MIGRATION


# ------------------------------------------------------------ FR-57 --------
# Nudges: scarce, quiet, and identity-free.

def test_fr57_nudge_route_is_capped() -> None:
    route = CONSENT_ROUTE.split('"/v1/consent/:pairId/nudge"')[1]
    route = route.split('"/v1/consent/:pairId/open"')[0]
    assert "NUDGE_DAILY_MAX" in route
    assert "nudge:d:" in route, "daily counter key"
    assert "86400" in route, "UTC-day expiry"
    assert "429" in route


def test_fr57_nudge_respects_quiet_window_and_category() -> None:
    # FR-58: the gate is shouldNotify (category switch + quiet window in one).
    route = CONSENT_ROUTE.split('"/v1/consent/:pairId/nudge"')[1]
    route = route.split('"/v1/consent/:pairId/open"')[0]
    assert 'shouldNotify(recipientPrefs, "nudges")' in route
    assert "notification_prefs" in route


def test_fr57_nudge_event_carries_no_actor_identity() -> None:
    route = CONSENT_ROUTE.split('"/v1/consent/:pairId/nudge"')[1]
    route = route.split('"/v1/consent/:pairId/open"')[0]
    publish = route.split("publish(ctx, pairId,")[1].split(")")[0]
    assert '"nudged"' in publish
    assert "userId" not in publish and "actor" not in publish


def test_fr57_nudge_moves_detected_to_nudged() -> None:
    route = CONSENT_ROUTE.split('"/v1/consent/:pairId/nudge"')[1]
    route = route.split('"/v1/consent/:pairId/open"')[0]
    assert "'NUDGED'" in route
    assert "consent_ledger" in route


# ---------------------------------------------------------- registration ---
# The console is actually wired into the app and the contract.

def test_moderation_routes_registered_in_app() -> None:
    assert 'from "./routes/moderation.js"' in APP
    assert "registerModerationRoutes(authed, ctx)" in APP


def test_openapi_covers_every_new_route() -> None:
    for path in [
        "/v1/moderation/queue",
        "/v1/moderation/accounts/{userId}",
        "/v1/moderation/reports/{reportId}/resolve",
        "/v1/moderation/accounts/{userId}/investigation-remove",
        "/v1/moderation/accounts/{userId}/investigation-restore",
        "/v1/moderation/suspensions/{suspensionId}/lift",
        "/v1/moderation/appeals",
        "/v1/moderation/appeals/{appealId}/resolve",
        "/v1/account/appeals",
        "/v1/consent/{pairId}/nudge",
    ]:
        assert f"  {path}:" in OPENAPI, f"openapi path missing: {path}"
