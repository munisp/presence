-- Presence — rail hardening (SRS Addendum 001: AMD-PAY-21/23)
--
-- Requirement anchors:
--   AMD-PAY-21  rail risk signals: velocity rules run inside the funding
--               and withdrawal definers; signals are append-only, raised
--               at most once per key per wallet while open, and reviewed
--               through a moderator-only queue. Signals FLAG, they never
--               block — value keeps moving, moderation sees everything
--   AMD-PAY-23  four-eyes moderation credits: a manual credit above the
--               pinned threshold does not move value — it opens a pending
--               approval that a SECOND moderator must execute; the
--               proposer can never approve their own proposal
--
-- Forward-only migration; run after 0028_wallet_activation.sql. Every
-- redefined definer preserves the 0028 gates, caps and idempotency
-- verbatim — the additions are the signal inserts and the four-eyes
-- branch.

BEGIN;

-- ------------------------------------------------- AMD-PAY-21 -------------
-- Rail risk signals. No free text: a closed signal vocabulary, the wallet,
-- the actor where known, the amount that tripped the rule. RLS enabled
-- with no policies and no grants — the definers are the only readers and
-- writers; review flows through the moderator queue definers.
CREATE TABLE rail_risk_signals (
    signal_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_key  text NOT NULL CHECK (signal_key IN (
        'fund_velocity_1h', 'fund_daily_volume', 'withdrawal_velocity_1h')),
    wallet_id   uuid NOT NULL REFERENCES wallets (wallet_id),
    actor       uuid,
    amount_minor bigint CHECK (amount_minor > 0),
    state       text NOT NULL DEFAULT 'open'
        CHECK (state IN ('open', 'acknowledged', 'dismissed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    ack_actor   uuid,
    ack_at      timestamptz
);

CREATE INDEX rail_risk_signals_open ON rail_risk_signals (state, created_at)
    WHERE state = 'open';

ALTER TABLE rail_risk_signals ENABLE ROW LEVEL SECURITY;
-- No policies and no grants: definer-only, exactly like wallet_rail_events.

CREATE OR REPLACE FUNCTION rail_risk_signals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'rail_risk_signals is append-only (AMD-PAY-21)';
    END IF;
    IF NEW.signal_key IS DISTINCT FROM OLD.signal_key
        OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
        OR NEW.actor IS DISTINCT FROM OLD.actor
        OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
        RAISE EXCEPTION 'risk signal terms are immutable (AMD-PAY-21)';
    END IF;
    IF NOT (OLD.state = 'open' AND NEW.state IN ('acknowledged', 'dismissed')) THEN
        RAISE EXCEPTION 'illegal risk signal transition (AMD-PAY-21)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER rail_risk_signals_guard
    BEFORE UPDATE OR DELETE ON rail_risk_signals
    FOR EACH ROW EXECUTE FUNCTION rail_risk_signals_guard();

-- ------------------------------------------------- AMD-PAY-23 -------------
-- Four-eyes credit approvals. A row names the wallet, the amount and the
-- rail reference the credit WILL carry once a second moderator executes
-- it — the reference is fixed at proposal time so the approval cannot be
-- rewritten into a different credit. Append-only, terms immutable.
CREATE TABLE wallet_credit_approvals (
    approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id   uuid NOT NULL REFERENCES wallets (wallet_id),
    amount_minor bigint NOT NULL CHECK (amount_minor > 5000000),
    reference   text NOT NULL CHECK (char_length(reference) BETWEEN 8 AND 128),
    proposed_by uuid NOT NULL,
    state       text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'approved', 'rejected')),
    decided_by  uuid,
    decided_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_credit_approvals_pending ON wallet_credit_approvals (state, created_at)
    WHERE state = 'pending';

ALTER TABLE wallet_credit_approvals ENABLE ROW LEVEL SECURITY;
-- No policies and no grants: the definers are the only readers and writers.

CREATE OR REPLACE FUNCTION wallet_credit_approvals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'wallet_credit_approvals is append-only (AMD-PAY-23)';
    END IF;
    IF NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
        OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
        OR NEW.reference IS DISTINCT FROM OLD.reference
        OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by THEN
        RAISE EXCEPTION 'credit approval terms are immutable (AMD-PAY-23)';
    END IF;
    IF NOT (OLD.state = 'pending' AND NEW.state IN ('approved', 'rejected')) THEN
        RAISE EXCEPTION 'illegal credit approval transition (AMD-PAY-23)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER wallet_credit_approvals_guard
    BEFORE UPDATE OR DELETE ON wallet_credit_approvals
    FOR EACH ROW EXECUTE FUNCTION wallet_credit_approvals_guard();

-- ------------------------------------------------- AMD-PAY-16/21/23 -------
-- Fund-in, hardened. The 0028 gates, caps and idempotency are preserved
-- verbatim; three additions:
--   1. AMD-PAY-23 — a MODERATION credit above 5,000,000 minor (NGN
--      50,000.00) does not move value: it opens a pending four-eyes
--      approval and answers 'approval_required'. Provider callbacks
--      (app.funding_callback) never take this branch — the rail stays
--      live; the AMD-PAY-21 velocity signals watch them.
--   2. AMD-PAY-21 — after any credit lands, velocity rules insert at most
--      one open signal per key per wallet.
-- Outcomes: 'funded' | 'approval_required' | 'duplicate_reference'
-- | 'forbidden' | 'invalid_amount' | 'over_funding_cap'
-- | 'invalid_reference' | 'unknown_wallet' | 'wallet_not_active'.
-- The replacement widens the return row (approval_id), which CREATE OR
-- REPLACE cannot do; drop first so fresh-environment applies of the full
-- chain succeed (caught by the AMD-ESC-03 rehearsal).
DROP FUNCTION fund_wallet(uuid, bigint, text);

CREATE OR REPLACE FUNCTION fund_wallet(
    p_wallet uuid, p_amount_minor bigint, p_reference text)
RETURNS TABLE(outcome text, balance_minor bigint, approval_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_status   text;
    v_balance  bigint;
    v_approval uuid;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::bigint, NULL::uuid;
        RETURN;
    END IF;
    IF current_setting('app.funding_callback', true) IS DISTINCT FROM 'on'
        AND NOT app_moderator() THEN
        RETURN QUERY SELECT 'forbidden', NULL::bigint, NULL::uuid;
        RETURN;
    END IF;
    IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
        RETURN QUERY SELECT 'invalid_amount', NULL::bigint, NULL::uuid;
        RETURN;
    END IF;
    -- AMD-PAY-16: per-event funding cap (NGN 150,000.00), aligned with the
    -- AMD-PAY-05 daily movement cap.
    IF p_amount_minor > 15000000 THEN
        RETURN QUERY SELECT 'over_funding_cap', NULL::bigint, NULL::uuid;
        RETURN;
    END IF;
    IF p_reference IS NULL OR char_length(p_reference) NOT BETWEEN 8 AND 128 THEN
        RETURN QUERY SELECT 'invalid_reference', NULL::bigint, NULL::uuid;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM wallet_rail_events r
                WHERE r.reference = p_reference AND r.kind = 'fund') THEN
        RETURN QUERY SELECT 'duplicate_reference', NULL::bigint, NULL::uuid;
        RETURN;
    END IF;
    SELECT w.status INTO v_status FROM wallets w
     WHERE w.wallet_id = p_wallet FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_wallet', NULL::bigint, NULL::uuid;
        RETURN;
    END IF;
    IF v_status <> 'active' THEN
        RETURN QUERY SELECT 'wallet_not_active', NULL::bigint, NULL::uuid;
        RETURN;
    END IF;
    -- AMD-PAY-23: a large MANUAL credit waits for a second pair of eyes.
    -- The approval row fixes wallet, amount and reference — the executor
    -- can only say yes or no to exactly this credit.
    IF app_moderator()
        AND current_setting('app.funding_callback', true) IS DISTINCT FROM 'on'
        AND p_amount_minor > 5000000 THEN
        INSERT INTO wallet_credit_approvals (wallet_id, amount_minor, reference, proposed_by)
        VALUES (p_wallet, p_amount_minor, p_reference, app_user())
        RETURNING wallet_credit_approvals.approval_id INTO v_approval;
        PERFORM admin_audit_log(
            app_user(),
            'wallet.credit',
            'approval_proposed',
            'wallet', p_wallet::text,
            NULL,
            jsonb_build_object('amount_minor', p_amount_minor, 'approval_id', v_approval)
        );
        RETURN QUERY SELECT 'approval_required', NULL::bigint, v_approval;
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
    -- AMD-PAY-21: velocity signals — flag, never block; one open signal
    -- per key per wallet at a time.
    IF (SELECT count(*) FROM wallet_rail_events r
         WHERE r.wallet_id = p_wallet AND r.kind = 'fund'
           AND r.at > now() - interval '1 hour') > 5
       AND NOT EXISTS (SELECT 1 FROM rail_risk_signals s
                        WHERE s.wallet_id = p_wallet
                          AND s.signal_key = 'fund_velocity_1h'
                          AND s.state = 'open') THEN
        INSERT INTO rail_risk_signals (signal_key, wallet_id, actor, amount_minor)
        VALUES ('fund_velocity_1h', p_wallet, app_user(), p_amount_minor);
    END IF;
    IF (SELECT COALESCE(sum(r.amount_minor), 0) FROM wallet_rail_events r
         WHERE r.wallet_id = p_wallet AND r.kind = 'fund'
           AND r.at > now() - interval '24 hours') > 30000000
       AND NOT EXISTS (SELECT 1 FROM rail_risk_signals s
                        WHERE s.wallet_id = p_wallet
                          AND s.signal_key = 'fund_daily_volume'
                          AND s.state = 'open') THEN
        INSERT INTO rail_risk_signals (signal_key, wallet_id, actor, amount_minor)
        VALUES ('fund_daily_volume', p_wallet, app_user(), p_amount_minor);
    END IF;
    RETURN QUERY SELECT 'funded', v_balance, NULL::uuid;
END $$;

-- ------------------------------------------------- AMD-PAY-17/21 ----------
-- Withdrawal request with the velocity signal added; every 0028 gate,
-- cap and ordering is preserved verbatim. Outcomes:
-- 'requested' | 'forbidden' | 'invalid_amount' | 'over_withdrawal_cap'
-- | 'over_daily_cap' | 'invalid_destination' | 'unknown_wallet'
-- | 'wallet_not_active' | 'insufficient_funds'.
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
    -- AMD-PAY-21: more than three withdrawal requests inside an hour is a
    -- review signal, never a block.
    IF (SELECT count(*) FROM withdrawal_requests r
         WHERE r.wallet_id = p_wallet
           AND r.created_at > now() - interval '1 hour') > 3
       AND NOT EXISTS (SELECT 1 FROM rail_risk_signals s
                        WHERE s.wallet_id = p_wallet
                          AND s.signal_key = 'withdrawal_velocity_1h'
                          AND s.state = 'open') THEN
        INSERT INTO rail_risk_signals (signal_key, wallet_id, actor, amount_minor)
        VALUES ('withdrawal_velocity_1h', p_wallet, app_user(), p_amount_minor);
    END IF;
    RETURN QUERY SELECT 'requested', v_id;
END $$;

-- ------------------------------------------------- AMD-PAY-23 -------------
-- Execute a pending credit approval. Four-eyes: the executor must be a
-- moderator OTHER than the proposer. The credit lands through exactly the
-- funding path (entry + rail event, idempotent on the fixed reference).
-- Outcomes: 'funded' | 'forbidden' | 'unknown_approval' | 'illegal_state'
-- | 'self_approval' | 'wallet_not_active' | 'duplicate_reference'.
CREATE OR REPLACE FUNCTION approve_wallet_credit(p_approval uuid)
RETURNS TABLE(outcome text, balance_minor bigint)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a record;
    v_status  text;
    v_balance bigint;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::bigint;
        RETURN;
    END IF;
    IF NOT app_moderator() THEN
        RETURN QUERY SELECT 'forbidden', NULL::bigint;
        RETURN;
    END IF;
    SELECT c.approval_id, c.wallet_id, c.amount_minor, c.reference,
           c.proposed_by, c.state
      INTO a FROM wallet_credit_approvals c
     WHERE c.approval_id = p_approval FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_approval', NULL::bigint;
        RETURN;
    END IF;
    IF a.state <> 'pending' THEN
        RETURN QUERY SELECT 'illegal_state', NULL::bigint;
        RETURN;
    END IF;
    -- AMD-PAY-23: the proposer can never execute their own proposal.
    IF app_user() IS NOT DISTINCT FROM a.proposed_by THEN
        RETURN QUERY SELECT 'self_approval', NULL::bigint;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM wallet_rail_events r
                WHERE r.reference = a.reference AND r.kind = 'fund') THEN
        RETURN QUERY SELECT 'duplicate_reference', NULL::bigint;
        RETURN;
    END IF;
    SELECT w.status INTO v_status FROM wallets w
     WHERE w.wallet_id = a.wallet_id FOR UPDATE;
    IF v_status IS DISTINCT FROM 'active' THEN
        RETURN QUERY SELECT 'wallet_not_active', NULL::bigint;
        RETURN;
    END IF;
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_balance
      FROM wallet_entries e WHERE e.wallet_id = a.wallet_id;
    v_balance := v_balance + a.amount_minor;
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)
    VALUES (a.wallet_id, 'fund', a.amount_minor, v_balance);
    INSERT INTO wallet_rail_events (reference, kind, wallet_id, amount_minor, outcome)
    VALUES (a.reference, 'fund', a.wallet_id, a.amount_minor, 'funded');
    UPDATE wallet_credit_approvals
       SET state = 'approved', decided_by = app_user(), decided_at = now()
     WHERE approval_id = p_approval;
    PERFORM admin_audit_log(
        app_user(),
        'wallet.credit',
        'approval_executed',
        'wallet', a.wallet_id::text,
        jsonb_build_object('proposed_by', a.proposed_by),
        jsonb_build_object('amount_minor', a.amount_minor, 'approval_id', p_approval)
    );
    RETURN QUERY SELECT 'funded', v_balance;
END $$;

-- Reject a pending approval. Any moderator may reject — including the
-- proposer withdrawing their own proposal; only EXECUTION is four-eyes.
-- Outcomes: 'rejected' | 'forbidden' | 'unknown_approval' | 'illegal_state'.
CREATE OR REPLACE FUNCTION reject_wallet_credit(p_approval uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a record;
BEGIN
    IF NOT app_moderator() THEN
        RETURN 'forbidden';
    END IF;
    SELECT c.approval_id, c.state INTO a
      FROM wallet_credit_approvals c
     WHERE c.approval_id = p_approval FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_approval';
    END IF;
    IF a.state <> 'pending' THEN
        RETURN 'illegal_state';
    END IF;
    UPDATE wallet_credit_approvals
       SET state = 'rejected', decided_by = app_user(), decided_at = now()
     WHERE approval_id = p_approval;
    PERFORM admin_audit_log(
        app_user(),
        'wallet.credit',
        'approval_rejected',
        'credit_approval', p_approval::text,
        NULL, NULL
    );
    RETURN 'rejected';
END $$;

-- ------------------------------------------------- AMD-PAY-21 -------------
-- Moderator review queues. Both refuse closed for non-moderators by
-- returning the empty set behind the definer; the edge's requireModerator
-- preHandler is the first gate.
CREATE OR REPLACE FUNCTION list_rail_risk_signals()
RETURNS TABLE(signal_id uuid, signal_key text, wallet_id uuid, actor uuid,
              amount_minor bigint, state text, created_at timestamptz)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_moderator() THEN
        RETURN;
    END IF;
    RETURN QUERY
        SELECT s.signal_id, s.signal_key, s.wallet_id, s.actor,
               s.amount_minor, s.state, s.created_at
          FROM rail_risk_signals s
         ORDER BY s.created_at DESC;
END $$;

CREATE OR REPLACE FUNCTION ack_rail_risk_signal(p_signal uuid, p_decision text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    s record;
    v_new text;
BEGIN
    IF NOT app_moderator() THEN
        RETURN 'forbidden';
    END IF;
    IF p_decision NOT IN ('acknowledge', 'dismiss') THEN
        RETURN 'illegal_decision';
    END IF;
    SELECT g.signal_id, g.state INTO s
      FROM rail_risk_signals g
     WHERE g.signal_id = p_signal FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_signal';
    END IF;
    IF s.state <> 'open' THEN
        RETURN 'illegal_state';
    END IF;
    v_new := CASE WHEN p_decision = 'acknowledge' THEN 'acknowledged' ELSE 'dismissed' END;
    UPDATE rail_risk_signals
       SET state = v_new, ack_actor = app_user(), ack_at = now()
     WHERE signal_id = p_signal;
    PERFORM admin_audit_log(
        app_user(),
        'wallet.risk_signal',
        p_decision,
        'rail_risk_signal', p_signal::text,
        jsonb_build_object('state', s.state),
        jsonb_build_object('state', v_new)
    );
    RETURN 'decided';
END $$;

CREATE OR REPLACE FUNCTION list_credit_approvals()
RETURNS TABLE(approval_id uuid, wallet_id uuid, amount_minor bigint,
              reference text, proposed_by uuid, state text,
              created_at timestamptz, decided_by uuid, decided_at timestamptz)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_moderator() THEN
        RETURN;
    END IF;
    RETURN QUERY
        SELECT c.approval_id, c.wallet_id, c.amount_minor, c.reference,
               c.proposed_by, c.state, c.created_at, c.decided_by, c.decided_at
          FROM wallet_credit_approvals c
         ORDER BY c.created_at DESC;
END $$;

-- ------------------------------------------------- AMD-PAY-19/21/23 -------
-- Reconciliation gains the governance queues. Every 0028 key is preserved
-- verbatim; 'openRiskSignals' and 'pendingCreditApprovals' are appended.
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
                             WHERE r.state IN ('requested', 'processing')),
        'openRiskSignals', (SELECT count(*) FROM rail_risk_signals s
                             WHERE s.state = 'open'),
        'pendingCreditApprovals', (SELECT count(*) FROM wallet_credit_approvals c
                                    WHERE c.state = 'pending')
    );
END $$;

GRANT EXECUTE ON FUNCTION fund_wallet(uuid, bigint, text) TO presence_app;
GRANT EXECUTE ON FUNCTION request_withdrawal(uuid, bigint, text) TO presence_app;
GRANT EXECUTE ON FUNCTION approve_wallet_credit(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION reject_wallet_credit(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION list_rail_risk_signals() TO presence_app;
GRANT EXECUTE ON FUNCTION ack_rail_risk_signal(uuid, text) TO presence_app;
GRANT EXECUTE ON FUNCTION list_credit_approvals() TO presence_app;
GRANT EXECUTE ON FUNCTION wallet_reconciliation() TO presence_app;

COMMIT;
