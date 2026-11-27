"""Batch 69 invariants — the WhatsApp channel (AMD-WA-01..06):

  members get WhatsApp as a third notification channel alongside realtime
  and push: a governed template catalogue behind a minimalism gate, the
  signed Cloud API webhook (raw-body HMAC, wamid-idempotent, keyword-only
  inbound — message text NEVER reaches the database), the opt-in ledger
  with verify-code proof of phone ownership (STOP always wins), and the
  notification leg that reserves a delivery BEFORE the network send so
  the dedupe key and the daily cap bite before a byte leaves.

These pins are static mirrors: the live behaviour is proven by
services/edge/test/whatsapp.test.ts (node --test) and the rehearsal's
phase 8h. What pytest guards is the batch's own contract:

  * the spec addendum carries all six AMD-WA entries and the footer
    records the batch;
  * migration 0039 pins the tables, the RLS posture (member reads own
    opt-in; events/inbound/deliveries definer-only), the NULL-safe GUC
    gates, and the DSAR 'whatsapp' block;
  * the edge contract module pins the vocabularies and the catalogue;
  * the webhook is registered OUTSIDE the authed scope with the raw-body
    parser scope; the member routes are INSIDE it;
  * the notification leg is wired into notifyUser and all three consent
    call sites; logs scrub phones; metrics count both surfaces;
  * deploy wiring: compose dev placeholders (echo documented compose-
    only), k8s optional secretKeyRefs with NO dev echo, OpenAPI paths.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0039_whatsapp.sql").read_text()
EDGE = ROOT / "services/edge"
WHATSAPP_TS = (EDGE / "src/whatsapp.ts").read_text()
ROUTES_TS = (EDGE / "src/routes/whatsapp.ts").read_text()


def test_addendum_records_batch_69() -> None:
    for req in ("AMD-WA-01", "AMD-WA-02", "AMD-WA-03", "AMD-WA-04", "AMD-WA-05", "AMD-WA-06"):
        assert req in ADDENDUM, req
    assert "AMD-WA-01..06 added alongside batch 69" in ADDENDUM
    assert "tests/test_batch69.py" in ADDENDUM
    assert "whatsapp.test.ts" in ADDENDUM


def test_migration_tables_and_vocabulary() -> None:
    for table in (
        "whatsapp_opt_ins",
        "whatsapp_opt_in_events",
        "whatsapp_inbound",
        "whatsapp_deliveries",
    ):
        assert f"CREATE TABLE {table}" in MIGRATION, table
        assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in MIGRATION, table
    # The same vocabularies the edge contract module pins.
    assert "'pending', 'active', 'stopped'" in MIGRATION
    assert "'stop', 'start', 'help', 'other'" in MIGRATION
    assert "'pending', 'sent', 'delivered', 'read', 'failed'" in MIGRATION
    for event in (
        "link_requested", "verified", "verify_failed", "unlinked",
        "stopped_inbound", "resumed_inbound", "help_requested",
    ):
        assert event in MIGRATION, event
    # Append-only guards on the receipt and event ledgers.
    assert "whatsapp_inbound is append-only" in MIGRATION
    assert "whatsapp_opt_in_events is append-only" in MIGRATION


def test_migration_gates_are_null_safe() -> None:
    # The batch-63 hardening: an unset custom GUC reads NULL, and
    # `IF NOT (NULL)` skips a refusal — every WhatsApp gate uses the
    # IS [NOT] DISTINCT FROM form.
    assert MIGRATION.count(
        "current_setting('app.whatsapp_callback', true) IS DISTINCT FROM 'on'"
    ) >= 5  # inbound, status, target, record, finalize
    assert "current_setting('app.user_id', true)" not in MIGRATION.replace(
        "app_user()", ""), "member gates go through app_user() (NULL-safe)"
    assert "IF NOT (NULL" not in MIGRATION
    # The member surface: own row only, and only the opt-in table.
    assert "CREATE POLICY whatsapp_opt_ins_select_own" in MIGRATION
    assert "GRANT SELECT ON whatsapp_opt_ins TO presence_app" in MIGRATION
    assert "GRANT SELECT ON whatsapp_inbound" not in MIGRATION
    assert "GRANT SELECT ON whatsapp_deliveries" not in MIGRATION
    assert "GRANT SELECT ON whatsapp_opt_in_events" not in MIGRATION


def test_migration_definers_and_grants() -> None:
    for fn, sig in (
        ("whatsapp_link_phone", "(text, text, timestamptz, timestamptz)"),
        ("whatsapp_verify_code", "(text, timestamptz)"),
        ("whatsapp_unlink", "(timestamptz)"),
        ("whatsapp_apply_inbound", "(text, text, text, timestamptz)"),
        ("whatsapp_apply_status", "(text, text, text)"),
        ("whatsapp_dispatch_target", "(uuid)"),
        ("whatsapp_record_delivery", "(uuid, text, text, integer)"),
        ("whatsapp_finalize_delivery", "(uuid, text, text, boolean, text)"),
    ):
        assert f"CREATE OR REPLACE FUNCTION {fn}" in MIGRATION, fn
        assert f"REVOKE ALL ON FUNCTION {fn}{sig} FROM PUBLIC" in MIGRATION, fn
        assert f"GRANT EXECUTE ON FUNCTION {fn}{sig} TO presence_app" in MIGRATION, fn
    # The reservation pattern: the row lands pending BEFORE the send.
    record = MIGRATION.index("CREATE OR REPLACE FUNCTION whatsapp_record_delivery")
    finalize = MIGRATION.index("CREATE OR REPLACE FUNCTION whatsapp_finalize_delivery")
    assert record < finalize
    assert "ON CONFLICT (dedupe_key) DO NOTHING" in MIGRATION
    assert "ON CONFLICT (wamid) DO NOTHING" in MIGRATION
    # STOP always wins; START resumes only a stopped, once-verified row.
    assert "WHERE user_id = v_uid AND state <> 'stopped'" in MIGRATION
    assert "v_state = 'stopped' AND v_verified IS NOT NULL" in MIGRATION


def test_dsar_export_gains_whatsapp_block() -> None:
    assert "CREATE OR REPLACE FUNCTION dsar_export" in MIGRATION
    assert "'whatsapp'" in MIGRATION
    # The export is built from the channel's own tables.
    assert "FROM whatsapp_opt_ins w WHERE w.user_id = uid" in MIGRATION
    assert "FROM whatsapp_opt_in_events e" in MIGRATION
    # kycSessions remains (the 0038 body is extended, not replaced).
    assert "'kycSessions'" in MIGRATION


def test_regex_bounds_fit_postgres_re_dup_max() -> None:
    # PostgreSQL ARE caps repetition counts at 255 (RE_DUP_MAX): the wamid
    # bound is {8,255} in BOTH the SQL CHECK and the TS constant — a
    # {8,256} pair compiles in Node and fails at the database.
    assert "{8,256}" not in MIGRATION
    assert "{8,256}" not in WHATSAPP_TS
    assert MIGRATION.count("{8,255}") >= 3
    assert re.search(r"WAMID_RE = /\^\[A-Za-z0-9\._=-\]\{8,255\}\$/", WHATSAPP_TS)


def test_edge_contract_module_pins() -> None:
    assert 'E164_RE = /^\\+[1-9]\\d{7,14}$/' in WHATSAPP_TS
    for template in (
        "presence_verify_code", "presence_match_notice", "presence_pair_opened",
        "presence_announcement", "presence_safety",
    ):
        assert template in WHATSAPP_TS, template
    assert "WHATSAPP_DAILY_CAP = 20" in WHATSAPP_TS
    assert "WHATSAPP_VERIFY_CODE_TTL_MS = 600_000" in WHATSAPP_TS
    assert "WHATSAPP_VERIFY_MAX_ATTEMPTS = 5" in WHATSAPP_TS
    assert "WHATSAPP_RESEND_COOLDOWN_MS = 60_000" in WHATSAPP_TS
    assert 'WHATSAPP_GRAPH_VERSION = "v21.0"' in WHATSAPP_TS
    # No wallet template: the catalogue stays narrow.
    assert "wallet_notice" not in WHATSAPP_TS
    assert "presence_wallet" not in WHATSAPP_TS


def test_webhook_is_outside_authed_with_raw_body() -> None:
    app_ts = (EDGE / "src/app.ts").read_text()
    webhook = app_ts.index("registerWhatsAppWebhookRoutes(app, ctx)")
    authed = app_ts.index("await app.register(async (authed)")
    member = app_ts.index("registerWhatsAppRoutes(authed, ctx)")
    assert webhook < authed < member
    # The signature is over the RAW body — the scope parses to a Buffer.
    assert 'parseAs: "buffer"' in ROUTES_TS
    assert 'scope.addContentTypeParser' in ROUTES_TS
    assert 'req.headers["x-hub-signature-256"]' in ROUTES_TS
    # Env-unset answers 503 on both the handshake and the intake.
    assert "WHATSAPP_VERIFY_TOKEN" in ROUTES_TS
    assert "WHATSAPP_APP_SECRET" in ROUTES_TS
    assert ROUTES_TS.count('code(503)') >= 2
    # Accepted intakes always answer 200 (Meta redelivers on non-2xx).
    assert "return reply.send({ ok: true })" in ROUTES_TS


def test_member_routes_contract() -> None:
    assert 'app.get("/v1/whatsapp"' in ROUTES_TS
    assert 'app.post(\n    "/v1/whatsapp/link"' in ROUTES_TS
    assert 'app.post(\n    "/v1/whatsapp/verify"' in ROUTES_TS
    assert 'app.delete("/v1/whatsapp/link"' in ROUTES_TS
    # The member's own phone is masked even in their own projection.
    assert "maskPhone(row.phone_e164)" in ROUTES_TS
    # devCode only ever under the compose echo flag.
    assert 'process.env.WHATSAPP_DEV_ECHO === "1"' in ROUTES_TS
    # Verify outcomes map to the pinned statuses.
    for code in ("400", "409", "410", "429"):
        assert f"code({code})" in ROUTES_TS, code


def test_notification_leg_is_wired() -> None:
    notifications = (EDGE / "src/notifications.ts").read_text()
    consent = (EDGE / "src/routes/consent.ts").read_text()
    dispatch = (EDGE / "src/whatsappDispatch.ts").read_text()
    assert "dispatchWhatsAppNotice" in notifications
    # notifyUser: inside the push branch, fire-and-forget.
    assert notifications.count("dispatchWhatsAppNotice") >= 2  # import + call
    # All three consent call sites: mutual (x2 members), nudged, open.
    assert consent.count("dispatchWhatsAppNotice(ctx,") == 4
    assert '"matches", "mutual"' in consent
    assert '"nudges", "nudged"' in consent
    assert '"matches", "open"' in consent
    # The leg runs under the machine GUC and reserves before sending.
    assert "withWhatsAppCallback" in dispatch
    assert dispatch.index("whatsapp_record_delivery") < dispatch.index("await sender(")
    assert "whatsapp_finalize_delivery" in dispatch
    auth = (EDGE / "src/auth.ts").read_text()
    assert "withWhatsAppCallback" in auth
    assert "app.whatsapp_callback" in auth


def test_privacy_and_observability_wiring() -> None:
    logscrub = (EDGE / "src/logscrub.ts").read_text()
    assert "PHONE_KEY_RE" in logscrub
    assert "PHONE_RE" in logscrub
    assert '"[phone]"' in logscrub
    metrics = (EDGE / "src/metrics.ts").read_text()
    assert "presence_whatsapp_webhook_results_total" in metrics
    assert "presence_whatsapp_leg_results_total" in metrics


def test_deploy_wiring() -> None:
    compose = (ROOT / "deploy/docker-compose.yml").read_text()
    k8s = (ROOT / "deploy/k8s/edge.yaml").read_text()
    for var in (
        "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN",
        "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID",
    ):
        assert var in compose, var
        assert var in k8s, var
        # k8s: optional secretKeyRef, never a hardcoded value.
        assert f"key: {var}, optional: true" in k8s, var
    # The echo sender is compose-only BY CONSTRUCTION: k8s may explain
    # its absence in a comment but never carries the env entry itself.
    assert "WHATSAPP_DEV_ECHO" in compose
    assert "- name: WHATSAPP_DEV_ECHO" not in k8s


def test_openapi_documents_the_channel() -> None:
    openapi = (ROOT / "docs/api/openapi.yaml").read_text()
    assert "/v1/webhooks/whatsapp:" in openapi
    assert "/v1/whatsapp:" in openapi
    assert "/v1/whatsapp/link:" in openapi
    assert "/v1/whatsapp/verify:" in openapi
    assert "x-hub-signature-256" in openapi
    assert "hub.verify_token" in openapi
    # The webhook operations are explicitly unauthenticated.
    wa_section = openapi[openapi.index("/v1/webhooks/whatsapp:"):]
    wa_section = wa_section[: wa_section.index("components:")]
    assert wa_section.count("security: []") == 2
