-- Presence — wallet rail activation (SRS Addendum 001: AMD-PAY-15..20)
--
-- Requirement anchors:
--   AMD-PAY-15  the internal NGN ledger rail is LIVE: the edge sets
--               app.transfer_settlement transaction-locally on exactly
--               the wires that move value, behind the WALLET_RAIL
--               operational kill switch; every definer keeps the GUC
--               check as defence in depth. The TECH-23 gate now covers
--               only the external Mojaloop/TigerBeetle rails
--   AMD-PAY-16  fund-in: signed provider callback or moderation credit;
--               idempotent on the rail reference; a per-event cap
--   AMD-PAY-17  withdrawals: hold-backed two-phase payout requests,
--               owner-cancel while requested, moderation decision,
--               provider completion; per-withdrawal and rolling 24 h caps
--   AMD-PAY-18  accepting a transfer settles it atomically on the wallet
--               rail: accept, hold and settle in one transaction — the
--               accept either lands fully funded or not at all
--   AMD-PAY-19  reconciliation: a moderator-only definer re-derives every
--               balance from the ledger and proves the fee account
--   AMD-PAY-20  the FR-62 export carries the withdrawal history
--
-- Forward-only migration; run after 0027_wallets.sql.

BEGIN;

-- ------------------------------------------------- AMD-PAY-16/17 ----------
-- Rail events: one row per external rail reference, so a provider callback
-- replayed (deliberately or by retry) can never move value twice. No free
-- text — reference, kind, target, amount, outcome.
CREATE TABLE wallet_rail_events (
    reference    text PRIMARY KEY
        CHECK (char_length(reference) BETWEEN 8 AND 128),
    kind         text NOT NULL CHECK (kind IN ('fund', 'payout')),
    wallet_id    uuid REFERENCES wallets (wallet_id),
    request_id   uuid,
    amount_minor bigint CHECK (amount_minor > 0),
    outcome      text NOT NULL,
    at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE wallet_rail_events ENABLE ROW LEVEL SECURITY;
-- No policies and no grants: the definers (SECURITY DEFINER) are the only
-- readers and writers; moderation visibility flows through the audit log
-- and wallet_reconciliation.

-- ------------------------------------------------- AMD-PAY-17 -------------
-- Withdrawal requests. The destination is an opaque provider-side
-- reference (a payout recipient token), never raw bank details — the
-- minimisation discipline of AMD-KYC-03 applied to payouts. The hold names
-- the request through hold_id; terms are immutable, transitions are the
-- pinned lifecycle and nothing else.
CREATE TABLE withdrawal_requests (
    request_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id   uuid NOT NULL REFERENCES wallets (wallet_id),
    hold_id     uuid REFERENCES wallet_holds (hold_id),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    destination_ref text NOT NULL
        CHECK (char_length(destination_ref) BETWEEN 8 AND 128),
    state       text NOT NULL DEFAULT 'requested'
        CHECK (state IN ('requested', 'processing', 'paid', 'failed', 'cancelled')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

CREATE INDEX withdrawal_requests_wallet ON withdrawal_requests (wallet_id, created_at);
CREATE INDEX withdrawal_requests_open ON withdrawal_requests (state)
    WHERE state IN ('requested', 'processing');

ALTER TABLE withdrawal_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY withdrawal_requests_owner_select ON withdrawal_requests FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM wallets w
         WHERE w.wallet_id = withdrawal_requests.wallet_id
           AND w.owner = app_user()));

GRANT SELECT ON withdrawal_requests TO presence_app;
-- No INSERT/UPDATE/DELETE grants: the definers are the only writers.

CREATE OR REPLACE FUNCTION withdrawal_requests_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'withdrawal_requests is append-only (AMD-PAY-17)';
    END IF;
    IF NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
        OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
        OR NEW.destination_ref IS DISTINCT FROM OLD.destination_ref
        OR NEW.hold_id IS DISTINCT FROM OLD.hold_id THEN
        RAISE EXCEPTION 'withdrawal request terms are immutable (AMD-PAY-17)';
    END IF;
    IF NOT (
        (OLD.state = 'requested'  AND NEW.state IN ('processing', 'failed', 'cancelled')) OR
        (OLD.state = 'processing' AND NEW.state IN ('paid', 'failed'))
    ) THEN
        RAISE EXCEPTION 'illegal withdrawal transition (AMD-PAY-17)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER withdrawal_requests_guard
    BEFORE UPDATE OR DELETE ON withdrawal_requests
    FOR EACH ROW EXECUTE FUNCTION withdrawal_requests_guard();

-- ------------------------------------------------- AMD-PAY-16 -------------
-- Fund-in. Value enters ONLY through an authenticated rail: the provider
-- callback GUC (app.funding_callback, set by the HMAC-verified webhook) or
-- a moderator (manual credit during the pilot). The settlement gate of
-- AMD-PAY-13/15 applies unchanged. Idempotent on the rail reference.
-- Outcomes: 'funded' | 'duplicate_reference' | 'forbidden'
-- | 'invalid_amount' | 'over_funding_cap' | 'invalid_reference'
-- | 'unknown_wallet' | 'wallet_not_active'.
CREATE OR REPLACE FUNCTION fund_wallet(
    p_wallet uuid, p_amount_minor bigint, p_reference text)
RETURNS TABLE(outcome text, balance_minor bigint)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_status  text;
    v_balance bigint;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::bigint;
        RETURN;
    END IF;
    IF current_setting('app.funding_callback', true) IS DISTINCT FROM 'on'
        AND NOT app_moderator() THEN
        RETURN QUERY SELECT 'forbidden', NULL::bigint;
        RETURN;
    END IF;
    IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
        RETURN QUERY SELECT 'invalid_amount', NULL::bigint;
        RETURN;
    END IF;
    -- AMD-PAY-16: per-event funding cap (NGN 150,000.00), aligned with the
    -- AMD-PAY-05 daily movement cap.
    IF p_amount_minor > 15000000 THEN
        RETURN QUERY SELECT 'over_funding_cap', NULL::bigint;
        RETURN;
    END IF;
    IF p_reference IS NULL OR char_length(p_reference) NOT BETWEEN 8 AND 128 THEN
        RETURN QUERY SELECT 'invalid_reference', NULL::bigint;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM wallet_rail_events r
                WHERE r.reference = p_reference AND r.kind = 'fund') THEN
        RETURN QUERY SELECT 'duplicate_reference', NULL::bigint;
        RETURN;
    END IF;
    SELECT w.status INTO v_status FROM wallets w
     WHERE w.wallet_id = p_wallet FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_wallet', NULL::bigint;
        RETURN;
    END IF;
    IF v_status <> 'active' THEN
        RETURN QUERY SELECT 'wallet_not_active', NULL::bigint;
        RETURN;
    END IF;
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_balance
      FROM wallet_entries e WHERE e.wallet_id = p_wallet;
    v_balance := v_balance + p_amount_minor;
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)
    VALUES (p_wallet, 'fund', p_amount_minor, v_balance);
    INSERT INTO wallet_rail_events (reference, kind, wallet_id, amount_minor, outcome)
    VALUES (p_reference, 'fund', p_wallet, p_amount_minor, 'funded');
    IF app_moderator()
        AND current_setting('app.funding_callback', true) IS DISTINCT FROM 'on' THEN
        PERFORM admin_audit_log(
            app_user(),
            'wallet.credit',
            'manual_credit',
            'wallet', p_wallet::text,
            NULL,
            jsonb_build_object('amount_minor', p_amount_minor, 'reference', p_reference)
        );
    END IF;
    RETURN QUERY SELECT 'funded', v_balance;
END $$;

-- ------------------------------------------------- AMD-PAY-17 -------------
-- Withdrawal request: owner self-serve, atomically reserving the amount
-- with a pending hold (no transfer — holds may name a transfer or not).
-- Caps mirror AMD-PAY-05: 5,000,000 minor per withdrawal, 15,000,000
-- rolling 24 h over money in motion (requested, processing, paid).
-- Outcomes: 'requested' | 'forbidden' | 'invalid_amount'
-- | 'over_withdrawal_cap' | 'over_daily_cap' | 'invalid_destination'
-- | 'unknown_wallet' | 'wallet_not_active' | 'insufficient_funds'.
CREATE OR REPLACE FUNCTION request_withdrawal(
    p_wallet uuid, p_amount_minor bigint, p_destination_ref text)
RETURNS TABLE(outcome text, request_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_owner   uuid;
    v_status  text;
    v_balance bigint;
    v_held    bigint;
    v_daily   bigint;
    v_hold    uuid;
    v_id      uuid;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    -- The definer bypasses RLS: the wallet claim MUST be the caller's own.
    SELECT w.owner, w.status INTO v_owner, v_status FROM wallets w
     WHERE w.wallet_id = p_wallet FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_wallet', NULL::uuid;
        RETURN;
    END IF;
    IF v_owner IS NULL OR v_owner IS DISTINCT FROM app_user() THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF v_status <> 'active' THEN
        RETURN QUERY SELECT 'wallet_not_active', NULL::uuid;
        RETURN;
    END IF;
    IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
        RETURN QUERY SELECT 'invalid_amount', NULL::uuid;
        RETURN;
    END IF;
    IF p_amount_minor > 5000000 THEN
        RETURN QUERY SELECT 'over_withdrawal_cap', NULL::uuid;
        RETURN;
    END IF;
    IF p_destination_ref IS NULL
        OR char_length(p_destination_ref) NOT BETWEEN 8 AND 128 THEN
        RETURN QUERY SELECT 'invalid_destination', NULL::uuid;
        RETURN;
    END IF;
    SELECT COALESCE(sum(r.amount_minor), 0) INTO v_daily
      FROM withdrawal_requests r
     WHERE r.wallet_id = p_wallet
       AND r.state IN ('requested', 'processing', 'paid')
       AND r.created_at > now() - interval '24 hours';
    IF v_daily + p_amount_minor > 15000000 THEN
        RETURN QUERY SELECT 'over_daily_cap', NULL::uuid;
        RETURN;
    END IF;
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_balance
      FROM wallet_entries e WHERE e.wallet_id = p_wallet;
    SELECT COALESCE(sum(h.amount_minor), 0) INTO v_held
      FROM wallet_holds h
     WHERE h.wallet_id = p_wallet AND h.state = 'pending';
    IF p_amount_minor > v_balance - v_held THEN
        RETURN QUERY SELECT 'insufficient_funds', NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO wallet_holds (wallet_id, transfer_id, amount_minor)
    VALUES (p_wallet, NULL, p_amount_minor)
    RETURNING wallet_holds.hold_id INTO v_hold;
    INSERT INTO withdrawal_requests (wallet_id, hold_id, amount_minor, destination_ref)
    VALUES (p_wallet, v_hold, p_amount_minor, p_destination_ref)
    RETURNING withdrawal_requests.request_id INTO v_id;
    RETURN QUERY SELECT 'requested', v_id;
END $$;

-- Owner cancel while the request is still 'requested': the hold is voided
-- and the reservation released. Outcomes:
-- 'cancelled' | 'forbidden' | 'unknown_request' | 'illegal_state'.
CREATE OR REPLACE FUNCTION cancel_withdrawal(p_request uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    r record;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT r.request_id, r.state, r.hold_id, w.owner INTO r
      FROM withdrawal_requests r
      JOIN wallets w ON w.wallet_id = r.wallet_id
     WHERE r.request_id = p_request FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_request';
    END IF;
    IF r.owner IS NULL OR r.owner IS DISTINCT FROM app_user() THEN
        RETURN 'forbidden';
    END IF;
    IF r.state <> 'requested' THEN
        RETURN 'illegal_state';
    END IF;
    UPDATE withdrawal_requests SET state = 'cancelled', resolved_at = now()
     WHERE request_id = p_request;
    UPDATE wallet_holds SET state = 'voided', resolved_at = now()
     WHERE hold_id = r.hold_id AND state = 'pending';
    RETURN 'cancelled';
END $$;

-- Moderation decision: approve moves the request to 'processing' (the
-- payout provider is instructed), reject fails it and voids the hold.
-- Both land in the admin audit log. Outcomes:
-- 'decided' | 'forbidden' | 'unknown_request' | 'illegal_state'
-- | 'illegal_decision'.
CREATE OR REPLACE FUNCTION decide_withdrawal(p_request uuid, p_decision text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    r record;
    v_new text;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF NOT app_moderator() THEN
        RETURN 'forbidden';
    END IF;
    IF p_decision NOT IN ('approve', 'reject') THEN
        RETURN 'illegal_decision';
    END IF;
    SELECT r.request_id, r.state, r.hold_id INTO r
      FROM withdrawal_requests r
     WHERE r.request_id = p_request FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_request';
    END IF;
    IF r.state <> 'requested' THEN
        RETURN 'illegal_state';
    END IF;
    v_new := CASE WHEN p_decision = 'approve' THEN 'processing' ELSE 'failed' END;
    UPDATE withdrawal_requests
       SET state = v_new,
           resolved_at = CASE WHEN v_new = 'failed' THEN now() ELSE NULL END
     WHERE request_id = p_request;
    IF v_new = 'failed' THEN
        UPDATE wallet_holds SET state = 'voided', resolved_at = now()
         WHERE hold_id = r.hold_id AND state = 'pending';
    END IF;
    PERFORM admin_audit_log(
        app_user(),
        'wallet.withdrawal_decision',
        p_decision,
        'withdrawal_request', p_request::text,
        jsonb_build_object('state', r.state),
        jsonb_build_object('state', v_new)
    );
    RETURN 'decided';
END $$;

-- Payout completion (provider callback or moderator): the hold is posted
-- FIRST, then the withdrawal entry lands — posting releases the
-- reservation so wallet_move's availability check sees the true balance.
-- Idempotent on the rail reference. Outcomes:
-- 'paid' | 'duplicate_reference' | 'forbidden' | 'unknown_request'
-- | 'illegal_state' | 'insufficient_funds'.
CREATE OR REPLACE FUNCTION complete_withdrawal(p_request uuid, p_reference text)
RETURNS TABLE(outcome text, balance_minor bigint)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    r record;
    v_move record;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::bigint;
        RETURN;
    END IF;
    IF current_setting('app.payout_callback', true) IS DISTINCT FROM 'on'
        AND NOT app_moderator() THEN
        RETURN QUERY SELECT 'forbidden', NULL::bigint;
        RETURN;
    END IF;
    IF p_reference IS NULL OR char_length(p_reference) NOT BETWEEN 8 AND 128 THEN
        RETURN QUERY SELECT 'invalid_reference', NULL::bigint;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM wallet_rail_events e
                WHERE e.reference = p_reference AND e.kind = 'payout') THEN
        RETURN QUERY SELECT 'duplicate_reference', NULL::bigint;
        RETURN;
    END IF;
    SELECT r.request_id, r.state, r.hold_id, r.wallet_id, r.amount_minor INTO r
      FROM withdrawal_requests r
     WHERE r.request_id = p_request FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_request', NULL::bigint;
        RETURN;
    END IF;
    IF r.state <> 'processing' THEN
        RETURN QUERY SELECT 'illegal_state', NULL::bigint;
        RETURN;
    END IF;
    -- Post the reservation, then debit: value leaves exactly once.
    UPDATE wallet_holds SET state = 'posted', resolved_at = now()
     WHERE hold_id = r.hold_id AND state = 'pending';
    SELECT m.outcome, m.balance_minor INTO v_move
      FROM wallet_move(r.wallet_id, 'withdrawal', r.amount_minor) m;
    IF v_move.outcome <> 'moved' THEN
        RETURN QUERY SELECT v_move.outcome, NULL::bigint;
        RETURN;
    END IF;
    UPDATE withdrawal_requests SET state = 'paid', resolved_at = now()
     WHERE request_id = p_request;
    INSERT INTO wallet_rail_events (reference, kind, wallet_id, request_id, amount_minor, outcome)
    VALUES (p_reference, 'payout', r.wallet_id, p_request, r.amount_minor, 'paid');
    RETURN QUERY SELECT 'paid', v_move.balance_minor;
END $$;

-- Payout failure: the request fails and the hold is voided, returning the
-- reservation to the spendable balance. Outcomes:
-- 'failed' | 'forbidden' | 'unknown_request' | 'illegal_state'
-- | 'invalid_reference' | 'duplicate_reference'.
CREATE OR REPLACE FUNCTION fail_withdrawal(p_request uuid, p_reference text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    r record;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF current_setting('app.payout_callback', true) IS DISTINCT FROM 'on'
        AND NOT app_moderator() THEN
        RETURN 'forbidden';
    END IF;
    IF p_reference IS NULL OR char_length(p_reference) NOT BETWEEN 8 AND 128 THEN
        RETURN 'invalid_reference';
    END IF;
    IF EXISTS (SELECT 1 FROM wallet_rail_events e
                WHERE e.reference = p_reference AND e.kind = 'payout') THEN
        RETURN 'duplicate_reference';
    END IF;
    SELECT r.request_id, r.state, r.hold_id, r.wallet_id, r.amount_minor INTO r
      FROM withdrawal_requests r
     WHERE r.request_id = p_request FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_request';
    END IF;
    IF r.state <> 'processing' THEN
        RETURN 'illegal_state';
    END IF;
    UPDATE withdrawal_requests SET state = 'failed', resolved_at = now()
     WHERE request_id = p_request;
    UPDATE wallet_holds SET state = 'voided', resolved_at = now()
     WHERE hold_id = r.hold_id AND state = 'pending';
    INSERT INTO wallet_rail_events (reference, kind, wallet_id, request_id, amount_minor, outcome)
    VALUES (p_reference, 'payout', r.wallet_id, p_request, r.amount_minor, 'failed');
    RETURN 'failed';
END $$;

-- ------------------------------------------------- AMD-PAY-18 -------------
-- Accept-and-settle: the wallet rail makes acceptance final. The recipient
-- accepts; the sender's wallet is hold-charged amount + fee and the
-- transfer settles in the SAME transaction — the accept either lands
-- fully funded or not at all, and the transfer stays 'proposed' when the
-- sender cannot cover it. AMD-PAY-04/06 discipline is preserved by
-- delegating the state move to record_transfer_event (KYC and the OPEN
-- pair re-proved there) and the value move to settle_transfer_funds
-- (suspensions re-proved there). Outcomes:
-- 'settled' | 'forbidden' | 'unknown_transfer' | 'illegal_state'
-- | 'wrong_actor' | 'expired' | 'not_kyc_verified' | 'pair_not_open'
-- | 'suspended' | 'no_wallet' | 'wallet_not_active' | 'insufficient_funds'.
CREATE OR REPLACE FUNCTION accept_transfer_and_settle(p_transfer uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t record;
    v_wallet  uuid;
    v_balance bigint;
    v_held    bigint;
    v_hold    record;
    v_step    text;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT tr.state, tr.sender, tr.recipient, tr.amount_minor, tr.fee_minor,
           tr.expires_at
      INTO t FROM transfers tr WHERE tr.transfer_id = p_transfer FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_transfer';
    END IF;
    IF t.state <> 'proposed' THEN
        RETURN 'illegal_state';
    END IF;
    -- The definer bypasses RLS: the acceptor claim MUST be the caller.
    IF app_user() IS NULL OR app_user() IS DISTINCT FROM t.recipient THEN
        RETURN 'wrong_actor';
    END IF;
    IF now() >= t.expires_at THEN
        RETURN 'expired';
    END IF;
    IF has_active_suspension(t.sender, 'payment_instrument')
        OR has_active_suspension(t.recipient, 'payment_instrument') THEN
        RETURN 'suspended';
    END IF;
    -- Pre-prove the sender's wallet before any state moves: a refusal here
    -- leaves the transfer proposed.
    SELECT w.wallet_id, w.status INTO v_wallet, v_step
      FROM wallets w
     WHERE w.owner = t.sender AND w.kind = 'user' AND w.currency = 'NGN';
    IF v_wallet IS NULL THEN
        RETURN 'no_wallet';
    END IF;
    IF v_step <> 'active' THEN
        RETURN 'wallet_not_active';
    END IF;
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_balance
      FROM wallet_entries e WHERE e.wallet_id = v_wallet;
    SELECT COALESCE(sum(h.amount_minor), 0) INTO v_held
      FROM wallet_holds h
     WHERE h.wallet_id = v_wallet AND h.state = 'pending';
    IF t.amount_minor + t.fee_minor > v_balance - v_held THEN
        RETURN 'insufficient_funds';
    END IF;
    -- State first (re-proves KYC and the OPEN pair), then the reservation,
    -- then settlement consumes exactly that reservation. Any failure rolls
    -- the whole transaction back — value and state can never diverge.
    v_step := record_transfer_event(p_transfer, app_user(), 'accepted');
    IF v_step <> 'recorded' THEN
        RETURN v_step;  -- 'not_kyc_verified' | 'pair_not_open'
    END IF;
    SELECT h.outcome, h.hold_id INTO v_hold
      FROM place_wallet_hold(v_wallet, t.amount_minor + t.fee_minor, p_transfer) h;
    IF v_hold.outcome <> 'placed' THEN
        RETURN v_hold.outcome;  -- defensive; the pre-proof above ran first
    END IF;
    v_step := settle_transfer_funds(p_transfer);
    RETURN v_step;  -- 'settled' on success
END $$;

-- ------------------------------------------------- AMD-PAY-19 -------------
-- Reconciliation: re-derive every balance from the append-only ledger and
-- compare it with the latest balance_after; prove the platform fee account
-- equals the sum of fee charges; surface stuck reservations. A healthy
-- ledger returns zero mismatches. Moderator-only.
CREATE OR REPLACE FUNCTION wallet_reconciliation()
RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_moderator() THEN
        RETURN jsonb_build_object('error', 'forbidden');
    END IF;
    RETURN jsonb_build_object(
        'walletsChecked', (SELECT count(*) FROM wallets),
        'balanceMismatches', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'walletId', x.wallet_id, 'derived', x.derived, 'lastBalanceAfter', x.last_after))
            FROM (
                SELECT w.wallet_id,
                       COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                                        THEN e.amount_minor ELSE -e.amount_minor END), 0) AS derived,
                       (SELECT e2.balance_after FROM wallet_entries e2
                         WHERE e2.wallet_id = w.wallet_id
                         ORDER BY e2.entry_id DESC LIMIT 1) AS last_after
                  FROM wallets w
                  LEFT JOIN wallet_entries e ON e.wallet_id = w.wallet_id
                 GROUP BY w.wallet_id
            ) x
            WHERE x.derived <> COALESCE(x.last_after, 0)), '[]'::jsonb),
        'platformFeeDelta', (
            SELECT COALESCE(sum(CASE WHEN e.kind = 'fee_revenue' THEN e.amount_minor
                                     WHEN e.kind = 'fee_charge' THEN -e.amount_minor
                                     ELSE 0 END), 0)
              FROM wallet_entries e),
        'stuckHolds', (SELECT count(*) FROM wallet_holds h
                        WHERE h.state = 'pending'
                          AND h.created_at < now() - interval '24 hours'),
        'openWithdrawals', (SELECT count(*) FROM withdrawal_requests r
                             WHERE r.state IN ('requested', 'processing'))
    );
END $$;

GRANT EXECUTE ON FUNCTION fund_wallet(uuid, bigint, text) TO presence_app;
GRANT EXECUTE ON FUNCTION request_withdrawal(uuid, bigint, text) TO presence_app;
GRANT EXECUTE ON FUNCTION cancel_withdrawal(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION decide_withdrawal(uuid, text) TO presence_app;
GRANT EXECUTE ON FUNCTION complete_withdrawal(uuid, text) TO presence_app;
GRANT EXECUTE ON FUNCTION fail_withdrawal(uuid, text) TO presence_app;
GRANT EXECUTE ON FUNCTION accept_transfer_and_settle(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION wallet_reconciliation() TO presence_app;

-- ------------------------------------------------- AMD-PAY-20 -------------
-- Withdrawal history joins the export. One wholesale CREATE OR REPLACE,
-- forward-only: every key the 0027 body carried is preserved verbatim and
-- the wallets block gains 'withdrawals' inline — per request the amount,
-- state, destination reference and timestamps. Withdrawal rows survive
-- account deletion tied to the tombstone, exactly like the ledger itself.

CREATE OR REPLACE FUNCTION dsar_export(uid uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT jsonb_build_object(
        'user', (SELECT jsonb_build_object(
                        'userId', u.user_id, 'createdAt', u.created_at,
                        'birthYear', u.birth_year, 'ageDeclaredAt', u.age_declared_at,
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
                       '[]'::jsonb)
    )
$$;

REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app;

COMMIT;
