"""Batch 63 invariants — OpenKYC verification pipeline + next-generation
liveness (SRS Addendum 001, AMD-KYC-06..10):

  AMD-KYC-06  services/openkyc: the in-house verification provider —
              PaddleOCR (text), Docling (structure), a VLM (semantic
              authenticity) behind one conformance interface, plus
              deterministic reference engines; never writes OLTP.
  AMD-KYC-07  next-generation liveness: a server-issued randomized
              challenge (3 of 5 actions, shuffled, 4 s windows), a
              single-use signed upload token, and a six-signal fusion
              (challenge response, rPPG, moire, depth, rigidity,
              injection) with pinned weights.
  AMD-KYC-08  kyc_sessions: the verification ledger — challenge digest,
              state machine, DERIVED FACTS ONLY; a verified row without
              over-18/credential-valid is unrepresentable; events
              append-only; one open session per applicant.
  AMD-KYC-09  verdict composition: complete_kyc_session under
              app.kyc_callback via the HMAC webhook (freshness before
              signature), digest re-verification, the legal
              rejected -> pending -> verified walk, review routing to
              the AMD-ONB-06 queue, idempotent replays.
  AMD-KYC-10  capture lifecycle: captures never reach the platform API,
              are purged in the pipeline before the verdict leaves, and
              the purge lands as a ledger receipt.

The 306-requirement ledger stays untouched; amendments carry AMD-
identifiers in docs/spec/srs-addendum-001.md.
"""

from __future__ import annotations

import re

import yaml
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / "services/edge"
OPENKYC = ROOT / "services/openkyc"

ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0038_openkyc.sql").read_text()
EDGE_MODULE = (EDGE / "src/kycVerification.ts").read_text()
EDGE_ROUTES = (EDGE / "src/routes/kycVerification.ts").read_text()
EDGE_AUTH = (EDGE / "src/auth.ts").read_text()
EDGE_METRICS = (EDGE / "src/metrics.ts").read_text()
EDGE_APP = (EDGE / "src/app.ts").read_text()
CLIENT = (ROOT / "client/src/presence/kycCapture.ts").read_text()
COPY = (ROOT / "client/src/presence/copyRegistry.ts").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
OPS_DOC = (ROOT / "docs/ops/openkyc-verification.md").read_text()
REHEARSAL = (ROOT / "scripts/rehearse_full_chain.py").read_text()
PY_LIVENESS = (OPENKYC / "openkyc/liveness.py").read_text()
PY_PIPELINE = (OPENKYC / "openkyc/pipeline.py").read_text()
PY_ENGINES = (OPENKYC / "openkyc/engines.py").read_text()
PY_CALLBACK = (OPENKYC / "openkyc/callback.py").read_text()
PY_SERVER = (OPENKYC / "openkyc/server.py").read_text()

PUBLIC_DEFINERS = (
    "issue_kyc_session", "complete_kyc_session", "expire_kyc_sessions",
    "kyc_session_queue", "my_kyc_session",
)


def _fn_body(src: str, name: str) -> str:
    start = src.index(f"CREATE OR REPLACE FUNCTION {name}(")
    end = src.index("END $$;", start)
    return src[start:end]


# --------------------------------------------------------------- addendum ---

def test_addendum_carries_the_five_amendments():
    assert "## AMD-KYC-06..10" in ADDENDUM
    for amd in ("AMD-KYC-06", "AMD-KYC-07", "AMD-KYC-08",
                "AMD-KYC-09", "AMD-KYC-10"):
        assert f"**{amd} " in ADDENDUM, amd
    assert "AMD-KYC-06..10 added alongside batch 63" in ADDENDUM
    assert "tests/test_batch63.py` pins the OpenKYC verification pipeline" in ADDENDUM


def test_addendum_pins_the_protocol_numbers():
    # 3 of 5 actions, 4 s windows, 600 s TTL, six fused signals, the
    # 0.80/0.50 thresholds, the 300 s callback freshness.
    for needle in ("3 of 5", "4,000 ms", "600 s", "0.30", "0.20", "0.15",
                   "0.10", "300 s"):
        assert needle in ADDENDUM, needle


# -------------------------------------------------------------- migration ---

def test_session_ledger_contract():
    assert "CREATE TABLE kyc_sessions" in MIGRATION
    assert "CREATE TABLE kyc_session_events" in MIGRATION
    assert "ALTER TABLE kyc_sessions ENABLE ROW LEVEL SECURITY" in MIGRATION
    assert "ALTER TABLE kyc_session_events ENABLE ROW LEVEL SECURITY" in MIGRATION
    assert re.search(
        r"CHECK \(state IN \('issued', 'review', 'verified',\s*"
        r"'rejected', 'expired'\)\)", MIGRATION)
    # The neutral credential vocabulary.
    for kind in ("'id_card'", "'driving_permit'", "'travel_document'"):
        assert kind in MIGRATION, kind
    # The challenge digest is a pinned sha256 hex.
    assert "'^[0-9a-f]{64}$'" in MIGRATION
    # One open session per applicant.
    assert re.search(r"CREATE UNIQUE INDEX kyc_sessions_one_open\s+"
                     r"ON kyc_sessions \(applicant\)"
                     r" WHERE state IN \('issued', 'review'\)", MIGRATION)


def test_minimisation_is_by_construction():
    # AMD-KYC-02/08: a verified row REQUIRES the over-18 and validity
    # facts; decided rows carry the full derived set; open rows none.
    assert ("CHECK (state <> 'verified' OR (over_18 AND credential_valid))"
            in MIGRATION)
    assert "CHECK (state IN ('verified', 'rejected', 'review')" in MIGRATION
    assert "CHECK (state NOT IN ('verified', 'rejected', 'review')" in MIGRATION
    # The column set is exactly the pinned derived-facts set. (The block
    # closes at a line-start paren — a comment carries a literal ');'.)
    columns = re.findall(
        r"^    (\w+)\s+(?:uuid|text|boolean|numeric|timestamptz)",
        MIGRATION.split("CREATE TABLE kyc_sessions", 1)[1].split("\n);", 1)[0],
        re.M)
    assert set(columns) == {
        "session_id", "applicant", "state", "challenge_digest",
        "issued_at", "expires_at", "decided_at", "credential_kind",
        "over_18", "credential_valid", "authenticity_score",
        "liveness_score", "provider_ref"}, columns


def test_events_append_only():
    assert "kyc_session_events is append-only (AMD-KYC-08)" in MIGRATION
    assert re.search(r"CREATE TRIGGER kyc_session_events_guard\s+"
                     r"BEFORE UPDATE OR DELETE", MIGRATION)


def test_issue_definer_contract():
    body = _fn_body(MIGRATION, "issue_kyc_session")
    assert "SECURITY DEFINER" in body
    assert "v_state NOT IN ('pending', 'rejected')" in body
    for outcome in ("'issued'", "'already_open'", "'not_requestable'",
                    "'invalid_challenge'", "'invalid_ttl'", "'forbidden'"):
        assert outcome in body, outcome
    assert "WHEN unique_violation" in body
    assert "'kyc.session.issued'" in body


def test_complete_definer_contract():
    body = _fn_body(MIGRATION, "complete_kyc_session")
    # The callback GUC is mandatory; the digest is re-verified. The gate is
    # NULL-safe: an unset GUC reads NULL and `NULL <> 'on'` would skip the
    # refusal (the batch-63 rehearsal finding).
    assert "current_setting('app.kyc_callback', true) IS DISTINCT FROM 'on'" \
        in body
    assert "v_session.challenge_digest <> lower(p_challenge_digest)" in body
    # The purge receipt precedes the verdict.
    assert body.index("'capture_purged'") < body.index("record_kyc_decision")
    # The legal walk for a previously rejected member.
    assert "'pending'" in body and "'openkyc-pipeline'" in body
    # The review path routes to the manual queue and does not auto-decide.
    assert "SET kyc_review_requested_at = now()" in body
    assert "'review_routed'" in body
    # Idempotent replay.
    assert "'replayed'" in body
    assert "'challenge_mismatch'" in body


def test_guc_gates_are_null_safe():
    """The rehearsal caught the NULL-semantics hole: an unset custom GUC
    reads NULL and `IF NOT (NULL) THEN` skips a refusal. 0038 re-pins the
    four console helpers and record_kyc_decision to NULL-safe forms."""
    # The four console helpers are redefined IS NOT DISTINCT FROM 'on' —
    # unset (or anything but 'on') is FALSE, never NULL.
    for helper, guc in (("app_moderator", "app.moderator"),
                        ("app_taxonomist", "app.taxonomist"),
                        ("app_analyst", "app.analyst"),
                        ("app_venue_ops", "app.venue_ops")):
        block = MIGRATION.split(
            f"CREATE OR REPLACE FUNCTION {helper}() RETURNS boolean", 1)[1]
        block = block.split("$$;", 1)[0]
        assert f"current_setting('{guc}', true) IS NOT DISTINCT FROM 'on'" \
            in block, helper
    # record_kyc_decision is redefined with the NULL-safe gate, carrying
    # the 0037 body (the AMD-ONB-06 review-stamp clear included).
    decision = _fn_body(MIGRATION, "record_kyc_decision")
    assert ("current_setting('app.kyc_callback', true)"
            " IS NOT DISTINCT FROM 'on'") in decision
    assert "kyc_review_requested_at = NULL" in decision
    assert "'illegal_transition'" in decision
    # The unsafe gate shape is gone from the live (chain-final) definitions:
    # 0038 is the last migration to define either gated function.
    import glob
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    chain = sorted(glob.glob(os.path.join(here, "..", "db", "migrations",
                                          "*.sql")))
    for fn in ("record_kyc_decision(", "complete_kyc_session("):
        last = max(p for p in chain
                   if f"CREATE OR REPLACE FUNCTION {fn}"
                   in open(p).read())
        text = open(last).read()
        assert "current_setting('app.kyc_callback', true) = 'on'" \
            not in text, last
        assert "current_setting('app.kyc_callback', true) <> 'on'" \
            not in text, last


def test_housekeeping_and_read_models():
    body = _fn_body(MIGRATION, "expire_kyc_sessions")
    assert "state = 'issued' AND expires_at <= now()" in body
    # kyc_session_queue and my_kyc_session are LANGUAGE sql — they end at
    # "$$;", not "END $$;".
    queue = MIGRATION.split("CREATE OR REPLACE FUNCTION kyc_session_queue(", 1)[1]
    queue = queue.split("$$;", 1)[0]
    assert "s.state = 'review' AND app_moderator()" in queue
    mine = MIGRATION.split("CREATE OR REPLACE FUNCTION my_kyc_session(", 1)[1]
    mine = mine.split("$$;", 1)[0]
    # The member read model projects state and timestamps — never scores.
    assert "authenticity_score" not in mine and "liveness_score" not in mine


def test_dsar_export_gains_the_session_record():
    start = MIGRATION.index("CREATE OR REPLACE FUNCTION dsar_export(")
    body = MIGRATION[start:MIGRATION.index("$$;", start)]
    assert "'kycSessions'" in body
    for key in ("'sessionId'", "'state'", "'credentialKind'", "'over18'",
                "'credentialValid'", "'authenticityScore'", "'livenessScore'"):
        assert key in body, key
    # The b62 anchors survive.
    assert "'onboardingApplications'" in body
    assert "'kycReviewRequestedAt'" in body


def test_grants_and_revokes():
    for fn in PUBLIC_DEFINERS:
        assert re.search(rf"REVOKE ALL ON FUNCTION {fn}\(", MIGRATION), fn
        assert re.search(rf"GRANT EXECUTE ON FUNCTION {fn}\(", MIGRATION), fn
    assert "GRANT SELECT ON kyc_sessions TO presence_app" in MIGRATION
    assert "GRANT SELECT ON kyc_session_events TO presence_app" in MIGRATION
    # The events guard trigger function is never executable by the app.
    assert "REVOKE ALL ON FUNCTION kyc_session_events_guard() FROM PUBLIC" in MIGRATION
    assert "GRANT EXECUTE ON FUNCTION kyc_session_events_guard" not in MIGRATION


# ------------------------------------------------------------- edge layer ---

def test_edge_module_mirrors_the_protocol():
    for needle in ('"blink", "turn_left", "turn_right", "smile", "nod"',
                   "CHALLENGE_COUNT = 3", "ACTION_WINDOW_MS = 4000",
                   "SESSION_TTL_SECONDS = 600", "ACCEPT_MIN = 0.8",
                   "REVIEW_FLOOR = 0.5", "KYC_SIGNATURE_SKEW_S = 300"):
        assert needle in EDGE_MODULE, needle
    assert "challengeDigest" in EDGE_MODULE
    assert "challengeToken" in EDGE_MODULE
    assert "verdictSignaturePayload" in EDGE_MODULE
    assert "timingSafeEqual" in EDGE_MODULE


def test_edge_and_pipeline_sign_the_same_canonical_order():
    # The callback field order is cross-pinned edge <-> pipeline.
    assert re.search(r"return \[\s*at,\s*verdict\.sessionId,\s*"
                     r"verdict\.challengeDigest,\s*verdict\.outcome,\s*"
                     r"verdict\.authenticityScore\.toFixed\(4\),\s*"
                     r"verdict\.livenessScore\.toFixed\(4\),\s*"
                     r"verdict\.providerRef,\s*\]\.join", EDGE_MODULE)
    assert re.search(r'CALLBACK_FIELD_ORDER = \(\s*"at",\s*"sessionId",\s*'
                     r'"challengeDigest",\s*"outcome",\s*"authenticityScore",\s*'
                     r'"livenessScore",\s*"providerRef",\s*\)', PY_PIPELINE)


def test_edge_routes_contract():
    for route in ('"/v1/identity/kyc/session"', '"/v1/moderation/kyc-sessions"',
                  '"/v1/webhooks/kyc-verdict"'):
        assert route in EDGE_ROUTES, route
    # Session issue refuses BEFORE issuing when the challenge key is unset.
    assert "KYC_CHALLENGE_SECRET" in EDGE_ROUTES
    assert "verification not configured (AMD-KYC-09)" in EDGE_ROUTES
    # The webhook: unconfigured -> 503, freshness before signature.
    assert "KYC_VERDICT_SECRET" in EDGE_ROUTES
    assert "verdictTimestampFresh" in EDGE_ROUTES
    assert "withKycCallback" in EDGE_ROUTES
    assert "presence_kyc_webhook_results_total" in EDGE_METRICS
    # The auth helper exists and sets ONLY the callback GUC (no rail).
    assert "export async function withKycCallback" in EDGE_AUTH
    helper = EDGE_AUTH.split("export async function withKycCallback", 1)[1]
    assert "app.kyc_callback" in helper.split("}", 1)[0]
    # Registration: webhook outside the authed scope, member routes inside.
    assert "registerKycWebhookRoute(app, ctx)" in EDGE_APP
    assert "registerKycVerificationRoutes(authed, ctx)" in EDGE_APP


def test_openapi_documents_the_four_paths():
    doc = yaml.safe_load(OPENAPI)
    for path in ("/v1/identity/kyc/session", "/v1/moderation/kyc-sessions",
                 "/v1/webhooks/kyc-verdict"):
        assert path in doc["paths"], path
    session = doc["paths"]["/v1/identity/kyc/session"]
    assert "post" in session and "get" in session
    webhook = doc["paths"]["/v1/webhooks/kyc-verdict"]["post"]
    headers = {p["name"] for p in webhook["parameters"] if "name" in p}
    assert {"x-kyc-timestamp", "x-kyc-signature"} <= headers
    # Every new mutating op documents Idempotency-Key.
    for ref in (session["post"], webhook):
        params = ref.get("parameters", [])
        assert any("IdempotencyKey" in str(p) for p in params)


# ----------------------------------------------------------- python service ---

def test_openkyc_service_structure():
    for module in ("__init__.py", "engines.py", "liveness.py", "pipeline.py",
                   "callback.py", "server.py"):
        assert (OPENKYC / "openkyc" / module).is_file(), module
    assert (OPENKYC / "Dockerfile").is_file()
    assert (OPENKYC / "README.md").is_file()
    # The three real engines plus the reference trio.
    for name in ("PaddleOcrTextEngine", "DoclingStructureEngine", "VlmSemanticEngine",
                 "ReferenceTextEngine", "ReferenceStructureEngine",
                 "ReferenceSemanticEngine"):
        assert f"class {name}" in PY_ENGINES, name
    # Fail-closed registry: real mode requires all three.
    assert 'OPENKYC_ENGINES", "reference"' in PY_ENGINES
    assert "raise RuntimeError" in PY_ENGINES
    # The server verifies the token before decoding a frame.
    assert PY_SERVER.index("verify_challenge_token") < PY_SERVER.index("b64decode")


def test_pipeline_thresholds_and_fields_cross_pinned():
    assert "ACCEPT_MIN = 0.80" in PY_PIPELINE
    assert "REVIEW_FLOOR = 0.50" in PY_PIPELINE
    assert "ACCEPT_MIN = 0.8" in CLIENT and "REVIEW_FLOOR = 0.5" in CLIENT
    # The verdict wire form is the same nine fields everywhere.
    assert re.search(r'VERDICT_FIELDS = \(\s*"sessionId",\s*"challengeDigest",\s*'
                     r'"outcome",\s*"credentialKind",\s*"over18",\s*'
                     r'"credentialValid",\s*"authenticityScore",\s*'
                     r'"livenessScore",\s*"providerRef",\s*\)', PY_PIPELINE)


def test_liveness_weights_cross_pinned():
    for needle in ('"challenge_response": 0.30', '"rppg": 0.20',
                   '"moire": 0.15', '"depth": 0.15', '"rigidity": 0.10',
                   '"injection": 0.10'):
        assert needle in PY_LIVENESS, needle


# ----------------------------------------------------------------- client ---

def test_client_module_mirrors():
    for needle in ('"blink", "turn_left", "turn_right", "smile", "nod"',
                   "CHALLENGE_COUNT = 3", "ACTION_WINDOW_MS = 4000",
                   "SESSION_TTL_SECONDS = 600"):
        assert needle in CLIENT, needle
    assert '"issued", "review", "verified", "rejected", "expired"' in CLIENT
    assert "capturePlan" in CLIENT and "sessionAction" in CLIENT
    assert "parseSessionIssue" in CLIENT and "parseSessionStatus" in CLIENT
    for action in ("blink", "turn_left", "turn_right", "smile", "nod"):
        assert f'"ui.kycCapture.action.{action}"' in COPY, action
    assert COPY.count('"ui.kycCapture.') >= 12


# ------------------------------------------------------------------ deploy ---

def test_deploy_wiring():
    assert "40_openkyc.sql" in COMPOSE and "0038_openkyc.sql" in COMPOSE
    assert "40_openkyc.sql" in K8S_README and "0038_openkyc.sql" in K8S_README
    assert re.search(r"  openkyc:\n    build: \.\./services/openkyc", COMPOSE)
    assert "EDGE_VERDICT_URL: http://edge:4000/v1/webhooks/kyc-verdict" in COMPOSE
    assert "KYC_CHALLENGE_SECRET" in COMPOSE and "KYC_VERDICT_SECRET" in COMPOSE
    assert "docs/ops/openkyc-verification.md"
    for needle in ("member journey", "presence_kyc_webhook_results_total",
                   "OPENKYC_ENGINES=real", "purge"):
        assert needle in OPS_DOC, needle


def test_rehearsal_covers_the_pipeline():
    assert "phase 8f: OpenKYC verification sessions" in REHEARSAL
    assert '"kyc_callback": "app.kyc_callback"' in REHEARSAL
    for check in ("ok_issue", "ok_already_open", "ok_verified_member_refused",
                  "ok_complete_needs_callback", "ok_challenge_mismatch",
                  "ok_verified_path", "ok_verdict_replay",
                  "ok_verified_requires_over18", "ok_failed_verdict_atomic",
                  "ok_rejected_path", "ok_walk_verified",
                  "ok_review_routed", "ok_review_manual_close",
                  "ok_expiry_sweep", "ok_late_verdict_refused",
                  "ok_event_order", "ok_events_guard",
                  "ok_minimisation_columns", "ok_dsar_kyc_sessions"):
        assert check in REHEARSAL, check


def test_rehearsal_covers_the_null_safe_gates():
    """Phase 8g proves the NULL-gate fix on a cold connection — the exact
    production case the placeholder persistence masked."""
    assert "phase 8g: NULL-safe GUC gates" in REHEARSAL
    assert "psycopg.connect(srv.get_uri(), autocommit=True)" in REHEARSAL
    for check in ("ok_helpers_false_not_null",
                  "ok_decision_needs_gate_cold",
                  "ok_cold_decision_noop",
                  "ok_complete_needs_callback_cold",
                  "ok_moderator_gate_cold",
                  "ok_venue_ops_gate_cold",
                  "ok_decision_needs_gate_warm"):
        assert check in REHEARSAL, check
