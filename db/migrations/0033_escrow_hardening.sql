-- presence — migration 0033: escrow hardening (batch 58, SRS Addendum 001
-- AMD-ESC-01..03).
--
-- AMD-ESC-01  four-eyes high-value resolution: a disputed escrow whose
--             remaining (still-pending) value exceeds 1,000,000 minor
--             (NGN 10,000.00 — the top band of the 5,000,000 minor escrow
--             cap) cannot be resolved by a single moderator. The first
--             moderator's resolve_escrow call moves no value: it opens a
--             pending escrow_resolve_approvals row (escrow, decision,
--             remaining value and proposer frozen) and answers
--             'approval_required'. A DIFFERENT moderator approves via
--             approve_escrow_resolution, which marks the approval and
--             executes exactly that decision in the same transaction —
--             the executor can only say yes or no to the frozen terms.
--             Self-approval is refused; reject closes the request without
--             moving value. Marketplace dispute resolution rides the same
--             gate because resolve_purchase delegates to resolve_escrow.
-- AMD-ESC-02  dispute liveness: dispute_escrow now stamps
--             escrow_agreements.disputed_at, wallet_reconciliation reports
--             the dispute queue (count, oldest age in seconds, pending
--             four-eyes approvals) and the stuck-escrow count (active
--             escrows older than 30 days — funds held indefinitely stay
--             visible). No automatic resolution and no timed movement of
--             value: visibility only, movement stays human and audited.
-- AMD-ESC-03  the full-chain rehearsal (scripts/rehearse_full_chain.py)
--             applies every migration in order against a scratch database
--             and exercises the escrow lifecycle end to end, so definer
--             resolution and cross-migration composition are proven, not
--             assumed.
--
-- Existing outcomes are preserved verbatim; resolve_escrow gains one new
-- outcome ('approval_required') and resolve_purchase passes it through.

BEGIN;

-- ------------------------------------------------------------ AMD-ESC-01 --

CREATE TABLE escrow_resolve_approvals (
    approval_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    escrow_id       uuid NOT NULL REFERENCES escrow_agreements (escrow_id),
    decision        text NOT NULL CHECK (decision IN ('refund', 'release')),
    remaining_minor bigint NOT NULL CHECK (remaining_minor > 1000000),
    proposed_by     uuid NOT NULL,
    state           text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'approved', 'rejected')),
    decided_by      uuid,
    decided_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
-- One open request per disputed escrow at a time.
CREATE UNIQUE INDEX escrow_resolve_approvals_pending
    ON escrow_resolve_approvals (escrow_id) WHERE state = 'pending';
CREATE INDEX escrow_resolve_approvals_queue
    ON escrow_resolve_approvals (state, created_at);

ALTER TABLE escrow_resolve_approvals ENABLE ROW LEVEL SECURITY;
-- No policies and no grants: the definers are the only readers and writers.

CREATE OR REPLACE FUNCTION escrow_resolve_approvals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'escrow_resolve_approvals is append-only (AMD-ESC-01)';
    END IF;
    IF NEW.escrow_id IS DISTINCT FROM OLD.escrow_id
        OR NEW.decision IS DISTINCT FROM OLD.decision
        OR NEW.remaining_minor IS DISTINCT FROM OLD.remaining_minor
        OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by THEN
        RAISE EXCEPTION 'escrow resolution terms are immutable (AMD-ESC-01)';
    END IF;
    IF NOT (OLD.state = 'pending' AND NEW.state IN ('approved', 'rejected')) THEN
        RAISE EXCEPTION 'illegal escrow resolution transition (AMD-ESC-01)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER escrow_resolve_approvals_guard
    BEFORE UPDATE OR DELETE ON escrow_resolve_approvals
    FOR EACH ROW EXECUTE FUNCTION escrow_resolve_approvals_guard();

-- AMD-ESC-02: dispute timestamp. The 0030 guard pins payer, payee, total,
-- hold and created_at; disputed_at joins resolved_at as lifecycle data the
-- definers may set. NULL until disputed; reset is meaningless because the
-- disputed state never exits except to a terminal resolution.
ALTER TABLE escrow_agreements ADD COLUMN disputed_at timestamptz;

-- Redefined from 0030 with one addition: stamp disputed_at. Outcomes
-- unchanged: 'disputed' | 'forbidden' | 'unknown_escrow'.
CREATE OR REPLACE FUNCTION dispute_escrow(p_escrow uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    UPDATE escrow_agreements a
       SET state = 'disputed', disputed_at = now()
     WHERE a.escrow_id = p_escrow AND a.state = 'active'
       AND v_user IN (a.payer, a.payee);
    IF NOT FOUND THEN
        RETURN 'unknown_escrow';
    END IF;
    RETURN 'disputed';
END $$;

-- Redefined from 0030 with one addition: the AMD-ESC-01 four-eyes gate.
-- A disputed escrow holding more than 1,000,000 minor in pending
-- milestones requires an approval row proposed by a different moderator
-- before value moves; otherwise the call records the request and answers
-- 'approval_required'. Every other branch is the 0030 body verbatim.
-- Outcomes: 'resolved' | 'approval_required' | 'forbidden'
-- | 'unknown_escrow' | 'invalid_decision'.
CREATE OR REPLACE FUNCTION resolve_escrow(p_escrow uuid, p_decision text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user   uuid := app_user();
    v_escrow escrow_agreements%ROWTYPE;
    v_ms     escrow_milestones%ROWTYPE;
    v_order  marketplace_orders%ROWTYPE;
    v_payer_wallet uuid;
    v_payee_wallet uuid;
    v_balance bigint;
    v_remaining bigint;
BEGIN
    IF v_user IS NULL OR NOT app_moderator()
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF p_decision NOT IN ('refund', 'release') THEN
        RETURN 'invalid_decision';
    END IF;
    SELECT * INTO v_escrow FROM escrow_agreements a
     WHERE a.escrow_id = p_escrow AND a.state = 'disputed' FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_escrow';
    END IF;
    -- AMD-ESC-01: four-eyes above the pinned threshold. The approval row
    -- must match the decision being executed and must come from a
    -- different moderator than the one executing.
    SELECT COALESCE(sum(m.amount_minor), 0) INTO v_remaining
      FROM escrow_milestones m
     WHERE m.escrow_id = p_escrow AND m.state = 'pending';
    IF v_remaining > 1000000
       AND NOT EXISTS (SELECT 1 FROM escrow_resolve_approvals ap
                        WHERE ap.escrow_id = p_escrow
                          AND ap.decision = p_decision
                          AND ap.state = 'approved'
                          AND ap.proposed_by <> v_user) THEN
        INSERT INTO escrow_resolve_approvals (escrow_id, decision, remaining_minor, proposed_by)
        VALUES (p_escrow, p_decision, v_remaining, v_user)
        ON CONFLICT (escrow_id) WHERE state = 'pending' DO NOTHING;
        PERFORM admin_audit_log(
            v_user,
            'escrow.resolve',
            'approval_proposed',
            'escrow', p_escrow::text,
            NULL,
            jsonb_build_object('decision', p_decision, 'remaining_minor', v_remaining)
        );
        RETURN 'approval_required';
    END IF;
    IF p_decision = 'refund' THEN
        PERFORM void_wallet_hold(v_escrow.hold_id);
        UPDATE escrow_milestones
           SET state = 'refunded', resolved_at = now()
         WHERE escrow_id = p_escrow AND state = 'pending';
        UPDATE escrow_agreements
           SET state = 'refunded', resolved_at = now(), resolved_by = v_user
         WHERE escrow_id = p_escrow;
    ELSE
        SELECT w.wallet_id INTO v_payer_wallet FROM wallets w
         WHERE w.owner = v_escrow.payer AND w.status = 'active';
        SELECT w.wallet_id INTO v_payee_wallet FROM wallets w
         WHERE w.owner = v_escrow.payee AND w.status = 'active';
        IF v_payer_wallet IS NULL OR v_payee_wallet IS NULL THEN
            RETURN 'forbidden';
        END IF;
        FOR v_ms IN SELECT * FROM escrow_milestones m
                     WHERE m.escrow_id = p_escrow AND m.state = 'pending'
                     ORDER BY m.seq FOR UPDATE LOOP
            SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                                     THEN e.amount_minor ELSE -e.amount_minor END), 0)
              INTO v_balance FROM wallet_entries e WHERE e.wallet_id = v_payer_wallet;
            INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)
            VALUES (v_payer_wallet, 'transfer_out', v_ms.amount_minor,
                    v_balance - v_ms.amount_minor);
            SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                                     THEN e.amount_minor ELSE -e.amount_minor END), 0)
              INTO v_balance FROM wallet_entries e WHERE e.wallet_id = v_payee_wallet;
            INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)
            VALUES (v_payee_wallet, 'transfer_in', v_ms.amount_minor,
                    v_balance + v_ms.amount_minor);
            UPDATE escrow_milestones
               SET state = 'released', resolved_at = now()
             WHERE escrow_id = v_ms.escrow_id AND seq = v_ms.seq;
        END LOOP;
        PERFORM void_wallet_hold(v_escrow.hold_id);
        UPDATE escrow_agreements
           SET state = 'completed', resolved_at = now(), resolved_by = v_user
         WHERE escrow_id = p_escrow;
    END IF;
    -- AMD-ESC-01: marketplace composition. An escrow backing a marketplace
    -- order resolves the order with it on EVERY path that reaches
    -- resolution — the direct moderator path and the four-eyes approval
    -- path both land here. Mirrors 0032's bookkeeping exactly: a refund
    -- relists the listing, a release completes the sale.
    UPDATE marketplace_orders o
       SET state = CASE WHEN p_decision = 'refund' THEN 'refunded'
                        ELSE 'completed' END,
           resolved_at = now()
     WHERE o.escrow_id = p_escrow AND o.state = 'disputed'
    RETURNING * INTO v_order;
    IF FOUND THEN
        IF p_decision = 'refund' THEN
            UPDATE marketplace_listings
               SET state = 'listed', listed_at = now()
             WHERE listing_id = v_order.listing_id;
            INSERT INTO marketplace_events (listing_id, order_id, actor, from_state, to_state)
            VALUES (v_order.listing_id, v_order.order_id, v_user, 'disputed', 'refunded'),
                   (v_order.listing_id, v_order.order_id, NULL, 'held', 'listed');
        ELSE
            UPDATE marketplace_listings
               SET state = 'sold', closed_at = now()
             WHERE listing_id = v_order.listing_id;
            INSERT INTO marketplace_events (listing_id, order_id, actor, from_state, to_state)
            VALUES (v_order.listing_id, v_order.order_id, v_user, 'disputed', 'completed'),
                   (v_order.listing_id, v_order.order_id, NULL, 'held', 'sold');
        END IF;
    END IF;
    PERFORM admin_audit_log(
        v_user,
        'escrow.resolve',
        p_decision,
        'escrow', p_escrow::text,
        NULL,
        jsonb_build_object('payer', v_escrow.payer, 'payee', v_escrow.payee,
                           'total_minor', v_escrow.total_minor)
    );
    RETURN 'resolved';
END $$;

-- Approve a pending four-eyes request: a moderator OTHER than the proposer
-- marks the approval and executes exactly the frozen decision in the same
-- transaction. Outcomes: 'resolved' | 'forbidden' | 'unknown_approval'
-- | 'illegal_state' | 'self_approval' | 'escrow_not_disputed'.
CREATE OR REPLACE FUNCTION approve_escrow_resolution(p_approval uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    a      escrow_resolve_approvals%ROWTYPE;
    v_out  text;
BEGIN
    IF v_user IS NULL OR NOT app_moderator()
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO a FROM escrow_resolve_approvals ap
     WHERE ap.approval_id = p_approval FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_approval';
    END IF;
    IF a.state <> 'pending' THEN
        RETURN 'illegal_state';
    END IF;
    IF a.proposed_by = v_user THEN
        RETURN 'self_approval';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM escrow_agreements e
                    WHERE e.escrow_id = a.escrow_id AND e.state = 'disputed') THEN
        RETURN 'escrow_not_disputed';
    END IF;
    UPDATE escrow_resolve_approvals
       SET state = 'approved', decided_by = v_user, decided_at = now()
     WHERE approval_id = p_approval;
    PERFORM admin_audit_log(
        v_user,
        'escrow.resolve',
        'approval_granted',
        'escrow', a.escrow_id::text,
        NULL,
        jsonb_build_object('approval_id', p_approval, 'decision', a.decision)
    );
    v_out := resolve_escrow(a.escrow_id, a.decision);
    RETURN v_out;
END $$;

-- Reject a pending request: closes it without moving value. Mirrors the
-- AMD-PAY-23 credit reject — any moderator may reject; the decider is
-- recorded. Outcomes: 'rejected' | 'forbidden' | 'unknown_approval'
-- | 'illegal_state'.
CREATE OR REPLACE FUNCTION reject_escrow_resolution(p_approval uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    a escrow_resolve_approvals%ROWTYPE;
BEGIN
    IF NOT app_moderator() THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO a FROM escrow_resolve_approvals ap
     WHERE ap.approval_id = p_approval FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_approval';
    END IF;
    IF a.state <> 'pending' THEN
        RETURN 'illegal_state';
    END IF;
    UPDATE escrow_resolve_approvals
       SET state = 'rejected', decided_by = app_user(), decided_at = now()
     WHERE approval_id = p_approval;
    PERFORM admin_audit_log(
        app_user(),
        'escrow.resolve',
        'approval_rejected',
        'escrow', a.escrow_id::text,
        NULL,
        jsonb_build_object('approval_id', p_approval, 'decision', a.decision)
    );
    RETURN 'rejected';
END $$;

-- The moderator console queue: pending first, then history.
CREATE OR REPLACE FUNCTION list_escrow_resolve_approvals()
RETURNS TABLE(approval_id uuid, escrow_id uuid, decision text,
              remaining_minor bigint, proposed_by uuid, state text,
              created_at timestamptz, decided_by uuid, decided_at timestamptz)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_moderator() THEN
        RETURN;
    END IF;
    RETURN QUERY
        SELECT ap.approval_id, ap.escrow_id, ap.decision, ap.remaining_minor,
               ap.proposed_by, ap.state, ap.created_at, ap.decided_by, ap.decided_at
          FROM escrow_resolve_approvals ap
         ORDER BY (ap.state = 'pending') DESC, ap.created_at DESC;
END $$;

-- Redefined from 0032 with one change: 'approval_required' passes through
-- instead of collapsing to 'escrow_error' — a marketplace dispute above
-- the AMD-ESC-01 threshold opens the same four-eyes request. All other
-- branches are the 0032 body verbatim.
-- Outcomes: 'resolved' | 'approval_required' | 'escrow_error'
-- | 'forbidden' | 'unknown_order' | 'invalid_decision'.
-- Moderation resolves a disputed order through the escrow: 'refund' pays
-- the buyer back and relists the listing; 'release' pays the seller and
-- completes the sale. The order/listing bookkeeping lives in resolve_escrow
-- itself (AMD-ESC-01) so the direct path and the four-eyes approval path
-- propagate identically; this wrapper only gates and delegates. Audited by
-- resolve_escrow.
-- Outcomes: 'resolved' | 'approval_required' | 'forbidden'
-- | 'unknown_order' | 'invalid_decision' | 'escrow_error'.
CREATE OR REPLACE FUNCTION resolve_purchase(p_order uuid, p_decision text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user  uuid := app_user();
    v_order marketplace_orders%ROWTYPE;
    v_out   text;
BEGIN
    IF v_user IS NULL OR NOT app_moderator()
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF p_decision NOT IN ('refund', 'release') THEN
        RETURN 'invalid_decision';
    END IF;
    SELECT * INTO v_order FROM marketplace_orders o
     WHERE o.order_id = p_order AND o.state = 'disputed' FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_order';
    END IF;
    v_out := resolve_escrow(v_order.escrow_id, p_decision);
    IF v_out = 'approval_required' THEN
        RETURN 'approval_required';
    END IF;
    IF v_out <> 'resolved' THEN
        RETURN 'escrow_error';
    END IF;
    RETURN 'resolved';
END $$;

-- ------------------------------------------------------------ AMD-ESC-02 --
-- Reconciliation gains the escrow governance queues. Every 0029 key is
-- preserved verbatim; the four new keys are appended.
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
                                    WHERE c.state = 'pending'),
        'openEscrowDisputes', (SELECT count(*) FROM escrow_agreements a
                                WHERE a.state = 'disputed'),
        'oldestEscrowDisputeSeconds', COALESCE((SELECT EXTRACT(EPOCH FROM now() - min(a.disputed_at))::bigint
                                  FROM escrow_agreements a
                                 WHERE a.state = 'disputed'), 0),
        'pendingEscrowResolveApprovals', (SELECT count(*) FROM escrow_resolve_approvals ap
                                           WHERE ap.state = 'pending'),
        'stuckEscrows', (SELECT count(*) FROM escrow_agreements a
                          WHERE a.state = 'active'
                            AND a.created_at < now() - interval '30 days')
    );
END $$;

-- ------------------------------------------------------------ grants ------
-- Reads are RLS-governed; every write flows through the definers above.
-- Redefined functions keep their existing grants.
GRANT EXECUTE ON FUNCTION approve_escrow_resolution(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION reject_escrow_resolution(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION list_escrow_resolve_approvals() TO presence_app;

COMMIT;
