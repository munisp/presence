-- Presence — OpenKYC verification sessions + next-generation liveness
-- (SRS Addendum 001: AMD-KYC-06..10)
--
-- Requirement anchors:
--   AMD-KYC-06  the OpenKYC pipeline (services/openkyc) composes three
--               open engines behind a conformance interface — PaddleOCR
--               (text), Docling (layout/structure), a VLM (semantic
--               authenticity) — plus deterministic reference engines for
--               CI; it is the in-house verification PROVIDER of
--               AMD-KYC-02: it never writes OLTP (the ADR-0009 discipline)
--               and answers only through the signed callback
--   AMD-KYC-07  next-generation liveness: a server-issued randomized
--               challenge (3 of 5 actions, shuffled, per-action timing
--               windows), single-use signed challenge tokens bound to an
--               ATTESTED device (FR-51), and a six-signal fusion —
--               challenge response, moire/texture screen-replay cues,
--               depth/specular heuristics, rPPG pulse presence, motion
--               rigidity across the sequence, capture-channel injection
--               checks
--   AMD-KYC-08  kyc_sessions: the verification ledger. The database
--               stores the challenge digest, the state machine and the
--               DERIVED FACTS ONLY (credential kind, over-18 flag,
--               credential validity, two scores, opaque provider ref) —
--               never a capture, a legal name, a credential number or a
--               date of birth (the AMD-KYC-02 minimisation, extended and
--               pinned by construction)
--   AMD-KYC-09  verdict composition: the pipeline reaches the user record
--               ONLY through record_kyc_decision under app.kyc_callback,
--               via the HMAC webhook (the AMD-PAY-16/22 discipline:
--               freshness before signature, 300 s skew, unconfigured
--               secret answers 503); a 'review' verdict routes to the
--               AMD-ONB-06 manual queue instead of auto-deciding
--   AMD-KYC-10  capture lifecycle: captures live only in the pipeline's
--               memory, are purged before the callback is sent, and the
--               purge lands here as a 'capture_purged' event receipt —
--               the ledger records THAT the purge happened, never what
--               was purged
--
-- Batch-63 rehearsal finding (security hardening): a custom GUC that has
-- never been set in a session reads as NULL through current_setting(...,
-- true), and NULL propagates through boolean gates — `IF NOT (NULL) THEN`
-- skips the refusal. This migration therefore re-pins every console helper
-- (app_moderator, app_taxonomist, app_analyst, app_venue_ops) and both KYC
-- decision gates to NULL-safe forms; CREATE OR REPLACE keeps the function
-- OIDs, so every `IF NOT app_*()` call site and every RLS policy across
-- 0008..0037 hardens in place. RLS semantics are unchanged: an unset gate
-- answered NULL (deny) and now answers false (deny).
--
-- Forward-only migration; run after 0037_onboarding.sql.

BEGIN;

-- ------------------------------------------------------------ AMD-KYC-08 --

CREATE TABLE kyc_sessions (
    session_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    applicant        uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    state            text NOT NULL DEFAULT 'issued'
                     CHECK (state IN ('issued', 'review', 'verified',
                                      'rejected', 'expired')),
    challenge_digest text NOT NULL CHECK (challenge_digest ~ '^[0-9a-f]{64}$'),
    issued_at        timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    decided_at       timestamptz,
    -- Derived facts ONLY (AMD-KYC-02/08). credential_kind uses the neutral
    -- vocabulary (id_card | driving_permit | travel_document); scores are
    -- the fused pipeline outputs in [0, 1].
    credential_kind  text CHECK (credential_kind IS NULL OR credential_kind IN
                     ('id_card', 'driving_permit', 'travel_document')),
    over_18          boolean,
    credential_valid boolean,
    authenticity_score numeric(5,4) CHECK (authenticity_score IS NULL OR
                     (authenticity_score >= 0 AND authenticity_score <= 1)),
    liveness_score   numeric(5,4) CHECK (liveness_score IS NULL OR
                     (liveness_score >= 0 AND liveness_score <= 1)),
    provider_ref     text,
    -- A decided row is complete; an open row carries no verdict fields.
    CHECK (state IN ('verified', 'rejected', 'review')
           OR (decided_at IS NULL AND credential_kind IS NULL
               AND over_18 IS NULL AND credential_valid IS NULL
               AND authenticity_score IS NULL AND liveness_score IS NULL)),
    CHECK (state NOT IN ('verified', 'rejected', 'review')
           OR (decided_at IS NOT NULL AND credential_kind IS NOT NULL
               AND over_18 IS NOT NULL AND credential_valid IS NOT NULL
               AND authenticity_score IS NOT NULL AND liveness_score IS NOT NULL)),
    -- A verification that is not over-18 or not on a valid credential is
    -- unrepresentable — the storage layer refuses it outright.
    CHECK (state <> 'verified' OR (over_18 AND credential_valid))
);

-- One open session per applicant — the idempotency anchor. 'review' stays
-- open for the manual queue, so a member cannot farm sessions while one
-- awaits a moderator.
CREATE UNIQUE INDEX kyc_sessions_one_open
    ON kyc_sessions (applicant) WHERE state IN ('issued', 'review');

CREATE INDEX kyc_sessions_review_queue
    ON kyc_sessions (issued_at) WHERE state = 'review';

CREATE TABLE kyc_session_events (
    event_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES kyc_sessions (session_id)
               ON DELETE CASCADE,
    event      text NOT NULL CHECK (event IN
               ('issued', 'decided', 'review_routed', 'capture_purged',
                'expired')),
    actor      text NOT NULL,
    at         timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION kyc_session_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'kyc_session_events is append-only (AMD-KYC-08)';
END $$;

CREATE TRIGGER kyc_session_events_guard
    BEFORE UPDATE OR DELETE ON kyc_session_events
    FOR EACH ROW EXECUTE FUNCTION kyc_session_events_guard();

ALTER TABLE kyc_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc_session_events ENABLE ROW LEVEL SECURITY;

-- The applicant reads their own rows (the edge projects a minimal
-- projection — RLS is row-level); the console reads under the moderator
-- GUC (the elevation_requests discipline).
CREATE POLICY kyc_sessions_select_own ON kyc_sessions
    FOR SELECT USING (applicant = app_user());
CREATE POLICY kyc_sessions_moderation ON kyc_sessions
    FOR SELECT USING (app_moderator());
CREATE POLICY kyc_session_events_select_own ON kyc_session_events
    FOR SELECT USING (EXISTS (SELECT 1 FROM kyc_sessions s
                               WHERE s.session_id = kyc_session_events.session_id
                                 AND s.applicant = app_user()));
CREATE POLICY kyc_session_events_moderation ON kyc_session_events
    FOR SELECT USING (app_moderator());

-- ------------------------------------------------------------ AMD-KYC-07 --
-- Issue a verification session. The edge builds the randomized challenge
-- (3 of 5 actions, shuffled, with per-action windows), pins its sha256
-- digest here, and hands the member a single-use signed token the
-- pipeline verifies before it looks at a single frame. The session is
-- bound to the AMD-KYC-01 gate: only a pending or rejected member may
-- open one. Returns outcome + session_id; outcomes:
-- 'issued' | 'already_open' | 'not_requestable' | 'invalid_challenge'
-- | 'invalid_ttl' | 'forbidden'.
CREATE OR REPLACE FUNCTION issue_kyc_session(
    p_challenge_digest text, p_ttl_seconds integer DEFAULT 600)
RETURNS TABLE(outcome text, session_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_state text;
    v_id uuid;
BEGIN
    IF v_user IS NULL THEN
        RETURN QUERY SELECT 'forbidden'::text, NULL::uuid;
        RETURN;
    END IF;
    IF p_challenge_digest IS NULL
       OR p_challenge_digest !~ '^[0-9a-f]{64}$' THEN
        RETURN QUERY SELECT 'invalid_challenge'::text, NULL::uuid;
        RETURN;
    END IF;
    IF p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 900 THEN
        RETURN QUERY SELECT 'invalid_ttl'::text, NULL::uuid;
        RETURN;
    END IF;
    SELECT kyc_state INTO v_state FROM users WHERE user_id = v_user;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'forbidden'::text, NULL::uuid;
        RETURN;
    END IF;
    IF v_state NOT IN ('pending', 'rejected') THEN
        RETURN QUERY SELECT 'not_requestable'::text, NULL::uuid;
        RETURN;
    END IF;
    BEGIN
        INSERT INTO kyc_sessions (applicant, challenge_digest, expires_at)
        VALUES (v_user, lower(p_challenge_digest),
                now() + make_interval(secs => p_ttl_seconds))
        RETURNING kyc_sessions.session_id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        RETURN QUERY SELECT 'already_open'::text, NULL::uuid;
        RETURN;
    END;
    INSERT INTO kyc_session_events (session_id, event, actor)
    VALUES (v_id, 'issued', v_user::text);
    PERFORM admin_audit_log(
        v_user, 'kyc.session.issued', 'kyc-verification',
        'user', v_user::text, NULL,
        jsonb_build_object('session', v_id, 'ttl', p_ttl_seconds));
    RETURN QUERY SELECT 'issued'::text, v_id;
END $$;

-- --------------------------------------- NULL-safe GUC gates (hardening) --
-- See the header note: an unset custom GUC reads NULL, and `IF NOT (NULL)`
-- skips a refusal. The four console helpers and both KYC decision gates are
-- re-pinned so unset (or anything but 'on') is FALSE, never NULL.
CREATE OR REPLACE FUNCTION app_moderator() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.moderator', true) IS NOT DISTINCT FROM 'on' $$;

CREATE OR REPLACE FUNCTION app_taxonomist() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.taxonomist', true) IS NOT DISTINCT FROM 'on' $$;

CREATE OR REPLACE FUNCTION app_analyst() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.analyst', true) IS NOT DISTINCT FROM 'on' $$;

CREATE OR REPLACE FUNCTION app_venue_ops() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.venue_ops', true) IS NOT DISTINCT FROM 'on' $$;

-- record_kyc_decision: the 0024/0037 body carried verbatim (including the
-- AMD-ONB-06 review-stamp clear); only the guard expression changes — an
-- unset app.kyc_callback used to read NULL, and `NOT (NULL OR NULL)`
-- skipped the refusal.
CREATE OR REPLACE FUNCTION record_kyc_decision(
    p_user uuid, p_actor text, p_decision text, p_provider_ref text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_state text;
BEGIN
    -- Manual review (moderation console) or the provider callback route —
    -- nothing else may move a KYC state. NULL-safe: an unset GUC is false.
    IF NOT (app_moderator()
            OR current_setting('app.kyc_callback', true) IS NOT DISTINCT FROM 'on') THEN
        RETURN 'forbidden';
    END IF;
    IF p_decision NOT IN ('verified', 'rejected', 'suspended', 'pending') THEN
        RETURN 'illegal_transition';
    END IF;
    SELECT kyc_state INTO v_state FROM users WHERE user_id = p_user FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_user';
    END IF;
    IF NOT (
        (v_state = 'pending'   AND p_decision IN ('verified', 'rejected')) OR
        (v_state = 'verified'  AND p_decision = 'suspended') OR
        (v_state = 'suspended' AND p_decision = 'verified') OR
        (v_state = 'rejected'  AND p_decision = 'pending')
    ) THEN
        RETURN 'illegal_transition';
    END IF;
    UPDATE users
       SET kyc_state = p_decision,
           kyc_verified_at = CASE WHEN p_decision = 'verified' THEN now()
                                  ELSE kyc_verified_at END,
           kyc_provider_ref = coalesce(p_provider_ref, kyc_provider_ref),
           kyc_reviewed_by = p_actor,
           -- AMD-ONB-06: a decision closes the review loop — the request
           -- stamp clears so a later rejection can be re-requested.
           kyc_review_requested_at = NULL
     WHERE user_id = p_user;
    PERFORM admin_audit_log(
        NULL,
        'kyc.decision.' || p_decision,
        'kyc-review',
        'user', p_user::text,
        jsonb_build_object('from', v_state),
        jsonb_build_object('to', p_decision, 'actor', p_actor)
    );
    RETURN 'recorded';
END $$;

-- ------------------------------------------------------------ AMD-KYC-09 --
-- The pipeline's verdict lands here — the ONLY writer besides expiry.
-- Requires app.kyc_callback (the HMAC webhook wrapper); re-checks the
-- challenge digest against the issued session so a verdict can never be
-- attached to a session it was not issued for. 'verified' and 'rejected'
-- compose record_kyc_decision — including the legal rejected -> pending
-- -> verified walk for a previously rejected member — and close the
-- AMD-ONB-06 stamp; 'review' routes to the manual queue by stamping
-- kyc_review_requested_at and keeps the session open for a moderator.
-- The purge receipt is recorded BEFORE the decision composes (AMD-KYC-10).
-- Returns 'completed' | 'review_routed' | 'replayed' | 'unknown_session'
-- | 'not_open' | 'challenge_mismatch' | 'illegal_outcome' | 'expired'
-- | 'forbidden'.
CREATE OR REPLACE FUNCTION complete_kyc_session(
    p_session uuid,
    p_challenge_digest text,
    p_outcome text,
    p_credential_kind text,
    p_over_18 boolean,
    p_credential_valid boolean,
    p_authenticity_score numeric,
    p_liveness_score numeric,
    p_provider_ref text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_session kyc_sessions%ROWTYPE;
    v_state text;
    v_step text;
BEGIN
    -- NULL-safe: an unset app.kyc_callback reads NULL, and `NULL <> 'on'`
    -- would skip this refusal (the batch-63 rehearsal finding).
    IF current_setting('app.kyc_callback', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF p_outcome NOT IN ('verified', 'rejected', 'review') THEN
        RETURN 'illegal_outcome';
    END IF;
    SELECT * INTO v_session FROM kyc_sessions
     WHERE session_id = p_session FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_session';
    END IF;
    IF v_session.state NOT IN ('issued', 'review') THEN
        -- A replayed callback after a terminal decision is a success —
        -- the verdict landed once (the AMD-PAY-16 discipline).
        RETURN 'replayed';
    END IF;
    IF v_session.challenge_digest <> lower(p_challenge_digest) THEN
        RETURN 'challenge_mismatch';
    END IF;
    IF v_session.expires_at <= now() AND v_session.state = 'issued' THEN
        UPDATE kyc_sessions SET state = 'expired'
         WHERE session_id = p_session;
        INSERT INTO kyc_session_events (session_id, event, actor)
        VALUES (p_session, 'expired', 'openkyc-pipeline');
        RETURN 'expired';
    END IF;
    -- AMD-KYC-10: the purge receipt is part of the ledger BEFORE the
    -- verdict composes — the capture is already gone by the time any
    -- state moves.
    INSERT INTO kyc_session_events (session_id, event, actor)
    VALUES (p_session, 'capture_purged', 'openkyc-pipeline');
    IF p_outcome = 'review' THEN
        UPDATE kyc_sessions
           SET state = 'review', decided_at = now(),
               credential_kind = p_credential_kind,
               over_18 = p_over_18,
               credential_valid = p_credential_valid,
               authenticity_score = p_authenticity_score,
               liveness_score = p_liveness_score,
               provider_ref = coalesce(p_provider_ref, provider_ref)
         WHERE session_id = p_session;
        -- Route to the AMD-ONB-06 manual worklist.
        UPDATE users SET kyc_review_requested_at = now()
         WHERE user_id = v_session.applicant;
        INSERT INTO kyc_session_events (session_id, event, actor)
        VALUES (p_session, 'review_routed', 'openkyc-pipeline');
        PERFORM admin_audit_log(
            NULL, 'kyc.session.review', 'kyc-verification',
            'user', v_session.applicant::text, NULL,
            jsonb_build_object('session', p_session,
                               'authenticity', p_authenticity_score,
                               'liveness', p_liveness_score));
        RETURN 'review_routed';
    END IF;
    -- Terminal verdict. A verified verdict on a rejected member walks the
    -- legal rejected -> pending -> verified path; a rejected verdict on an
    -- already-rejected member needs no walk (the state already says so).
    SELECT kyc_state INTO v_state FROM users
     WHERE user_id = v_session.applicant;
    IF p_outcome = 'verified' AND v_state = 'rejected' THEN
        v_step := record_kyc_decision(
            v_session.applicant, 'openkyc-pipeline', 'pending', NULL);
        IF v_step <> 'recorded' THEN
            RETURN 'illegal_outcome';
        END IF;
    END IF;
    IF NOT (p_outcome = 'rejected' AND v_state = 'rejected') THEN
        v_step := record_kyc_decision(
            v_session.applicant, 'openkyc-pipeline', p_outcome,
            p_provider_ref);
        IF v_step <> 'recorded' THEN
            RETURN 'illegal_outcome';
        END IF;
    END IF;
    UPDATE kyc_sessions
       SET state = p_outcome, decided_at = now(),
           credential_kind = p_credential_kind,
           over_18 = p_over_18,
           credential_valid = p_credential_valid,
           authenticity_score = p_authenticity_score,
           liveness_score = p_liveness_score,
           provider_ref = coalesce(p_provider_ref, provider_ref)
     WHERE session_id = p_session;
    INSERT INTO kyc_session_events (session_id, event, actor)
    VALUES (p_session, 'decided', 'openkyc-pipeline');
    PERFORM admin_audit_log(
        NULL, 'kyc.session.' || p_outcome, 'kyc-verification',
        'user', v_session.applicant::text, NULL,
        jsonb_build_object('session', p_session,
                           'kind', p_credential_kind,
                           'authenticity', p_authenticity_score,
                           'liveness', p_liveness_score));
    RETURN 'completed';
END $$;

-- Expire issued sessions past their TTL. No value moves, so no settlement
-- gate — the sweeper runs under the app role; idempotent by construction.
CREATE OR REPLACE FUNCTION expire_kyc_sessions()
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_count integer := 0;
    v_row record;
BEGIN
    FOR v_row IN
        SELECT session_id FROM kyc_sessions
         WHERE state = 'issued' AND expires_at <= now()
    LOOP
        UPDATE kyc_sessions SET state = 'expired'
         WHERE session_id = v_row.session_id;
        INSERT INTO kyc_session_events (session_id, event, actor)
        VALUES (v_row.session_id, 'expired', 'sweeper');
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END $$;

-- The moderation worklist: pipeline-routed reviews, oldest first.
CREATE OR REPLACE FUNCTION kyc_session_queue()
RETURNS TABLE(session_id uuid, applicant uuid, issued_at timestamptz,
              decided_at timestamptz, credential_kind text,
              authenticity_score numeric, liveness_score numeric)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT s.session_id, s.applicant, s.issued_at, s.decided_at,
           s.credential_kind, s.authenticity_score, s.liveness_score
      FROM kyc_sessions s
     WHERE s.state = 'review' AND app_moderator()
     ORDER BY s.issued_at
     LIMIT 100;
$$;

-- The member's own read model — minimal projection behind
-- GET /v1/identity/kyc/session: state and timestamps, never the scores
-- (scores would aid spoof probing).
CREATE OR REPLACE FUNCTION my_kyc_session()
RETURNS TABLE(session_id uuid, state text, issued_at timestamptz,
              expires_at timestamptz, decided_at timestamptz)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT s.session_id, s.state, s.issued_at, s.expires_at, s.decided_at
      FROM kyc_sessions s
     WHERE s.applicant = app_user()
     ORDER BY s.issued_at DESC
     LIMIT 1;
$$;

-- ------------------------------------------------------------ AMD-KYC-08 --
-- The FR-62 export gains the verification record — derived facts only,
-- exactly what the table holds.
CREATE OR REPLACE FUNCTION dsar_export(uid uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT jsonb_build_object(
        'user', (SELECT jsonb_build_object(
                        'userId', u.user_id, 'createdAt', u.created_at,
                        'birthYear', u.birth_year, 'ageDeclaredAt', u.age_declared_at,
                        'kycReviewRequestedAt', u.kyc_review_requested_at,
                        'invisible', u.invisible)
                   FROM users u WHERE u.user_id = uid),
        'identity', (SELECT jsonb_build_object(
                        'handle', i.handle, 'displayName', COALESCE(i.display_name, i.handle),
                        'bio', i.bio, 'photoUrl', i.photo_url, 'updatedAt', i.updated_at)
                       FROM user_identities i WHERE i.user_id = uid),
        'interests', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'nodeId', p.node_id, 'weight', p.weight) ORDER BY p.node_id)
                       FROM profile_interests p WHERE p.user_id = uid), '[]'::jsonb),
        'pairs', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'pairId', m.pair_id, 'state', m.state,
                        'openedAt', m.opened_at, 'closedAt', m.closed_at,
                        'closeReason', CASE WHEN m.close_reason = 'declined' THEN 'expired'
                                            ELSE m.close_reason END)
                       ORDER BY m.opened_at DESC NULLS LAST)
                       FROM matches m
                       WHERE uid IN (m.user_lo, m.user_hi)
                         AND (m.close_reason IS NULL OR m.close_reason <> 'blocked')),
                       '[]'::jsonb),
        'ledgerActions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'pairId', l.pair_id, 'from', l.from_state, 'to', l.to_state, 'at', l.at)
                       ORDER BY l.at)
                       FROM consent_ledger l WHERE l.actor = uid), '[]'::jsonb),
        'blocksFiled', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'blocked', b.blocked, 'at', b.created_at) ORDER BY b.created_at)
                       FROM blocks b WHERE b.blocker = uid), '[]'::jsonb),
        'reportsFiled', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'reportId', r.report_id, 'category', r.category,
                        'reason', r.reason, 'details', r.details,
                        'createdAt', r.created_at, 'status', r.status) ORDER BY r.created_at)
                       FROM reports r WHERE r.reporter = uid), '[]'::jsonb),
        'dataProcessingConsents', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'purpose', d.purpose, 'scope', d.scope,
                        'policyVersion', d.policy_version, 'grantedAt', d.granted_at,
                        'withdrawnAt', d.withdrawn_at) ORDER BY d.purpose)
                       FROM data_processing_consents d WHERE d.user_id = uid), '[]'::jsonb),
        'transfers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'transferId', t.transfer_id,
                        'pairId', t.pair_id,
                        'role', CASE WHEN t.sender = uid THEN 'sender' ELSE 'recipient' END,
                        'counterparty', CASE WHEN t.sender = uid THEN t.recipient ELSE t.sender END,
                        'amountMinor', t.amount_minor,
                        'feeMinor', t.fee_minor,
                        'currency', t.currency,
                        'state', t.state,
                        'proposedAt', t.proposed_at,
                        'expiresAt', t.expires_at,
                        'resolvedOutcome', t.resolved_outcome,
                        'updatedAt', t.updated_at,
                        'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                'event', e.event, 'actor', e.actor,
                                'detail', e.detail, 'at', e.at) ORDER BY e.at)
                            FROM transfer_events e
                            WHERE e.transfer_id = t.transfer_id), '[]'::jsonb))
                       ORDER BY t.proposed_at DESC)
                       FROM transfers t WHERE uid IN (t.sender, t.recipient)),
                       '[]'::jsonb),
        'wallets', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'walletId', w.wallet_id,
                        'currency', w.currency,
                        'status', w.status,
                        'createdAt', w.created_at,
                        'entries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                'kind', e.kind,
                                'amountMinor', e.amount_minor,
                                'balanceAfter', e.balance_after,
                                'transferId', e.transfer_id,
                                'at', e.at) ORDER BY e.entry_id)
                            FROM wallet_entries e
                            WHERE e.wallet_id = w.wallet_id), '[]'::jsonb),
                        'holds', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                'holdId', h.hold_id,
                                'amountMinor', h.amount_minor,
                                'state', h.state,
                                'transferId', h.transfer_id,
                                'createdAt', h.created_at,
                                'resolvedAt', h.resolved_at) ORDER BY h.created_at)
                            FROM wallet_holds h
                            WHERE h.wallet_id = w.wallet_id), '[]'::jsonb),
                        'withdrawals', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                'requestId', r.request_id,
                                'amountMinor', r.amount_minor,
                                'state', r.state,
                                'destinationRef', r.destination_ref,
                                'createdAt', r.created_at,
                                'resolvedAt', r.resolved_at) ORDER BY r.created_at)
                            FROM withdrawal_requests r
                            WHERE r.wallet_id = w.wallet_id), '[]'::jsonb))
                       ORDER BY w.created_at)
                       FROM wallets w WHERE w.owner = uid),
                       '[]'::jsonb),
        'swaps', jsonb_build_object(
            'listings', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'swapListingId', l.swap_listing_id,
                            'haveCategory', l.have_category,
                            'wantCategories', l.want_categories,
                            'valueEstimateMinor', l.value_estimate_minor,
                            'currency', l.currency,
                            'market', l.market,
                            'state', l.state,
                            'createdAt', l.created_at,
                            'closedAt', l.closed_at) ORDER BY l.created_at)
                           FROM swap_listings l WHERE l.owner = uid), '[]'::jsonb),
            'agreements', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'agreementId', a.agreement_id,
                            'role', CASE WHEN a.proposer = uid THEN 'proposer'
                                         ELSE 'counterparty' END,
                            'counterparty', CASE WHEN a.proposer = uid
                                                 THEN a.counterparty
                                                 ELSE a.proposer END,
                            'proposerListing', a.proposer_listing,
                            'counterpartyListing', a.counterparty_listing,
                            'balanceMinor', a.balance_minor,
                            'requiresBond', a.requires_bond,
                            'state', a.state,
                            'createdAt', a.created_at,
                            'decidedAt', a.decided_at,
                            'disputedAt', a.disputed_at,
                            'completedAt', a.completed_at) ORDER BY a.created_at)
                           FROM swap_agreements a
                           WHERE uid IN (a.proposer, a.counterparty)), '[]'::jsonb)),
        'services', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'bookingId', b.booking_id,
                        'listingId', b.listing_id,
                        'role', CASE WHEN b.customer = uid THEN 'customer'
                                     ELSE 'provider' END,
                        'counterparty', CASE WHEN b.customer = uid
                                             THEN b.provider
                                             ELSE b.customer END,
                        'agreedMinor', b.agreed_minor,
                        'currency', b.currency,
                        'milestones', b.milestones,
                        'state', b.state,
                        'createdAt', b.created_at,
                        'startedAt', b.started_at,
                        'disputedAt', b.disputed_at,
                        'completedAt', b.completed_at,
                        'cancelledAt', b.cancelled_at) ORDER BY b.created_at)
                       FROM service_bookings b
                       WHERE uid IN (b.customer, b.provider)), '[]'::jsonb),
        'onboardingApplications', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'applicationId', a.application_id,
                        'kind', a.kind,
                        'payload', a.payload,
                        'status', a.status,
                        'requestedAt', a.requested_at,
                        'decidedAt', a.decided_at,
                        'decisionReason', a.decision_reason) ORDER BY a.requested_at)
                       FROM onboarding_applications a
                       WHERE a.applicant = uid), '[]'::jsonb),
        'kycSessions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'sessionId', s.session_id,
                        'state', s.state,
                        'credentialKind', s.credential_kind,
                        'over18', s.over_18,
                        'credentialValid', s.credential_valid,
                        'authenticityScore', s.authenticity_score,
                        'livenessScore', s.liveness_score,
                        'issuedAt', s.issued_at,
                        'decidedAt', s.decided_at) ORDER BY s.issued_at)
                       FROM kyc_sessions s
                       WHERE s.applicant = uid), '[]'::jsonb)
    )
$$;

-- ------------------------------------------------------------ grants -------
GRANT SELECT ON kyc_sessions TO presence_app;
GRANT SELECT ON kyc_session_events TO presence_app;

REVOKE ALL ON FUNCTION issue_kyc_session(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_kyc_session(uuid, text, text, text, boolean, boolean, numeric, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION expire_kyc_sessions() FROM PUBLIC;
REVOKE ALL ON FUNCTION kyc_session_queue() FROM PUBLIC;
REVOKE ALL ON FUNCTION my_kyc_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION kyc_session_events_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION issue_kyc_session(text, integer) TO presence_app;
GRANT EXECUTE ON FUNCTION complete_kyc_session(uuid, text, text, text, boolean, boolean, numeric, numeric, text) TO presence_app;
GRANT EXECUTE ON FUNCTION expire_kyc_sessions() TO presence_app;
GRANT EXECUTE ON FUNCTION kyc_session_queue() TO presence_app;
GRANT EXECUTE ON FUNCTION my_kyc_session() TO presence_app;
GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app;

COMMIT;
