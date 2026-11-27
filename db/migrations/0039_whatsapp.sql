-- Presence — WhatsApp channel: opt-in ledger, inbound keyword intake and
-- the notification-leg delivery ledger (SRS Addendum 001: AMD-WA-01..05)
--
-- Requirement anchors:
--   AMD-WA-01  the channel contract lives in services/edge/src/whatsapp.ts:
--              E.164 addressing, a governed template catalogue and the
--              minimalism gate — the database pins the same vocabularies
--              (opt-in states, inbound keywords, delivery statuses) as
--              CHECK constraints so an out-of-contract write is
--              unrepresentable
--   AMD-WA-02  inbound webhook intake is IDEMPOTENT ON THE WAMID — Meta
--              redelivers on any non-2xx, so whatsapp_inbound.wamid is the
--              primary key and a redelivery collapses to 'duplicate'.
--              Inbound text is NEVER stored: the edge parser reduces a
--              message to its keyword (stop | start | help | other) and
--              only the keyword, the phone and the timestamp land here
--   AMD-WA-03  the opt-in ledger: whatsapp_opt_ins is one row per member
--              (pending -> active -> stopped), the verify code lives only
--              as a sha256 digest with a TTL and an attempt counter, and
--              every transition appends to whatsapp_opt_in_events
--              (append-only). A STOP received inbound always wins — the
--              stopped state is the member's revocation and no code path
--              resurrects the channel except an explicit re-link (which
--              demands a fresh verification)
--   AMD-WA-04  the delivery ledger: whatsapp_deliveries reserves a row
--              (status 'pending') BEFORE the network send, so the dedupe
--              key (one template per ref per UTC day) and the daily cap
--              bite before a byte leaves; the send outcome finalizes the
--              reservation (sent+wamid | failed+reason) and Meta's status
--              webhooks advance it (delivered | read), keyed by wamid
--   AMD-WA-05  privacy: opt-in events, inbound receipts and deliveries
--              are DEFINER-ONLY — presence_app holds no table grants and
--              no RLS policies exist for them; the member reads only
--              whatsapp_opt_ins (own row, RLS). The FR-62 export gains a
--              'whatsapp' block (state, phone, timestamps, event history
--              — the member's own data, keyword-only inbound by
--              construction). All callback gates are NULL-safe
--              (IS [NOT] DISTINCT FROM 'on') — the batch-63 hardening
--
-- Forward-only migration; run after 0038_openkyc.sql.

BEGIN;

-- ------------------------------------------------------------ AMD-WA-03 --

CREATE TABLE whatsapp_opt_ins (
    user_id           uuid PRIMARY KEY REFERENCES users (user_id) ON DELETE CASCADE,
    phone_e164        text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9]\d{7,14}$'),
    state             text NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'active', 'stopped')),
    -- The verify code is never stored — only its sha256 digest, with a
    -- TTL and an attempt ceiling (5 attempts, enforced in the definer).
    verify_digest     text CHECK (verify_digest IS NULL OR verify_digest ~ '^[0-9a-f]{64}$'),
    verify_expires_at timestamptz,
    verify_attempts   integer NOT NULL DEFAULT 0 CHECK (verify_attempts >= 0),
    verify_sent_at    timestamptz,
    linked_at         timestamptz NOT NULL DEFAULT now(),
    verified_at       timestamptz,
    stopped_at        timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    -- The digest exists only while a verification is in flight.
    CHECK (state = 'pending' OR verify_digest IS NULL)
);

CREATE TABLE whatsapp_opt_in_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id  uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    event    text NOT NULL CHECK (event IN
             ('link_requested', 'verified', 'verify_failed', 'unlinked',
              'stopped_inbound', 'resumed_inbound', 'help_requested')),
    at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX whatsapp_opt_in_events_user ON whatsapp_opt_in_events (user_id, at);

CREATE OR REPLACE FUNCTION whatsapp_opt_in_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'whatsapp_opt_in_events is append-only (AMD-WA-03)';
END $$;

CREATE TRIGGER whatsapp_opt_in_events_guard
    BEFORE UPDATE OR DELETE ON whatsapp_opt_in_events
    FOR EACH ROW EXECUTE FUNCTION whatsapp_opt_in_events_guard();

-- ------------------------------------------------------------ AMD-WA-02 --

CREATE TABLE whatsapp_inbound (
    wamid       text PRIMARY KEY CHECK (wamid ~ '^[A-Za-z0-9._=-]{8,255}$'),
    phone_e164  text NOT NULL CHECK (phone_e164 ~ '^\+[1-9]\d{7,14}$'),
    keyword     text NOT NULL CHECK (keyword IN ('stop', 'start', 'help', 'other')),
    -- NULL when the sender has no opt-in row (unknown sender) or the
    -- account is later deleted — the receipt itself is kept.
    user_id     uuid REFERENCES users (user_id) ON DELETE SET NULL,
    received_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION whatsapp_inbound_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'whatsapp_inbound is append-only (AMD-WA-02)';
END $$;

CREATE TRIGGER whatsapp_inbound_guard
    BEFORE UPDATE OR DELETE ON whatsapp_inbound
    FOR EACH ROW EXECUTE FUNCTION whatsapp_inbound_guard();

-- ------------------------------------------------------------ AMD-WA-04 --

CREATE TABLE whatsapp_deliveries (
    delivery_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    template_key text NOT NULL,
    -- One template per ref per UTC day — the reservation anchor.
    dedupe_key   text NOT NULL UNIQUE,
    -- NULL until the send succeeds (Meta's status webhooks key on it).
    wamid        text UNIQUE CHECK (wamid IS NULL OR wamid ~ '^[A-Za-z0-9._=-]{8,255}$'),
    -- 'pending' is the reserved-but-unsent state; Meta never reports it.
    status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
    error        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX whatsapp_deliveries_user_day ON whatsapp_deliveries (user_id, created_at);

ALTER TABLE whatsapp_opt_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_opt_in_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_deliveries ENABLE ROW LEVEL SECURITY;

-- The member reads their own opt-in row (the edge projects a minimal
-- projection — RLS is row-level). Events, inbound receipts and deliveries
-- are definer-only: no policies, no grants (AMD-WA-05).
CREATE POLICY whatsapp_opt_ins_select_own ON whatsapp_opt_ins
    FOR SELECT USING (user_id = app_user());

-- ------------------------------------------------------------ AMD-WA-03 --
-- Link (or re-link) a phone: the row goes pending with the verify-code
-- digest pinned. The 60-second resend cooldown applies only to a repeat
-- link of the SAME phone while one is pending — a new phone or an
-- expired attempt restarts immediately. Outcomes:
-- 'linked' | 'cooldown' | 'phone_in_use' | 'invalid_phone'
-- | 'invalid_digest' | 'forbidden'.
CREATE OR REPLACE FUNCTION whatsapp_link_phone(
    p_phone text, p_digest text, p_expires timestamptz, p_now timestamptz)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_existing whatsapp_opt_ins%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    IF p_phone IS NULL OR p_phone !~ '^\+[1-9]\d{7,14}$' THEN
        RETURN 'invalid_phone';
    END IF;
    IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
        RETURN 'invalid_digest';
    END IF;
    SELECT * INTO v_existing FROM whatsapp_opt_ins WHERE user_id = v_user FOR UPDATE;
    IF FOUND AND v_existing.state = 'pending'
       AND v_existing.phone_e164 = p_phone
       AND v_existing.verify_sent_at IS NOT NULL
       AND v_existing.verify_sent_at > p_now - interval '60 seconds' THEN
        RETURN 'cooldown';
    END IF;
    BEGIN
        INSERT INTO whatsapp_opt_ins (
            user_id, phone_e164, state, verify_digest, verify_expires_at,
            verify_attempts, verify_sent_at, linked_at, verified_at,
            stopped_at, updated_at)
        VALUES (
            v_user, p_phone, 'pending', p_digest, p_expires,
            0, p_now, p_now, NULL, NULL, p_now)
        ON CONFLICT (user_id) DO UPDATE SET
            phone_e164 = EXCLUDED.phone_e164,
            state = 'pending',
            verify_digest = EXCLUDED.verify_digest,
            verify_expires_at = EXCLUDED.verify_expires_at,
            verify_attempts = 0,
            verify_sent_at = EXCLUDED.verify_sent_at,
            verified_at = NULL,
            stopped_at = NULL,
            updated_at = EXCLUDED.updated_at;
    EXCEPTION WHEN unique_violation THEN
        -- The phone is bound to a different account.
        RETURN 'phone_in_use';
    END;
    INSERT INTO whatsapp_opt_in_events (user_id, event) VALUES (v_user, 'link_requested');
    RETURN 'linked';
END $$;

-- Redeem a verify code: the digest match moves pending -> active and
-- clears every verification field; a mismatch counts an attempt (5
-- strikes and the code is dead — a fresh link is required). Outcomes:
-- 'verified' | 'mismatch' | 'expired' | 'attempts_exceeded'
-- | 'not_pending' | 'forbidden'.
CREATE OR REPLACE FUNCTION whatsapp_verify_code(p_digest text, p_now timestamptz)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_row whatsapp_opt_ins%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_row FROM whatsapp_opt_ins WHERE user_id = v_user FOR UPDATE;
    IF NOT FOUND OR v_row.state <> 'pending' THEN
        RETURN 'not_pending';
    END IF;
    IF v_row.verify_expires_at IS NULL OR v_row.verify_expires_at <= p_now THEN
        RETURN 'expired';
    END IF;
    IF v_row.verify_attempts >= 5 THEN
        RETURN 'attempts_exceeded';
    END IF;
    IF p_digest IS NULL OR p_digest IS DISTINCT FROM v_row.verify_digest THEN
        UPDATE whatsapp_opt_ins
           SET verify_attempts = verify_attempts + 1, updated_at = p_now
         WHERE user_id = v_user;
        INSERT INTO whatsapp_opt_in_events (user_id, event) VALUES (v_user, 'verify_failed');
        RETURN 'mismatch';
    END IF;
    UPDATE whatsapp_opt_ins
       SET state = 'active',
           verify_digest = NULL,
           verify_expires_at = NULL,
           verify_attempts = 0,
           verified_at = p_now,
           stopped_at = NULL,
           updated_at = p_now
     WHERE user_id = v_user;
    INSERT INTO whatsapp_opt_in_events (user_id, event) VALUES (v_user, 'verified');
    RETURN 'verified';
END $$;

-- Unlink: the member's own revocation — a live (pending or active) row
-- goes stopped and the verification fields clear. A later re-link
-- demands a fresh code. Unlinking a row that is ALREADY stopped answers
-- 'not_linked' (there is no channel left to revoke — no duplicate
-- event). Outcomes: 'unlinked' | 'not_linked' | 'forbidden'.
CREATE OR REPLACE FUNCTION whatsapp_unlink(p_now timestamptz)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    UPDATE whatsapp_opt_ins
       SET state = 'stopped',
           verify_digest = NULL,
           verify_expires_at = NULL,
           verify_attempts = 0,
           stopped_at = p_now,
           updated_at = p_now
     WHERE user_id = v_user AND state <> 'stopped';
    IF NOT FOUND THEN
        RETURN 'not_linked';
    END IF;
    INSERT INTO whatsapp_opt_in_events (user_id, event) VALUES (v_user, 'unlinked');
    RETURN 'unlinked';
END $$;

-- ------------------------------------------------------------ AMD-WA-02 --
-- Apply one inbound message: idempotent on the wamid (Meta redelivers on
-- non-2xx), the receipt lands FIRST (even an unknown sender is recorded —
-- the receipt carries no text, only the keyword), then the keyword acts:
--   stop  -> the opt-in goes stopped, ALWAYS, from any state (the
--            member's revocation outranks every other state)
--   start -> resumes ONLY a stopped row that once verified (a pending
--            row still owes its code; an unverified row cannot resume)
--   help  -> recorded as an event; the edge answers out of band
-- Outcomes: 'recorded' | 'duplicate' | 'unknown_sender' | 'stopped'
-- | 'resumed' | 'not_resumable' | 'help' | 'invalid_wamid'
-- | 'invalid_keyword' | 'forbidden'.
CREATE OR REPLACE FUNCTION whatsapp_apply_inbound(
    p_wamid text, p_phone text, p_keyword text, p_received_at timestamptz)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_uid uuid;
    v_state text;
    v_verified timestamptz;
BEGIN
    -- NULL-safe machine gate (the batch-63 hardening): an unset GUC is
    -- false, never NULL.
    IF current_setting('app.whatsapp_callback', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF p_wamid IS NULL OR p_wamid !~ '^[A-Za-z0-9._=-]{8,255}$' THEN
        RETURN 'invalid_wamid';
    END IF;
    IF p_phone IS NULL OR p_phone !~ '^\+[1-9]\d{7,14}$' THEN
        RETURN 'invalid_phone';
    END IF;
    IF p_keyword IS NULL OR p_keyword NOT IN ('stop', 'start', 'help', 'other') THEN
        RETURN 'invalid_keyword';
    END IF;
    SELECT user_id, state, verified_at INTO v_uid, v_state, v_verified
      FROM whatsapp_opt_ins WHERE phone_e164 = p_phone;
    INSERT INTO whatsapp_inbound (wamid, phone_e164, keyword, user_id, received_at)
    VALUES (p_wamid, p_phone, p_keyword, v_uid, coalesce(p_received_at, now()))
    ON CONFLICT (wamid) DO NOTHING;
    IF NOT FOUND THEN
        RETURN 'duplicate';
    END IF;
    IF v_uid IS NULL THEN
        RETURN 'unknown_sender';
    END IF;
    IF p_keyword = 'stop' THEN
        UPDATE whatsapp_opt_ins
           SET state = 'stopped',
               verify_digest = NULL,
               verify_expires_at = NULL,
               stopped_at = coalesce(p_received_at, now()),
               updated_at = coalesce(p_received_at, now())
         WHERE user_id = v_uid AND state <> 'stopped';
        INSERT INTO whatsapp_opt_in_events (user_id, event) VALUES (v_uid, 'stopped_inbound');
        RETURN 'stopped';
    END IF;
    IF p_keyword = 'start' THEN
        IF v_state = 'stopped' AND v_verified IS NOT NULL THEN
            UPDATE whatsapp_opt_ins
               SET state = 'active',
                   stopped_at = NULL,
                   updated_at = coalesce(p_received_at, now())
             WHERE user_id = v_uid;
            INSERT INTO whatsapp_opt_in_events (user_id, event) VALUES (v_uid, 'resumed_inbound');
            RETURN 'resumed';
        END IF;
        RETURN 'not_resumable';
    END IF;
    IF p_keyword = 'help' THEN
        INSERT INTO whatsapp_opt_in_events (user_id, event) VALUES (v_uid, 'help_requested');
        RETURN 'help';
    END IF;
    RETURN 'recorded';
END $$;

-- Apply one delivery-status webhook: monotonic advance only
-- (pending < sent < delivered < read; 'failed' is terminal from any
-- state) — out-of-order arrivals answer 'stale', unknown wamids 'unknown'.
-- Outcomes: 'updated' | 'stale' | 'unknown' | 'invalid_status' | 'forbidden'.
CREATE OR REPLACE FUNCTION whatsapp_apply_status(
    p_wamid text, p_status text, p_error text DEFAULT NULL)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF current_setting('app.whatsapp_callback', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF p_wamid IS NULL OR p_wamid !~ '^[A-Za-z0-9._=-]{8,255}$' THEN
        RETURN 'invalid_wamid';
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('sent', 'delivered', 'read', 'failed') THEN
        RETURN 'invalid_status';
    END IF;
    UPDATE whatsapp_deliveries
       SET status = p_status,
           error = CASE WHEN p_status = 'failed' THEN coalesce(p_error, error)
                        ELSE error END,
           updated_at = now()
     WHERE wamid = p_wamid
       AND (p_status = 'failed'
            OR (status = 'pending' AND p_status IN ('sent', 'delivered', 'read'))
            OR (status = 'sent' AND p_status IN ('delivered', 'read'))
            OR (status = 'delivered' AND p_status = 'read'));
    IF NOT FOUND THEN
        IF EXISTS (SELECT 1 FROM whatsapp_deliveries WHERE wamid = p_wamid) THEN
            RETURN 'stale';
        END IF;
        RETURN 'unknown';
    END IF;
    RETURN 'updated';
END $$;

-- ------------------------------------------------------------ AMD-WA-04 --
-- The dispatch leg's target lookup: the ACTIVE opt-in phone for a member,
-- or NULL (no row, pending, stopped). The stopped member always wins —
-- no category, not even safety, resurrects a revoked channel.
CREATE OR REPLACE FUNCTION whatsapp_dispatch_target(p_user uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF current_setting('app.whatsapp_callback', true) IS DISTINCT FROM 'on' THEN
        RETURN NULL;
    END IF;
    RETURN (SELECT phone_e164 FROM whatsapp_opt_ins
             WHERE user_id = p_user AND state = 'active');
END $$;

-- Reserve a delivery slot BEFORE the network send: the daily cap counts
-- the last 24 hours of reservations; the dedupe key (template:ref:day)
-- collapses retries. The row lands 'pending'. Outcomes:
-- 'recorded' | 'duplicate' | 'capped' | 'invalid_cap' | 'forbidden'.
CREATE OR REPLACE FUNCTION whatsapp_record_delivery(
    p_user uuid, p_template text, p_dedupe text, p_cap integer)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF current_setting('app.whatsapp_callback', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF p_user IS NULL OR p_template IS NULL OR p_dedupe IS NULL THEN
        RETURN 'invalid_request';
    END IF;
    IF p_cap IS NULL OR p_cap < 1 THEN
        RETURN 'invalid_cap';
    END IF;
    IF (SELECT count(*) FROM whatsapp_deliveries
         WHERE user_id = p_user
           AND created_at > now() - interval '24 hours') >= p_cap THEN
        RETURN 'capped';
    END IF;
    INSERT INTO whatsapp_deliveries (user_id, template_key, dedupe_key)
    VALUES (p_user, p_template, p_dedupe)
    ON CONFLICT (dedupe_key) DO NOTHING;
    IF NOT FOUND THEN
        RETURN 'duplicate';
    END IF;
    RETURN 'recorded';
END $$;

-- Finalize a reservation with the send outcome: sent pins the wamid,
-- failed pins the reason. Only a 'pending' row finalizes — a double
-- finalize answers 'unknown'. Outcomes: 'updated' | 'unknown' | 'forbidden'.
CREATE OR REPLACE FUNCTION whatsapp_finalize_delivery(
    p_user uuid, p_dedupe text, p_wamid text, p_ok boolean, p_error text DEFAULT NULL)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF current_setting('app.whatsapp_callback', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    UPDATE whatsapp_deliveries
       SET status = CASE WHEN p_ok THEN 'sent' ELSE 'failed' END,
           wamid = CASE WHEN p_ok THEN p_wamid ELSE NULL END,
           error = CASE WHEN p_ok THEN NULL ELSE coalesce(p_error, 'send failed') END,
           updated_at = now()
     WHERE user_id = p_user AND dedupe_key = p_dedupe AND status = 'pending';
    IF NOT FOUND THEN
        RETURN 'unknown';
    END IF;
    RETURN 'updated';
END $$;

-- ------------------------------------------------------------ AMD-WA-05 --
-- The FR-62 export gains the WhatsApp channel record — the opt-in state,
-- the member's own phone and the consent event history.
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
                       WHERE s.applicant = uid), '[]'::jsonb),
        -- AMD-WA-05: the WhatsApp channel — the member's own opt-in row
        -- (full phone: this is their export) and the event history.
        -- Inbound receipts are keyword-only by construction and are not
        -- enumerated here; deliveries are operational, not member data.
        'whatsapp', (SELECT jsonb_build_object(
                        'state', w.state,
                        'phone', w.phone_e164,
                        'linkedAt', w.linked_at,
                        'verifiedAt', w.verified_at,
                        'stoppedAt', w.stopped_at,
                        'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                'event', e.event, 'at', e.at) ORDER BY e.at)
                            FROM whatsapp_opt_in_events e
                            WHERE e.user_id = w.user_id), '[]'::jsonb))
                       FROM whatsapp_opt_ins w WHERE w.user_id = uid)
    )
$$;

-- ------------------------------------------------------------ grants -------
GRANT SELECT ON whatsapp_opt_ins TO presence_app;

REVOKE ALL ON FUNCTION whatsapp_link_phone(text, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_verify_code(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_unlink(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_apply_inbound(text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_apply_status(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_dispatch_target(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_record_delivery(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_finalize_delivery(uuid, text, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_opt_in_events_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION whatsapp_inbound_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_link_phone(text, text, timestamptz, timestamptz) TO presence_app;
GRANT EXECUTE ON FUNCTION whatsapp_verify_code(text, timestamptz) TO presence_app;
GRANT EXECUTE ON FUNCTION whatsapp_unlink(timestamptz) TO presence_app;
GRANT EXECUTE ON FUNCTION whatsapp_apply_inbound(text, text, text, timestamptz) TO presence_app;
GRANT EXECUTE ON FUNCTION whatsapp_apply_status(text, text, text) TO presence_app;
GRANT EXECUTE ON FUNCTION whatsapp_dispatch_target(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION whatsapp_record_delivery(uuid, text, text, integer) TO presence_app;
GRANT EXECUTE ON FUNCTION whatsapp_finalize_delivery(uuid, text, text, boolean, text) TO presence_app;
GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app;

COMMIT;
