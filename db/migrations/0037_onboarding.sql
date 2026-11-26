-- presence — migration 0037: stakeholder onboarding workflows (batch 62,
-- SRS Addendum 001 AMD-ONB-01..06).
--
-- Requirement anchors:
--   AMD-ONB-01  onboarding_applications: the governed entry point for the
--               two non-consumer stakeholder kinds — venue_partner and
--               provider. One open application per (applicant, kind);
--               payloads are validated per kind in the storage layer; the
--               four-eyes CHECK makes self-approval unrepresentable.
--   AMD-ONB-02  submit_onboarding_application: the applicant-facing
--               definer. KYC-verified is the prerequisite for BOTH kinds —
--               a stakeholder relationship starts from a verified member.
--               Idempotent: a second submission with an open application
--               returns that application (already_open).
--   AMD-ONB-03  withdraw_onboarding_application: the applicant withdraws
--               their own pending application; decided rows are immutable.
--   AMD-ONB-04  decide_onboarding_application: moderation decision
--               surface — app_moderator() gated, four-eyes enforced in the
--               definer as well as the CHECK, rejection requires a reason.
--               A venue_partner approval provisions the venue as a
--               'prospect' (never straight to live) and binds the operator
--               in venue_accounts; every step audits.
--   AMD-ONB-05  venue_accounts: the platform's source of truth for
--               venue<->operator binding (BR-12's venue_ids claim replays
--               from here via the edge Keycloak admin client). The
--               prospect->active transition is a second, separate venue-ops
--               act (venue_activate) — approval onboards, activation goes
--               live. venue_offboard now revokes the bindings too.
--   AMD-ONB-06  consumer onboarding orchestration: kyc_review_requested_at
--               lets a pending or rejected member INITIATE review (the
--               0024 surface only accepted decisions); record_kyc_decision
--               clears the stamp so the loop closes; kyc_review_queue is
--               the moderation worklist; onboarding_status() is the
--               stepper read model behind GET /v1/account/onboarding;
--               dsar_export gains the onboarding record.
--
-- Forward-only migration; run after 0036_service_bookings.sql.

BEGIN;

-- ------------------------------------------------------------ AMD-ONB-01 --

CREATE TABLE onboarding_applications (
    application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind           text NOT NULL CHECK (kind IN ('venue_partner', 'provider')),
    applicant      uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    payload        jsonb NOT NULL,
    status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    requested_at   timestamptz NOT NULL DEFAULT now(),
    decided_by     uuid,
    decided_at     timestamptz,
    decision_reason text CHECK (decision_reason IS NULL
                                OR char_length(decision_reason) BETWEEN 10 AND 500),
    -- Four-eyes in the storage layer: no row may ever record the applicant
    -- as its own decider (the SEC-03 discipline, applied to onboarding).
    CHECK (decided_by IS NULL OR decided_by <> applicant),
    -- A decided row is complete: decider and decision time set; an open
    -- row carries neither.
    CHECK (status IN ('approved', 'rejected')
           OR (decided_by IS NULL AND decided_at IS NULL)),
    CHECK (status NOT IN ('approved', 'rejected')
           OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    -- A rejection always tells the applicant why.
    CHECK (status <> 'rejected' OR decision_reason IS NOT NULL)
);

-- One open application per applicant and kind — the idempotency anchor.
CREATE UNIQUE INDEX onboarding_applications_one_open
    ON onboarding_applications (applicant, kind) WHERE status = 'pending';

-- The console queue: pending first, then most recent decisions.
CREATE INDEX onboarding_applications_queue_idx
    ON onboarding_applications (status, requested_at);

ALTER TABLE onboarding_applications ENABLE ROW LEVEL SECURITY;
-- The applicant reads their own rows; the console reads under the
-- moderator GUC (the elevation_requests discipline).
CREATE POLICY onboarding_applications_select_own ON onboarding_applications
    FOR SELECT USING (applicant = app_user());
CREATE POLICY onboarding_applications_moderation ON onboarding_applications
    FOR SELECT USING (app_moderator());

-- Payload shapes, validated in the storage layer so no edge bug can sneak
-- a malformed application in. Keys are whitelisted (the TR-23 discipline);
-- the venue polygon is 4..64 [lon, lat] pairs inside valid ranges; the
-- schedule reuses the 0020 registry validator.
CREATE OR REPLACE FUNCTION onboarding_payload_valid(p_kind text, p_payload jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_kind
        WHEN 'venue_partner' THEN
            jsonb_typeof(p_payload) = 'object'
            AND NOT EXISTS (
                SELECT 1 FROM jsonb_object_keys(p_payload) k
                 WHERE k NOT IN ('name', 'polygon', 'schedule', 'statement'))
            AND jsonb_typeof(p_payload->'name') = 'string'
            AND char_length(p_payload->>'name') BETWEEN 2 AND 80
            AND jsonb_typeof(p_payload->'polygon') = 'array'
            AND jsonb_array_length(p_payload->'polygon') BETWEEN 4 AND 64
            AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(p_payload->'polygon') pt
                 WHERE jsonb_typeof(pt) <> 'array'
                    OR jsonb_array_length(pt) <> 2
                    OR jsonb_typeof(pt->0) <> 'number'
                    OR jsonb_typeof(pt->1) <> 'number'
                    OR (pt->0)::float8 NOT BETWEEN -180 AND 180
                    OR (pt->1)::float8 NOT BETWEEN -90 AND 90)
            AND jsonb_typeof(p_payload->'statement') = 'string'
            AND char_length(p_payload->>'statement') BETWEEN 10 AND 500
            AND (NOT (p_payload ? 'schedule')
                 OR operating_schedule_valid(p_payload->'schedule'))
        WHEN 'provider' THEN
            jsonb_typeof(p_payload) = 'object'
            AND NOT EXISTS (
                SELECT 1 FROM jsonb_object_keys(p_payload) k
                 WHERE k NOT IN ('termsVersion', 'statement'))
            AND jsonb_typeof(p_payload->'termsVersion') = 'string'
            AND (p_payload->>'termsVersion') ~ '^v[0-9]+\.[0-9]+$'
            AND jsonb_typeof(p_payload->'statement') = 'string'
            AND char_length(p_payload->>'statement') BETWEEN 10 AND 500
        ELSE false
    END
$$;

-- ------------------------------------------------------------ AMD-ONB-02 --
-- Submit: the applicant-facing definer. Named refusals, idempotent on an
-- open application, audited like every other governed surface.
CREATE OR REPLACE FUNCTION submit_onboarding_application(p_kind text, p_payload jsonb)
RETURNS TABLE(outcome text, application_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_id   uuid;
BEGIN
    IF v_user IS NULL THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF p_kind NOT IN ('venue_partner', 'provider') THEN
        RETURN QUERY SELECT 'unknown_kind', NULL::uuid;
        RETURN;
    END IF;
    -- A stakeholder relationship starts from a verified member (AMD-ONB-02).
    IF NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = v_user AND u.kyc_state = 'verified') THEN
        RETURN QUERY SELECT 'kyc_required', NULL::uuid;
        RETURN;
    END IF;
    IF NOT onboarding_payload_valid(p_kind, p_payload) THEN
        RETURN QUERY SELECT 'invalid_payload', NULL::uuid;
        RETURN;
    END IF;
    SELECT a.application_id INTO v_id
      FROM onboarding_applications a
     WHERE a.applicant = v_user AND a.kind = p_kind AND a.status = 'pending';
    IF FOUND THEN
        RETURN QUERY SELECT 'already_open', v_id;   -- idempotent re-submit
        RETURN;
    END IF;
    INSERT INTO onboarding_applications (kind, applicant, payload)
    VALUES (p_kind, v_user, p_payload)
    RETURNING onboarding_applications.application_id INTO v_id;
    PERFORM admin_audit_log(
        v_user, 'onboarding.submitted', 'other_policy',
        'onboarding_application', v_id::text,
        NULL, jsonb_build_object('kind', p_kind));
    RETURN QUERY SELECT 'submitted', v_id;
END $$;

-- ------------------------------------------------------------ AMD-ONB-03 --
CREATE OR REPLACE FUNCTION withdraw_onboarding_application(p_application uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_app  onboarding_applications%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_app FROM onboarding_applications a
     WHERE a.application_id = p_application FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_application';
    END IF;
    IF v_app.applicant <> v_user THEN
        RETURN 'forbidden';
    END IF;
    IF v_app.status <> 'pending' THEN
        RETURN 'not_pending';
    END IF;
    UPDATE onboarding_applications SET status = 'withdrawn'
     WHERE application_id = p_application;
    PERFORM admin_audit_log(
        v_user, 'onboarding.withdrawn', 'other_policy',
        'onboarding_application', p_application::text,
        jsonb_build_object('status', 'pending'),
        jsonb_build_object('status', 'withdrawn'));
    RETURN 'withdrawn';
END $$;

-- ------------------------------------------------------------ AMD-ONB-04 --
-- The moderation decision surface. Four-eyes is enforced here AND by the
-- table CHECK; rejection requires a reason the applicant can read; a
-- venue_partner approval provisions the venue as a PROSPECT and binds the
-- operator — going live is a separate venue-ops act (venue_activate).
CREATE OR REPLACE FUNCTION decide_onboarding_application(
    p_application uuid, p_decision text, p_reason text DEFAULT NULL)
RETURNS TABLE(outcome text, venue_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_actor uuid := app_user();
    v_app   onboarding_applications%ROWTYPE;
    v_venue uuid;
    v_ring  text;
    v_first text;
    v_last  text;
    v_pt    jsonb;
BEGIN
    IF v_actor IS NULL OR NOT app_moderator() THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF p_decision NOT IN ('approved', 'rejected') THEN
        RETURN QUERY SELECT 'illegal_decision', NULL::uuid;
        RETURN;
    END IF;
    SELECT * INTO v_app FROM onboarding_applications a
     WHERE a.application_id = p_application FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_application', NULL::uuid;
        RETURN;
    END IF;
    IF v_app.status <> 'pending' THEN
        RETURN QUERY SELECT 'not_pending', NULL::uuid;
        RETURN;
    END IF;
    -- Four-eyes: a moderator never decides their own application.
    IF v_app.applicant = v_actor THEN
        RETURN QUERY SELECT 'four_eyes', NULL::uuid;
        RETURN;
    END IF;
    IF p_decision = 'rejected'
       AND (p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 10 AND 500) THEN
        RETURN QUERY SELECT 'reason_required', NULL::uuid;
        RETURN;
    END IF;

    IF p_decision = 'approved' AND v_app.kind = 'venue_partner' THEN
        -- Build the WKT ring from the validated payload polygon (lon lat
        -- pairs), closing the ring when the payload leaves it open.
        v_ring := NULL;
        FOR v_pt IN SELECT * FROM jsonb_array_elements(v_app.payload->'polygon') LOOP
            v_ring := concat_ws(',', v_ring,
                                (v_pt->>0) || ' ' || (v_pt->>1));
        END LOOP;
        v_first := (v_app.payload->'polygon'->0->>0) || ' '
                   || (v_app.payload->'polygon'->0->>1);
        v_last := (v_app.payload->'polygon'
                   ->(jsonb_array_length(v_app.payload->'polygon') - 1)->>0) || ' '
                  || (v_app.payload->'polygon'
                      ->(jsonb_array_length(v_app.payload->'polygon') - 1)->>1);
        IF v_last <> v_first THEN
            v_ring := v_ring || ',' || v_first;
        END IF;
        INSERT INTO venues (name, geofence, partner_status, operating_schedule)
        VALUES (v_app.payload->>'name',
                ('POLYGON((' || v_ring || '))')::geography,
                'prospect',
                v_app.payload->'schedule')
        RETURNING venues.venue_id INTO v_venue;
        INSERT INTO venue_accounts (venue_id, user_id, role, granted_by)
        VALUES (v_venue, v_app.applicant, 'owner', v_actor);
        PERFORM admin_audit_log(
            v_actor, 'venue.provisioned', 'other_policy', 'venue', v_venue::text,
            NULL, jsonb_build_object('name', v_app.payload->>'name',
                                     'owner', v_app.applicant,
                                     'application', v_app.application_id));
    END IF;

    UPDATE onboarding_applications
       SET status = p_decision,
           decided_by = v_actor,
           decided_at = now(),
           decision_reason = p_reason
     WHERE application_id = p_application;
    PERFORM admin_audit_log(
        v_actor, 'onboarding.' || p_decision, 'other_policy',
        'onboarding_application', p_application::text,
        jsonb_build_object('status', 'pending'),
        jsonb_build_object('status', p_decision, 'kind', v_app.kind,
                           'applicant', v_app.applicant));
    RETURN QUERY SELECT p_decision, v_venue;
END $$;

-- The console queue: pending first (oldest waiting first), then recent
-- decisions. Moderator-only; the app role has no direct table SELECT.
CREATE OR REPLACE FUNCTION onboarding_review_queue()
RETURNS TABLE(application_id uuid, kind text, applicant uuid, payload jsonb,
              requested_at timestamptz, status text, decided_by uuid,
              decided_at timestamptz, decision_reason text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_moderator() THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT a.application_id, a.kind, a.applicant, a.payload, a.requested_at,
           a.status, a.decided_by, a.decided_at, a.decision_reason
      FROM onboarding_applications a
     ORDER BY (a.status = 'pending') DESC,
              CASE WHEN a.status = 'pending' THEN a.requested_at END ASC,
              CASE WHEN a.status <> 'pending' THEN a.decided_at END DESC
     LIMIT 100;
END $$;

-- ------------------------------------------------------------ AMD-ONB-05 --
-- The venue<->operator binding. Until now the venue_ids claim lived only
-- in Keycloak with no platform record; this table is the source of truth
-- the edge replays from. The applicant reads their own bindings; the
-- console reads through definers.
CREATE TABLE venue_accounts (
    venue_id   uuid NOT NULL REFERENCES venues (venue_id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    role       text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'manager')),
    granted_by uuid NOT NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (venue_id, user_id)
);

ALTER TABLE venue_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY venue_accounts_select_own ON venue_accounts
    FOR SELECT USING (user_id = app_user());
-- The venue-ops console reads bindings (the offboard replay needs them).
CREATE POLICY venue_accounts_console ON venue_accounts
    FOR SELECT USING (app_venue_ops() OR app_moderator());

-- The prospect -> active transition: a venue-ops act, separate from the
-- moderation approval that created the prospect. Same definer discipline
-- as the 0020 registry: exception-raising, self-auditing.
CREATE OR REPLACE FUNCTION venue_activate(p_venue uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    prev venues%ROWTYPE;
BEGIN
    SELECT * INTO prev FROM venues WHERE venue_id = p_venue FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'venue not found' USING ERRCODE = 'P0002';
    END IF;
    IF prev.partner_status <> 'prospect' THEN
        RAISE EXCEPTION 'venue is not a prospect' USING ERRCODE = 'P0001';
    END IF;
    UPDATE venues SET partner_status = 'active' WHERE venue_id = p_venue;
    PERFORM admin_audit_log(
        p_actor, 'venue.activate', 'venue_request', 'venue', p_venue::text,
        jsonb_build_object('partnerStatus', 'prospect'),
        jsonb_build_object('partnerStatus', 'active'));
    RETURN jsonb_build_object('venueId', p_venue, 'partnerStatus', 'active');
END $$;

-- Offboarding is terminal for the operator bindings too: the 0020 definer
-- gains the venue_accounts revocation, audited, so the next edge replay
-- unbinds the Keycloak venue_ids attribute.
CREATE OR REPLACE FUNCTION venue_offboard(p_venue uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    prev venues%ROWTYPE;
    v_revoked integer;
BEGIN
    SELECT * INTO prev FROM venues WHERE venue_id = p_venue FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'venue not found' USING ERRCODE = 'P0002';
    END IF;
    IF prev.partner_status = 'offboarded' THEN
        RAISE EXCEPTION 'venue is already offboarded' USING ERRCODE = 'P0001';
    END IF;
    UPDATE venues SET partner_status = 'offboarded' WHERE venue_id = p_venue;
    PERFORM admin_audit_log(
        p_actor, 'venue.offboard', 'other_policy', 'venue', p_venue::text,
        jsonb_build_object('partnerStatus', prev.partner_status),
        jsonb_build_object('partnerStatus', 'offboarded'));
    DELETE FROM venue_accounts WHERE venue_id = p_venue;
    GET DIAGNOSTICS v_revoked = ROW_COUNT;
    IF v_revoked > 0 THEN
        PERFORM admin_audit_log(
            p_actor, 'venue.bindings_revoked', 'other_policy', 'venue', p_venue::text,
            NULL, jsonb_build_object('revoked', v_revoked));
    END IF;
    RETURN jsonb_build_object('venueId', p_venue, 'partnerStatus', 'offboarded');
END $$;

-- ------------------------------------------------------------ AMD-ONB-06 --
-- The consumer side: a member can finally INITIATE KYC review, the
-- moderation queue surfaces the requests, and onboarding_status() is the
-- canonical stepper read model so the client renders one ordered journey
-- instead of polling five endpoints.
ALTER TABLE users
    ADD COLUMN kyc_review_requested_at timestamptz;

-- Request review: from 'pending' (first pass) or 'rejected' (re-review).
-- Verified and suspended members have nothing to request. Idempotent
-- while a request is already open.
CREATE OR REPLACE FUNCTION request_kyc_review()
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user      uuid := app_user();
    v_state     text;
    v_requested timestamptz;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    SELECT u.kyc_state, u.kyc_review_requested_at INTO v_state, v_requested
      FROM users u WHERE u.user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_user';
    END IF;
    IF v_state NOT IN ('pending', 'rejected') THEN
        RETURN 'not_requestable';
    END IF;
    IF v_requested IS NOT NULL AND v_state = 'pending' THEN
        RETURN 'already_requested';
    END IF;
    UPDATE users SET kyc_review_requested_at = now() WHERE user_id = v_user;
    RETURN 'recorded';
END $$;

-- The moderation worklist: open requests, oldest first.
CREATE OR REPLACE FUNCTION kyc_review_queue()
RETURNS TABLE(user_id uuid, kyc_state text, requested_at timestamptz)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_moderator() THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT u.user_id, u.kyc_state, u.kyc_review_requested_at
      FROM users u
     WHERE u.kyc_review_requested_at IS NOT NULL
       AND u.kyc_state IN ('pending', 'rejected')
     ORDER BY u.kyc_review_requested_at ASC
     LIMIT 100;
END $$;

-- The stepper: one canonical read of the first-run journey. `complete` is
-- the AND of the four steps; the client renders each with its own copy.
CREATE OR REPLACE FUNCTION onboarding_status()
RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_doc  jsonb;
BEGIN
    IF v_user IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT jsonb_build_object(
        'ageDeclared', u.age_declared_at IS NOT NULL,
        'kycState', u.kyc_state,
        'kycReviewRequested', u.kyc_review_requested_at IS NOT NULL,
        'avatarSet', i.avatar_key IS NOT NULL,
        'verticalsChosen', EXISTS (SELECT 1 FROM user_vertical_flags f
                                    WHERE f.user_id = u.user_id),
        'complete', (u.age_declared_at IS NOT NULL
                     AND u.kyc_state = 'verified'
                     AND i.avatar_key IS NOT NULL
                     AND EXISTS (SELECT 1 FROM user_vertical_flags f2
                                  WHERE f2.user_id = u.user_id)))
      INTO v_doc
      FROM users u
      LEFT JOIN user_identities i ON i.user_id = u.user_id
     WHERE u.user_id = v_user;
    RETURN v_doc;
END $$;

-- A decision closes the review loop (the stamp clears, so a rejected
-- member can re-request).
CREATE OR REPLACE FUNCTION record_kyc_decision(
    p_user uuid, p_actor text, p_decision text, p_provider_ref text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_state text;
BEGIN
    -- Manual review (moderation console) or the provider callback route —
    -- nothing else may move a KYC state.
    IF NOT (app_moderator() OR current_setting('app.kyc_callback', true) = 'on') THEN
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

-- The onboarding record joins the FR-62 export.
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
                       WHERE a.applicant = uid), '[]'::jsonb)
    )
$$;

-- ------------------------------------------------------------ grants -------
GRANT SELECT ON onboarding_applications TO presence_app;
GRANT SELECT ON venue_accounts TO presence_app;

REVOKE ALL ON FUNCTION onboarding_payload_valid(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION submit_onboarding_application(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION withdraw_onboarding_application(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION decide_onboarding_application(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION onboarding_review_queue() FROM PUBLIC;
REVOKE ALL ON FUNCTION venue_activate(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION venue_offboard(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION request_kyc_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION kyc_review_queue() FROM PUBLIC;
REVOKE ALL ON FUNCTION onboarding_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_kyc_decision(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_onboarding_application(text, jsonb) TO presence_app;
GRANT EXECUTE ON FUNCTION withdraw_onboarding_application(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION decide_onboarding_application(uuid, text, text) TO presence_app;
GRANT EXECUTE ON FUNCTION onboarding_review_queue() TO presence_app;
GRANT EXECUTE ON FUNCTION venue_activate(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION venue_offboard(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION request_kyc_review() TO presence_app;
GRANT EXECUTE ON FUNCTION kyc_review_queue() TO presence_app;
GRANT EXECUTE ON FUNCTION onboarding_status() TO presence_app;
GRANT EXECUTE ON FUNCTION record_kyc_decision(uuid, text, text, text) TO presence_app;
GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app;

COMMIT;
