-- Presence — wallet contract layer (SRS Addendum 001: AMD-PAY-10..14)
--
-- Requirement anchors:
--   AMD-PAY-10  one wallet per user per currency; NGN at launch; a single
--               platform fee wallet; creation self-serve for KYC-verified
--               users; an unfunded wallet is inert by construction
--   AMD-PAY-11  wallet_entries is append-only for every application path;
--               balances are derived, the running balance_after is written
--               under the wallet row lock, and no balance can go negative
--   AMD-PAY-12  two-phase holds reserve availability: pending → posted |
--               voided, reservation terms immutable, rail-only
--   AMD-PAY-13  settlement is one atomic definer: sender debited
--               amount + fee, recipient credited amount, the platform fee
--               wallet credited fee, and the transfer moved to 'settled'
--               in the same transaction — every value-moving definer is
--               gated by the transaction-local app.transfer_settlement
--               setting that no P0 component sets (AMD-PAY-08 extended)
--   AMD-PAY-14  the FR-62 export carries the wallet ledger; wallet rows
--               survive account deletion tied to the anonymous tombstone —
--               the append-only discipline has no erasure exception
--
-- Forward-only migration; run after 0026_dsar_transfers.sql.

BEGIN;

-- ------------------------------------------------- AMD-PAY-10 -------------
CREATE TABLE wallets (
    wallet_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner      uuid REFERENCES users (user_id),   -- NULL = platform
    kind       text NOT NULL DEFAULT 'user'
        CHECK (kind IN ('user', 'platform')),
    currency   text NOT NULL CHECK (currency = 'NGN'),
    status     text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'frozen', 'closed')),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- One wallet per owner per currency; one platform wallet per currency.
CREATE UNIQUE INDEX wallets_owner_currency
    ON wallets (owner, currency) WHERE kind = 'user';
CREATE UNIQUE INDEX wallets_platform_currency
    ON wallets (currency) WHERE kind = 'platform';

-- AMD-PAY-13: the platform fee wallet. The id is fixed so the rail, the
-- tests and the ops runbooks pin the same account; owner NULL keeps it
-- invisible to every application-scoped read (RLS below).
INSERT INTO wallets (wallet_id, owner, kind, currency)
VALUES ('00000000-0000-0000-0000-00000000fee1', NULL, 'platform', 'NGN');

-- ------------------------------------------------- AMD-PAY-11 -------------
-- The ledger. Six kinds, signed by kind: fund, transfer_in and
-- fee_revenue credit; withdrawal, transfer_out and fee_charge debit.
-- balance_after is the running balance under the wallet row lock — the
-- invariant is a CHECK, not a convention: no entry may leave a wallet
-- negative. There is no free-text column anywhere.
CREATE TABLE wallet_entries (
    entry_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wallet_id    uuid NOT NULL REFERENCES wallets (wallet_id),
    kind         text NOT NULL
        CHECK (kind IN ('fund', 'withdrawal', 'transfer_out',
                        'transfer_in', 'fee_charge', 'fee_revenue')),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    balance_after bigint NOT NULL CHECK (balance_after >= 0),
    transfer_id  uuid REFERENCES transfers (transfer_id),
    at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_entries_wallet ON wallet_entries (wallet_id, entry_id);
CREATE INDEX wallet_entries_transfer ON wallet_entries (transfer_id)
    WHERE transfer_id IS NOT NULL;

-- AMD-PAY-12: two-phase holds. A pending hold reduces the spendable
-- balance without moving value; posting consumes the reservation,
-- voiding releases it. Terms (wallet, amount, transfer) are immutable.
CREATE TABLE wallet_holds (
    hold_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id    uuid NOT NULL REFERENCES wallets (wallet_id),
    transfer_id  uuid REFERENCES transfers (transfer_id),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    state        text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'posted', 'voided')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz
);

CREATE INDEX wallet_holds_pending ON wallet_holds (wallet_id)
    WHERE state = 'pending';

-- Owner-scoped reads; writes flow exclusively through the definers below.
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_holds ENABLE ROW LEVEL SECURITY;

CREATE POLICY wallets_owner_select ON wallets FOR SELECT
    USING (owner = app_user());

CREATE POLICY wallet_entries_owner_select ON wallet_entries FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM wallets w
         WHERE w.wallet_id = wallet_entries.wallet_id
           AND w.owner = app_user()));

CREATE POLICY wallet_holds_owner_select ON wallet_holds FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM wallets w
         WHERE w.wallet_id = wallet_holds.wallet_id
           AND w.owner = app_user()));

GRANT SELECT ON wallets TO presence_app;
GRANT SELECT ON wallet_entries TO presence_app;
GRANT SELECT ON wallet_holds TO presence_app;
-- No INSERT/UPDATE/DELETE grants: the definers are the only writers
-- (SECURITY DEFINER), mirroring the AMD-PAY-07 discipline.

-- Derived balances (AMD-PAY-11): balance from the ledger, held from
-- pending holds, available = balance − held. security_invoker keeps the
-- reader's RLS in force through the view.
CREATE VIEW wallet_balances WITH (security_invoker = true) AS
SELECT w.wallet_id,
       w.currency,
       w.status,
       COALESCE(s.balance, 0) AS balance_minor,
       COALESCE(h.held, 0) AS held_minor,
       COALESCE(s.balance, 0) - COALESCE(h.held, 0) AS available_minor
  FROM wallets w
  LEFT JOIN (
        SELECT wallet_id,
               sum(CASE WHEN kind IN ('fund', 'transfer_in', 'fee_revenue')
                        THEN amount_minor ELSE -amount_minor END) AS balance
          FROM wallet_entries
         GROUP BY wallet_id
       ) s ON s.wallet_id = w.wallet_id
  LEFT JOIN (
        SELECT wallet_id, sum(amount_minor) AS held
          FROM wallet_holds
         WHERE state = 'pending'
         GROUP BY wallet_id
       ) h ON h.wallet_id = w.wallet_id;

GRANT SELECT ON wallet_balances TO presence_app;

-- ------------------------------------------------- AMD-PAY-11/12 ----------
CREATE OR REPLACE FUNCTION wallet_entries_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'wallet_entries is append-only (AMD-PAY-11)';
END $$;

CREATE TRIGGER wallet_entries_append_only
    BEFORE UPDATE OR DELETE ON wallet_entries
    FOR EACH ROW EXECUTE FUNCTION wallet_entries_append_only();

-- Holds mutate only along the legal path: pending → posted | voided, and
-- the reservation terms never change. DELETE is banned outright.
CREATE OR REPLACE FUNCTION wallet_holds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'wallet_holds is append-only (AMD-PAY-12)';
    END IF;
    IF NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
        OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
        OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id THEN
        RAISE EXCEPTION 'wallet hold terms are immutable (AMD-PAY-12)';
    END IF;
    IF OLD.state <> 'pending' OR NEW.state NOT IN ('posted', 'voided') THEN
        RAISE EXCEPTION 'illegal hold transition (AMD-PAY-12)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER wallet_holds_guard
    BEFORE UPDATE OR DELETE ON wallet_holds
    FOR EACH ROW EXECUTE FUNCTION wallet_holds_guard();

-- ------------------------------------------------- AMD-PAY-10 -------------
-- Self-serve wallet creation. The definer bypasses RLS, so the owner
-- claim MUST be the caller's own; wallets open for KYC-verified users
-- only (AMD-PAY-01 discipline). Idempotent: a second call answers
-- 'exists' with the wallet id.
-- Outcomes: 'created' | 'exists' | 'forbidden' | 'not_kyc_verified'.
CREATE OR REPLACE FUNCTION create_wallet(p_owner uuid)
RETURNS TABLE(outcome text, wallet_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id uuid;
BEGIN
    IF p_owner IS NULL OR p_owner IS DISTINCT FROM app_user() THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM kyc_verified_accounts WHERE user_id = p_owner) THEN
        RETURN QUERY SELECT 'not_kyc_verified', NULL::uuid;
        RETURN;
    END IF;
    SELECT w.wallet_id INTO v_id FROM wallets w
     WHERE w.owner = p_owner AND w.kind = 'user' AND w.currency = 'NGN';
    IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT 'exists', v_id;
        RETURN;
    END IF;
    INSERT INTO wallets (owner, kind, currency)
    VALUES (p_owner, 'user', 'NGN')
    RETURNING wallets.wallet_id INTO v_id;
    RETURN QUERY SELECT 'created', v_id;
END $$;

-- ------------------------------------------------- AMD-PAY-13 -------------
-- The rail gate, extended from AMD-PAY-08: every value-moving wallet
-- definer refuses unless the transaction-local app.transfer_settlement
-- setting is 'on'. No P0 component sets it — the branch exists for the
-- future Mojaloop/TigerBeetle settlement component and is unreachable
-- until the TECH-23 organisational gate lifts.

-- Single-wallet movement: rail fund-in ('fund') and fund-out
-- ('withdrawal'). Transfer settlement moves value only through
-- settle_transfer_funds below. A withdrawal may not spend reserved funds.
-- Outcomes: 'moved' | 'forbidden' | 'invalid_kind' | 'invalid_amount'
-- | 'unknown_wallet' | 'wallet_not_active' | 'insufficient_funds'.
CREATE OR REPLACE FUNCTION wallet_move(
    p_wallet uuid, p_kind text, p_amount_minor bigint,
    p_transfer uuid DEFAULT NULL)
RETURNS TABLE(outcome text, balance_minor bigint)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_status  text;
    v_balance bigint;
    v_held    bigint;
    v_new     bigint;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::bigint;
        RETURN;
    END IF;
    IF p_kind NOT IN ('fund', 'withdrawal') THEN
        RETURN QUERY SELECT 'invalid_kind', NULL::bigint;
        RETURN;
    END IF;
    IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
        RETURN QUERY SELECT 'invalid_amount', NULL::bigint;
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
    SELECT COALESCE(sum(h.amount_minor), 0) INTO v_held
      FROM wallet_holds h
     WHERE h.wallet_id = p_wallet AND h.state = 'pending';
    IF p_kind = 'withdrawal' AND p_amount_minor > v_balance - v_held THEN
        RETURN QUERY SELECT 'insufficient_funds', NULL::bigint;
        RETURN;
    END IF;
    v_new := CASE WHEN p_kind = 'fund'
                  THEN v_balance + p_amount_minor
                  ELSE v_balance - p_amount_minor END;
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after, transfer_id)
    VALUES (p_wallet, p_kind, p_amount_minor, v_new, p_transfer);
    RETURN QUERY SELECT 'moved', v_new;
END $$;

-- AMD-PAY-12: reserve availability ahead of settlement. The hold names
-- its transfer, so settlement consumes exactly one reservation.
-- Outcomes: 'placed' | 'forbidden' | 'invalid_amount' | 'unknown_wallet'
-- | 'wallet_not_active' | 'insufficient_funds'.
CREATE OR REPLACE FUNCTION place_wallet_hold(
    p_wallet uuid, p_amount_minor bigint, p_transfer uuid)
RETURNS TABLE(outcome text, hold_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_status  text;
    v_balance bigint;
    v_held    bigint;
    v_id      uuid;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
        RETURN QUERY SELECT 'invalid_amount', NULL::uuid;
        RETURN;
    END IF;
    SELECT w.status INTO v_status FROM wallets w
     WHERE w.wallet_id = p_wallet FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_wallet', NULL::uuid;
        RETURN;
    END IF;
    IF v_status <> 'active' THEN
        RETURN QUERY SELECT 'wallet_not_active', NULL::uuid;
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
    VALUES (p_wallet, p_transfer, p_amount_minor)
    RETURNING wallet_holds.hold_id INTO v_id;
    RETURN QUERY SELECT 'placed', v_id;
END $$;

-- AMD-PAY-12: release a reservation without moving value.
-- Outcomes: 'voided' | 'forbidden' | 'unknown_hold'.
CREATE OR REPLACE FUNCTION void_wallet_hold(p_hold uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    UPDATE wallet_holds h
       SET state = 'voided', resolved_at = now()
     WHERE h.hold_id = p_hold AND h.state = 'pending';
    IF NOT FOUND THEN
        RETURN 'unknown_hold';
    END IF;
    RETURN 'voided';
END $$;

-- AMD-PAY-13: atomic settlement. One call moves the value AND the
-- transfer state, in one transaction, under the one rail flag:
--   sender   −amount (transfer_out) −fee (fee_charge)
--   recipient +amount (transfer_in)
--   platform  +fee (fee_revenue)
-- A pending hold naming this transfer must cover amount + fee exactly and
-- is posted; without a hold the sender's available balance must cover it.
-- Idempotent: any existing ledger row for the transfer answers
-- 'already_settled'. Suspensions are re-proved at this third moment —
-- a state can move between acceptance and settlement.
-- Outcomes: 'settled' | 'forbidden' | 'unknown_transfer'
-- | 'already_settled' | 'illegal_state' | 'suspended' | 'no_wallet'
-- | 'wallet_not_active' | 'hold_mismatch' | 'insufficient_funds'.
CREATE OR REPLACE FUNCTION settle_transfer_funds(p_transfer uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t record;
    v_sender_wallet    uuid;
    v_recipient_wallet uuid;
    v_platform_wallet  uuid;
    v_lock             uuid;
    v_balance          bigint;
    v_held             bigint;
    v_hold             uuid;
    v_need             bigint;
    v_bal              bigint;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT tr.state, tr.sender, tr.recipient, tr.amount_minor, tr.fee_minor
      INTO t FROM transfers tr WHERE tr.transfer_id = p_transfer FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_transfer';
    END IF;
    IF t.state = 'settled' THEN
        RETURN 'already_settled';
    END IF;
    IF t.state <> 'accepted' THEN
        RETURN 'illegal_state';
    END IF;
    IF EXISTS (SELECT 1 FROM wallet_entries e WHERE e.transfer_id = p_transfer) THEN
        RETURN 'already_settled';
    END IF;
    IF has_active_suspension(t.sender, 'payment_instrument')
        OR has_active_suspension(t.recipient, 'payment_instrument') THEN
        RETURN 'suspended';
    END IF;
    SELECT w.wallet_id INTO v_sender_wallet FROM wallets w
     WHERE w.owner = t.sender AND w.kind = 'user' AND w.currency = 'NGN';
    SELECT w.wallet_id INTO v_recipient_wallet FROM wallets w
     WHERE w.owner = t.recipient AND w.kind = 'user' AND w.currency = 'NGN';
    SELECT w.wallet_id INTO v_platform_wallet FROM wallets w
     WHERE w.kind = 'platform' AND w.currency = 'NGN';
    IF v_sender_wallet IS NULL OR v_recipient_wallet IS NULL
        OR v_platform_wallet IS NULL THEN
        RETURN 'no_wallet';
    END IF;
    -- Deadlock discipline: lock the three wallets in wallet_id order.
    FOR v_lock IN
        SELECT w.wallet_id FROM wallets w
         WHERE w.wallet_id IN (v_sender_wallet, v_recipient_wallet, v_platform_wallet)
         ORDER BY w.wallet_id FOR UPDATE
    LOOP
        NULL;
    END LOOP;
    IF EXISTS (SELECT 1 FROM wallets w
                WHERE w.wallet_id IN (v_sender_wallet, v_recipient_wallet,
                                      v_platform_wallet)
                  AND w.status <> 'active') THEN
        RETURN 'wallet_not_active';
    END IF;
    v_need := t.amount_minor + t.fee_minor;
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_balance
      FROM wallet_entries e WHERE e.wallet_id = v_sender_wallet;
    SELECT COALESCE(sum(h.amount_minor), 0) INTO v_held
      FROM wallet_holds h
     WHERE h.wallet_id = v_sender_wallet AND h.state = 'pending';
    SELECT h.hold_id INTO v_hold FROM wallet_holds h
     WHERE h.wallet_id = v_sender_wallet AND h.transfer_id = p_transfer
       AND h.state = 'pending'
     ORDER BY h.created_at LIMIT 1;
    IF v_hold IS NOT NULL THEN
        -- The reservation names the transfer: it must cover it exactly.
        PERFORM 1 FROM wallet_holds h
         WHERE h.hold_id = v_hold AND h.amount_minor = v_need;
        IF NOT FOUND THEN
            RETURN 'hold_mismatch';
        END IF;
        UPDATE wallet_holds h
           SET state = 'posted', resolved_at = now()
         WHERE h.hold_id = v_hold;
    ELSIF v_balance - v_held < v_need THEN
        RETURN 'insufficient_funds';
    END IF;
    -- Sender: amount then fee, the running balance written under the lock.
    v_bal := v_balance - t.amount_minor;
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after, transfer_id)
    VALUES (v_sender_wallet, 'transfer_out', t.amount_minor, v_bal, p_transfer);
    v_bal := v_bal - t.fee_minor;
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after, transfer_id)
    VALUES (v_sender_wallet, 'fee_charge', t.fee_minor, v_bal, p_transfer);
    -- Recipient: the amount.
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_bal
      FROM wallet_entries e WHERE e.wallet_id = v_recipient_wallet;
    v_bal := v_bal + t.amount_minor;
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after, transfer_id)
    VALUES (v_recipient_wallet, 'transfer_in', t.amount_minor, v_bal, p_transfer);
    -- Platform: the fee — the AMD-PAY-05 revenue line lands here.
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_bal
      FROM wallet_entries e WHERE e.wallet_id = v_platform_wallet;
    v_bal := v_bal + t.fee_minor;
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after, transfer_id)
    VALUES (v_platform_wallet, 'fee_revenue', t.fee_minor, v_bal, p_transfer);
    -- The state move rides the same transaction and the same rail flag —
    -- value and state can never diverge.
    PERFORM record_transfer_event(
        p_transfer, NULL, 'settled', jsonb_build_object('rail', 'wallet'));
    RETURN 'settled';
END $$;

-- Wallet suspension (AMD-KYC-05 composability): moderation freezes and
-- unfreezes user wallets; the platform wallet is untouchable; 'closed'
-- stays unreachable until a further amendment defines account closure.
-- Every change lands in the admin audit log.
-- Outcomes: 'updated' | 'forbidden' | 'unknown_wallet' | 'illegal_status'.
CREATE OR REPLACE FUNCTION set_wallet_status(p_wallet uuid, p_status text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v record;
BEGIN
    IF NOT app_moderator() THEN
        RETURN 'forbidden';
    END IF;
    IF p_status NOT IN ('active', 'frozen') THEN
        RETURN 'illegal_status';
    END IF;
    SELECT w.wallet_id, w.kind, w.status INTO v
      FROM wallets w WHERE w.wallet_id = p_wallet FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_wallet';
    END IF;
    IF v.kind <> 'user' THEN
        RETURN 'forbidden';
    END IF;
    UPDATE wallets SET status = p_status WHERE wallet_id = p_wallet;
    PERFORM admin_audit_log(
        app_user(),
        'wallet.status',
        p_status,
        'wallet', p_wallet::text,
        jsonb_build_object('status', v.status),
        jsonb_build_object('status', p_status)
    );
    RETURN 'updated';
END $$;

GRANT EXECUTE ON FUNCTION create_wallet(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION wallet_move(uuid, text, bigint, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION place_wallet_hold(uuid, bigint, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION void_wallet_hold(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION settle_transfer_funds(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION set_wallet_status(uuid, text) TO presence_app;

-- ------------------------------------------------- AMD-PAY-14 -------------
-- The wallet ledger joins the export. One wholesale CREATE OR REPLACE,
-- forward-only: every key the 0026 body carried is preserved verbatim and
-- 'wallets' is added — per wallet the currency, status and timestamps
-- with the entry ledger and hold history inline. Wallet rows survive
-- account deletion (FR-03) tied to the anonymous tombstone, exactly like
-- transfers: they are the record of value, they contain no free text, and
-- they identify nobody once the account is tombstoned.

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
                            WHERE h.wallet_id = w.wallet_id), '[]'::jsonb))
                       ORDER BY w.created_at)
                       FROM wallets w WHERE w.owner = uid),
                       '[]'::jsonb)
    )
$$;

REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app;

COMMIT;
