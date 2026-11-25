-- Presence — P2P transfer contracts (SRS Addendum 001: AMD-PAY-03..08)
--
-- Requirement anchors:
--   AMD-PAY-01  P2P transfers between KYC-verified accounts only, through
--               the structured transfer surface — transfer fees are the
--               sixth revenue line admitted by the BR-06 revision
--   AMD-PAY-03  the transfer object is amount + currency + fee + state —
--               no memo, note or message field exists by construction
--   AMD-PAY-04  dual consent, eight legal transitions, enforced by the
--               record_transfer_event definer — endpoint logic cannot
--               excuse an illegal move (FR-29 trigger discipline)
--   AMD-PAY-05  per-transfer cap 5,000,000 minor (NGN 50,000.00), rolling
--               24 h sender cap 15,000,000 minor (NGN 150,000.00), fee
--               100 bps computed here and stored on the row
--   AMD-PAY-06  eligibility proved twice — both parties kyc-verified with
--               an OPEN conversation and no payment_instrument suspension
--               at proposal; KYC and the OPEN pair re-proved at acceptance
--   AMD-PAY-07  transfer_events is append-only for every application path
--   AMD-PAY-08  'settled' is reachable only through the transaction-local
--               app.transfer_settlement setting, which no P0 component
--               sets — the TECH-23 deployment gate stands
--
-- Forward-only migration; run after 0024_kyc_avatars.sql.

BEGIN;

-- ------------------------------------------------- AMD-PAY-03 -------------
CREATE TABLE transfers (
    transfer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_id     uuid NOT NULL REFERENCES matches (pair_id),
    sender      uuid NOT NULL REFERENCES users (user_id),
    recipient   uuid NOT NULL REFERENCES users (user_id),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    fee_minor    bigint NOT NULL CHECK (fee_minor >= 0),
    currency    text NOT NULL CHECK (currency = 'NGN'),
    state       text NOT NULL DEFAULT 'proposed'
        CHECK (state IN ('proposed', 'accepted', 'declined', 'cancelled',
                         'expired', 'settled', 'disputed', 'resolved')),
    proposed_at timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    resolved_outcome text CHECK (resolved_outcome IN ('upheld', 'rejected')),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (sender <> recipient)
);

CREATE INDEX transfers_sender_window ON transfers (sender, proposed_at);

-- The ledger (AMD-PAY-07): every transition lands a row; the pair history
-- is reconstructable from this table alone. No personal data beyond
-- actors, amounts and states — there is no free text to leak.
CREATE TABLE transfer_events (
    event_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id uuid NOT NULL REFERENCES transfers (transfer_id),
    actor       uuid,                -- NULL for the clock (expiry)
    event       text NOT NULL,
    detail      jsonb NOT NULL DEFAULT '{}',
    at          timestamptz NOT NULL DEFAULT now()
);

-- Party-scoped reads: RLS keeps a transfer visible to its two parties
-- only; writes flow exclusively through the definers below.
ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY transfers_party_select ON transfers FOR SELECT
    USING (app_user() IN (sender, recipient));

CREATE POLICY transfer_events_party_select ON transfer_events FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM transfers t
         WHERE t.transfer_id = transfer_events.transfer_id
           AND app_user() IN (t.sender, t.recipient)));

GRANT SELECT ON transfers TO presence_app;
GRANT SELECT ON transfer_events TO presence_app;
-- No INSERT/UPDATE/DELETE grants: propose_transfer and
-- record_transfer_event are the only writers (SECURITY DEFINER).

-- ------------------------------------------------- AMD-PAY-07 -------------
CREATE OR REPLACE FUNCTION transfer_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'transfer_events is append-only (AMD-PAY-07)';
END $$;

CREATE TRIGGER transfer_events_append_only
    BEFORE UPDATE OR DELETE ON transfer_events
    FOR EACH ROW EXECUTE FUNCTION transfer_events_append_only();

-- ------------------------------------------------- AMD-PAY-05/06 ----------
-- Proposal: every refusal is decided here, under one lock-free read set,
-- so the route learns nothing it could leak. Outcomes:
--   'proposed' | 'forbidden' | 'invalid_amount' | 'over_transfer_cap'
--   | 'over_daily_cap' | 'not_kyc_verified' | 'suspended'
--   | 'no_open_conversation'
CREATE OR REPLACE FUNCTION propose_transfer(
    p_sender uuid, p_recipient uuid, p_amount_minor bigint)
RETURNS TABLE(outcome text, transfer_id uuid, fee_minor bigint, expires_at timestamptz)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_pair    uuid;
    v_daily   bigint;
    v_fee     bigint;
    v_expires timestamptz;
    v_id      uuid;
BEGIN
    -- The definer bypasses RLS: the sender claim MUST be the caller's own.
    IF p_sender IS NULL OR p_sender IS DISTINCT FROM app_user() THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;
    IF p_recipient IS NULL OR p_recipient = p_sender
        OR p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
        RETURN QUERY SELECT 'invalid_amount', NULL::uuid, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;
    -- AMD-PAY-05: per-transfer cap (NGN 50,000.00).
    IF p_amount_minor > 5000000 THEN
        RETURN QUERY SELECT 'over_transfer_cap', NULL::uuid, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;
    -- AMD-PAY-06: both parties KYC-verified, no payment suspension, and an
    -- OPEN conversation — money moves only inside consent.
    IF NOT EXISTS (SELECT 1 FROM kyc_verified_accounts WHERE user_id = p_sender)
        OR NOT EXISTS (SELECT 1 FROM kyc_verified_accounts WHERE user_id = p_recipient) THEN
        RETURN QUERY SELECT 'not_kyc_verified', NULL::uuid, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;
    IF has_active_suspension(p_sender, 'payment_instrument')
        OR has_active_suspension(p_recipient, 'payment_instrument') THEN
        RETURN QUERY SELECT 'suspended', NULL::uuid, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;
    SELECT m.pair_id INTO v_pair
      FROM matches m
     WHERE m.state = 'OPEN'
       AND p_sender IN (m.user_lo, m.user_hi)
       AND p_recipient IN (m.user_lo, m.user_hi);
    IF v_pair IS NULL THEN
        RETURN QUERY SELECT 'no_open_conversation', NULL::uuid, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;
    -- AMD-PAY-05: rolling 24 h sender cap (NGN 150,000.00) over money in
    -- motion — declined/cancelled/expired/resolved rows no longer count.
    SELECT coalesce(sum(t.amount_minor), 0) INTO v_daily
      FROM transfers t
     WHERE t.sender = p_sender
       AND t.state IN ('proposed', 'accepted', 'settled', 'disputed')
       AND t.proposed_at > now() - interval '24 hours';
    IF v_daily + p_amount_minor > 15000000 THEN
        RETURN QUERY SELECT 'over_daily_cap', NULL::uuid, NULL::bigint, NULL::timestamptz;
        RETURN;
    END IF;
    v_fee := (p_amount_minor * 100) / 10000;  -- AMD-PAY-05: 100 bps, floor
    v_expires := now() + interval '1 hour';   -- AMD-PAY-06: acceptance window
    INSERT INTO transfers (pair_id, sender, recipient, amount_minor, fee_minor, expires_at)
    VALUES (v_pair, p_sender, p_recipient, p_amount_minor, v_fee, v_expires)
    RETURNING transfers.transfer_id INTO v_id;
    INSERT INTO transfer_events (transfer_id, actor, event, detail)
    VALUES (v_id, p_sender, 'proposed',
            jsonb_build_object('amount_minor', p_amount_minor, 'fee_minor', v_fee));
    RETURN QUERY SELECT 'proposed', v_id, v_fee, v_expires;
END $$;

-- ------------------------------------------------- AMD-PAY-04/08 ----------
-- One atomic transition step: legality and role enforced here, ledgered
-- here. Returns 'recorded' | 'unknown_transfer' | 'illegal_transition'
-- | 'forbidden' | 'wrong_actor' | 'not_expired' | 'not_kyc_verified'
-- | 'pair_not_open'.
CREATE OR REPLACE FUNCTION record_transfer_event(
    p_transfer uuid, p_actor uuid, p_event text, p_detail jsonb DEFAULT '{}')
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v record;
BEGIN
    SELECT state, sender, recipient, expires_at INTO v
      FROM transfers WHERE transfer_id = p_transfer FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_transfer';
    END IF;
    IF p_event NOT IN ('accepted', 'declined', 'cancelled', 'expired',
                       'settled', 'disputed', 'resolved') THEN
        RETURN 'illegal_transition';
    END IF;
    -- AMD-PAY-04: the legal-transition table (mirrored in
    -- services/edge/src/transfers.ts and client/src/presence/transferCard.ts
    -- — tests/test_batch49.py cross-pins all three).
    IF NOT (
        (v.state = 'proposed' AND p_event IN ('accepted', 'declined', 'cancelled', 'expired')) OR
        (v.state = 'accepted' AND p_event IN ('settled', 'disputed')) OR
        (v.state = 'settled'  AND p_event = 'disputed') OR
        (v.state = 'disputed' AND p_event = 'resolved')
    ) THEN
        RETURN 'illegal_transition';
    END IF;
    -- Caller-bound events must come from the caller: the definer bypasses
    -- RLS, so an actor claim is worthless unless it is the requester.
    IF p_event IN ('accepted', 'declined', 'cancelled', 'disputed')
        AND p_actor IS DISTINCT FROM app_user() THEN
        RETURN 'forbidden';
    END IF;
    -- AMD-PAY-04: the recipient answers, the sender cancels, either party
    -- disputes.
    IF p_event IN ('accepted', 'declined') AND p_actor <> v.recipient THEN
        RETURN 'wrong_actor';
    END IF;
    IF p_event = 'cancelled' AND p_actor <> v.sender THEN
        RETURN 'wrong_actor';
    END IF;
    IF p_event = 'disputed' AND p_actor NOT IN (v.sender, v.recipient) THEN
        RETURN 'wrong_actor';
    END IF;
    IF p_event = 'expired' THEN
        IF now() < v.expires_at THEN
            RETURN 'not_expired';
        END IF;
        IF p_actor IS NOT NULL AND p_actor NOT IN (v.sender, v.recipient) THEN
            RETURN 'wrong_actor';
        END IF;
    END IF;
    -- AMD-PAY-08: the rail alone settles. No P0 component sets this
    -- transaction-local flag — the TECH-23 gate made tangible.
    IF p_event = 'settled'
        AND current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF p_event = 'resolved' THEN
        IF NOT app_moderator() THEN
            RETURN 'forbidden';
        END IF;
        IF p_detail->>'outcome' NOT IN ('upheld', 'rejected') THEN
            RETURN 'illegal_transition';
        END IF;
    END IF;
    -- AMD-PAY-06: acceptance re-proves eligibility — a KYC state or a
    -- conversation can move between proposal and acceptance.
    IF p_event = 'accepted' THEN
        IF NOT EXISTS (SELECT 1 FROM kyc_verified_accounts WHERE user_id = v.sender)
            OR NOT EXISTS (SELECT 1 FROM kyc_verified_accounts WHERE user_id = v.recipient) THEN
            RETURN 'not_kyc_verified';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM matches m
             WHERE m.state = 'OPEN'
               AND v.sender IN (m.user_lo, m.user_hi)
               AND v.recipient IN (m.user_lo, m.user_hi)
        ) THEN
            RETURN 'pair_not_open';
        END IF;
    END IF;
    UPDATE transfers
       SET state = p_event,
           resolved_outcome = CASE WHEN p_event = 'resolved'
                                   THEN p_detail->>'outcome'
                                   ELSE resolved_outcome END,
           updated_at = now()
     WHERE transfer_id = p_transfer;
    INSERT INTO transfer_events (transfer_id, actor, event, detail)
    VALUES (p_transfer, p_actor, p_event, coalesce(p_detail, '{}'::jsonb));
    IF p_event = 'resolved' THEN
        PERFORM admin_audit_log(
            p_actor,
            'transfer.resolved',
            p_detail->>'outcome',
            'transfer', p_transfer::text,
            jsonb_build_object('state', v.state),
            p_detail
        );
    END IF;
    RETURN 'recorded';
END $$;

-- Lazy expiry (mirrors expire_elevations): the list read and the proposal
-- path call this first, so a stale proposal never lingers past its window.
CREATE OR REPLACE FUNCTION expire_stale_transfers() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    r record;
    n integer := 0;
BEGIN
    FOR r IN
        SELECT transfer_id FROM transfers
         WHERE state = 'proposed' AND expires_at <= now()
    LOOP
        PERFORM record_transfer_event(r.transfer_id, NULL, 'expired');
        n := n + 1;
    END LOOP;
    RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION expire_stale_transfers() TO presence_app;

COMMIT;
