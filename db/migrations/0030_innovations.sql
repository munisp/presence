-- presence — migration 0030: core-platform innovations (batch 56).
--
-- AMD-INN-01  presence bonds: a small pinned stake that backs "I will show
--             up"; released by the owner, forfeited by moderation on a
--             report. Value moves only through wallet_holds + wallet_entries.
-- AMD-INN-02  verified-met receipts: reciprocal co-attestation inside a
--             pinned 900 s window; no location is ever stored.
-- AMD-INN-03  trust escrow: milestone-based value holding between two
--             KYC-verified users, moderator-resolved on dispute.
-- AMD-INN-04  group stakes: a pinned stake on a group-table seat; refunded
--             on venue check-in, forfeited after a 24 h sweep.
-- AMD-INN-06  selective-disclosure grants: single-use, 900 s TTL claims
--             ('over_18', 'kyc_verified') — the verifier learns the claim
--             and nothing else.
-- AMD-INN-08  serendipity windows: user-declared weekly availability
--             windows (max 4 active), pause/resume only, never deleted.
-- AMD-INN-09  verification attestation claims: the DB answers which
--             claims a user may carry; the edge signs them into the
--             portable attestation token.
-- AMD-INN-10  host-mediated introductions: a KYC-verified host proposes a
--             pair; double opt-in opens the pair at MUTUAL through the
--             FR-29 consent ledger — no machine bypass.
--
-- AMD-INN-05 (duress mode) and AMD-INN-07 (on-device match preview) are
-- client-only by design and ship no schema.
--
-- Every value-moving definer requires app.transfer_settlement='on', exactly
-- like AMD-PAY-15. Terms are immutable; guards are pinned.

BEGIN;

-- ============================================================ AMD-INN-01 ===
-- Presence bonds.

CREATE TABLE presence_bonds (
    bond_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner        uuid NOT NULL REFERENCES users (user_id),
    hold_id      uuid NOT NULL REFERENCES wallet_holds (hold_id),
    amount_minor bigint NOT NULL CHECK (amount_minor = 100000),
    state        text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'released', 'forfeited')),
    report_id    uuid REFERENCES reports (report_id),
    placed_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz,
    resolved_by  uuid REFERENCES users (user_id)
);
CREATE UNIQUE INDEX presence_bonds_one_active
    ON presence_bonds (owner) WHERE state = 'active';
CREATE UNIQUE INDEX presence_bonds_hold ON presence_bonds (hold_id);

-- Terms immutable; legal path active -> released | forfeited only.
CREATE OR REPLACE FUNCTION presence_bonds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'presence_bonds is append-only (AMD-INN-01)';
    END IF;
    IF NEW.owner <> OLD.owner OR NEW.hold_id <> OLD.hold_id
       OR NEW.amount_minor <> OLD.amount_minor
       OR NEW.placed_at <> OLD.placed_at THEN
        RAISE EXCEPTION 'bond terms are immutable (AMD-INN-01)';
    END IF;
    IF OLD.state <> 'active' OR NEW.state NOT IN ('released', 'forfeited') THEN
        RAISE EXCEPTION 'illegal bond transition % -> % (AMD-INN-01)',
            OLD.state, NEW.state;
    END IF;
    IF NEW.state = 'forfeited' AND NEW.report_id IS NULL THEN
        RAISE EXCEPTION 'forfeiture requires a report (AMD-INN-01)';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER presence_bonds_guard
    BEFORE UPDATE OR DELETE ON presence_bonds
    FOR EACH ROW EXECUTE FUNCTION presence_bonds_guard();

ALTER TABLE presence_bonds ENABLE ROW LEVEL SECURITY;
CREATE POLICY presence_bonds_owner_read ON presence_bonds
    FOR SELECT USING (owner = app_user());

-- Place a bond. One active bond per user; the pinned amount is reserved
-- through a wallet hold (transfer_id NULL — the bond names the hold, not
-- the other way round).
-- Outcomes: 'placed' | 'forbidden' | 'kyc_required' | 'wallet_unavailable'
-- | 'bond_active' | 'insufficient_funds' | 'invalid_amount'.
CREATE OR REPLACE FUNCTION place_presence_bond()
RETURNS TABLE(outcome text, bond_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user   uuid := app_user();
    v_wallet uuid;
    v_hold   uuid;
    v_bond   uuid;
    v_hold_outcome text;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = v_user AND u.kyc_state = 'verified') THEN
        RETURN QUERY SELECT 'kyc_required', NULL::uuid;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM presence_bonds b
                WHERE b.owner = v_user AND b.state = 'active') THEN
        RETURN QUERY SELECT 'bond_active', NULL::uuid;
        RETURN;
    END IF;
    SELECT w.wallet_id INTO v_wallet FROM wallets w
     WHERE w.owner = v_user AND w.status = 'active';
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'wallet_unavailable', NULL::uuid;
        RETURN;
    END IF;
    v_bond := gen_random_uuid();
    SELECT h.outcome, h.hold_id INTO v_hold_outcome, v_hold
      FROM place_wallet_hold(v_wallet, 100000, NULL) h;
    IF v_hold_outcome <> 'placed' THEN
        RETURN QUERY SELECT v_hold_outcome, NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO presence_bonds (bond_id, owner, hold_id)
    VALUES (v_bond, v_user, v_hold);
    RETURN QUERY SELECT 'placed', v_bond;
END $$;

-- Owner releases an active bond; the hold is voided, nothing moves.
-- Outcomes: 'released' | 'forbidden' | 'unknown_bond'.
CREATE OR REPLACE FUNCTION release_presence_bond(p_bond uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_bond presence_bonds%ROWTYPE;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_bond FROM presence_bonds b
     WHERE b.bond_id = p_bond AND b.state = 'active' FOR UPDATE;
    IF NOT FOUND OR v_bond.owner <> v_user THEN
        RETURN 'unknown_bond';
    END IF;
    PERFORM void_wallet_hold(v_bond.hold_id);
    UPDATE presence_bonds
       SET state = 'released', resolved_at = now(), resolved_by = v_user
     WHERE bond_id = p_bond;
    RETURN 'released';
END $$;

-- Moderator forfeits an active bond on a report: the hold is posted and
-- the value moves user -> platform as fee_charge / fee_revenue entries,
-- audited.
-- Outcomes: 'forfeited' | 'forbidden' | 'unknown_bond' | 'unknown_report'.
CREATE OR REPLACE FUNCTION forfeit_presence_bond(p_bond uuid, p_report uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user   uuid := app_user();
    v_bond   presence_bonds%ROWTYPE;
    v_balance bigint;
    v_platform_balance bigint;
BEGIN
    IF v_user IS NULL OR NOT app_moderator()
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_bond FROM presence_bonds b
     WHERE b.bond_id = p_bond AND b.state = 'active' FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_bond';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM reports r
                    WHERE r.report_id = p_report
                      AND r.reported = v_bond.owner) THEN
        RETURN 'unknown_report';
    END IF;
    UPDATE wallet_holds h
       SET state = 'posted', resolved_at = now()
     WHERE h.hold_id = v_bond.hold_id AND h.state = 'pending';
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_balance
      FROM wallet_entries e
      JOIN wallets w ON w.wallet_id = e.wallet_id
     WHERE w.owner = v_bond.owner;
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)
    SELECT w.wallet_id, 'fee_charge', v_bond.amount_minor,
           v_balance - v_bond.amount_minor
      FROM wallets w WHERE w.owner = v_bond.owner;
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_platform_balance
      FROM wallet_entries e
     WHERE e.wallet_id = '00000000-0000-0000-0000-00000000fee1';
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)
    VALUES ('00000000-0000-0000-0000-00000000fee1', 'fee_revenue',
            v_bond.amount_minor, v_platform_balance + v_bond.amount_minor);
    UPDATE presence_bonds
       SET state = 'forfeited', report_id = p_report,
           resolved_at = now(), resolved_by = v_user
     WHERE bond_id = p_bond;
    PERFORM admin_audit_log(
        v_user,
        'presence_bond.forfeit',
        'report_upheld',
        'presence_bond', p_bond::text,
        NULL,
        jsonb_build_object('owner', v_bond.owner,
                           'amount_minor', v_bond.amount_minor,
                           'report_id', p_report)
    );
    RETURN 'forfeited';
END $$;

-- ============================================================ AMD-INN-02 ===
-- Verified-met receipts. A receipt is a pair event: the first submission
-- opens a 900 s window, the reciprocal submission confirms it. No location,
-- no device data, no free text — the fact and the two timestamps only.

CREATE TABLE met_receipts (
    receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_lo    uuid NOT NULL REFERENCES users (user_id),
    user_hi    uuid NOT NULL REFERENCES users (user_id),
    lo_at      timestamptz,
    hi_at      timestamptz,
    state      text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'confirmed', 'expired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (user_lo < user_hi)
);
-- At most one open window per pair.
CREATE UNIQUE INDEX met_receipts_one_pending
    ON met_receipts (user_lo, user_hi) WHERE state = 'pending';
CREATE INDEX met_receipts_pair ON met_receipts (user_lo, user_hi);

CREATE OR REPLACE FUNCTION met_receipts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'met_receipts is append-only (AMD-INN-02)';
    END IF;
    IF NEW.user_lo <> OLD.user_lo OR NEW.user_hi <> OLD.user_hi
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'receipt terms are immutable (AMD-INN-02)';
    END IF;
    IF OLD.state = 'pending' AND NEW.state NOT IN ('confirmed', 'expired') THEN
        RAISE EXCEPTION 'illegal receipt transition % -> % (AMD-INN-02)',
            OLD.state, NEW.state;
    ELSIF OLD.state <> 'pending' THEN
        RAISE EXCEPTION 'illegal receipt transition % -> % (AMD-INN-02)',
            OLD.state, NEW.state;
    END IF;
    IF OLD.lo_at IS NOT NULL AND NEW.lo_at IS DISTINCT FROM OLD.lo_at THEN
        RAISE EXCEPTION 'receipt timestamps are set-once (AMD-INN-02)';
    END IF;
    IF OLD.hi_at IS NOT NULL AND NEW.hi_at IS DISTINCT FROM OLD.hi_at THEN
        RAISE EXCEPTION 'receipt timestamps are set-once (AMD-INN-02)';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER met_receipts_guard
    BEFORE UPDATE OR DELETE ON met_receipts
    FOR EACH ROW EXECUTE FUNCTION met_receipts_guard();

ALTER TABLE met_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY met_receipts_party_read ON met_receipts
    FOR SELECT USING (app_user() IN (user_lo, user_hi));

-- Submit the caller's half of a co-attestation for a peer. Reciprocal
-- submission inside the pinned 900 s window confirms the receipt.
-- Outcomes: 'pending' | 'confirmed' | 'forbidden' | 'unknown_peer' | 'self'.
CREATE OR REPLACE FUNCTION submit_met_receipt(p_peer uuid)
RETURNS TABLE(outcome text, receipt_id uuid, state text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_lo   uuid;
    v_hi   uuid;
    v_row  met_receipts%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid, NULL::text;
        RETURN;
    END IF;
    IF p_peer IS NULL OR p_peer = v_user THEN
        RETURN QUERY SELECT 'self', NULL::uuid, NULL::text;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = p_peer) THEN
        RETURN QUERY SELECT 'unknown_peer', NULL::uuid, NULL::text;
        RETURN;
    END IF;
    v_lo := LEAST(v_user, p_peer);
    v_hi := GREATEST(v_user, p_peer);
    -- A reciprocal submission inside the window confirms.
    SELECT * INTO v_row FROM met_receipts r
     WHERE r.user_lo = v_lo AND r.user_hi = v_hi AND r.state = 'pending'
       AND r.created_at > now() - interval '900 seconds'
       AND ((v_user = v_lo AND r.lo_at IS NULL)
            OR (v_user = v_hi AND r.hi_at IS NULL))
     ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
        UPDATE met_receipts r
           SET lo_at = CASE WHEN v_user = v_lo THEN now() ELSE r.lo_at END,
               hi_at = CASE WHEN v_user = v_hi THEN now() ELSE r.hi_at END,
               state = 'confirmed'
         WHERE r.receipt_id = v_row.receipt_id;
        RETURN QUERY SELECT 'confirmed', v_row.receipt_id, 'confirmed';
        RETURN;
    END IF;
    INSERT INTO met_receipts (user_lo, user_hi, lo_at, hi_at)
    VALUES (v_lo, v_hi,
            CASE WHEN v_user = v_lo THEN now() END,
            CASE WHEN v_user = v_hi THEN now() END)
    RETURNING met_receipts.receipt_id INTO v_row.receipt_id;
    RETURN QUERY SELECT 'pending', v_row.receipt_id, 'pending';
END $$;

-- Sweep stale windows. Callable by the moderator console or a scheduler
-- role; returns the number expired.
CREATE OR REPLACE FUNCTION expire_met_receipts()
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_count integer;
BEGIN
    IF NOT app_moderator() THEN
        RAISE EXCEPTION 'forbidden';
    END IF;
    UPDATE met_receipts r
       SET state = 'expired'
     WHERE r.state = 'pending'
       AND r.created_at <= now() - interval '900 seconds';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END $$;

-- ============================================================ AMD-INN-03 ===
-- Trust escrow: milestone-based holding between two KYC-verified users.
-- The full amount is reserved up front as a hold on the payer's wallet;
-- the payer releases milestone by milestone; either party may dispute;
-- a moderator resolves a dispute to refund or release the remainder.

CREATE TABLE escrow_agreements (
    escrow_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payer       uuid NOT NULL REFERENCES users (user_id),
    payee       uuid NOT NULL REFERENCES users (user_id),
    total_minor bigint NOT NULL
        CHECK (total_minor > 0 AND total_minor <= 5000000),
    hold_id     uuid NOT NULL REFERENCES wallet_holds (hold_id),
    state       text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'completed', 'refunded', 'disputed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    resolved_by uuid REFERENCES users (user_id),
    CHECK (payer <> payee)
);
CREATE UNIQUE INDEX escrow_agreements_hold ON escrow_agreements (hold_id);
CREATE INDEX escrow_agreements_payer ON escrow_agreements (payer);
CREATE INDEX escrow_agreements_payee ON escrow_agreements (payee);

CREATE TABLE escrow_milestones (
    escrow_id    uuid NOT NULL REFERENCES escrow_agreements (escrow_id),
    seq          smallint NOT NULL CHECK (seq >= 1 AND seq <= 12),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    state        text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'released', 'refunded')),
    resolved_at  timestamptz,
    PRIMARY KEY (escrow_id, seq)
);

CREATE OR REPLACE FUNCTION escrow_agreements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'escrow_agreements is append-only (AMD-INN-03)';
    END IF;
    IF NEW.payer <> OLD.payer OR NEW.payee <> OLD.payee
       OR NEW.total_minor <> OLD.total_minor OR NEW.hold_id <> OLD.hold_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'escrow terms are immutable (AMD-INN-03)';
    END IF;
    IF NOT ((OLD.state = 'active'   AND NEW.state IN ('completed', 'disputed'))
         OR (OLD.state = 'disputed' AND NEW.state IN ('completed', 'refunded'))) THEN
        RAISE EXCEPTION 'illegal escrow transition % -> % (AMD-INN-03)',
            OLD.state, NEW.state;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER escrow_agreements_guard
    BEFORE UPDATE OR DELETE ON escrow_agreements
    FOR EACH ROW EXECUTE FUNCTION escrow_agreements_guard();

CREATE OR REPLACE FUNCTION escrow_milestones_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'escrow_milestones is append-only (AMD-INN-03)';
    END IF;
    IF NEW.escrow_id <> OLD.escrow_id OR NEW.seq <> OLD.seq
       OR NEW.amount_minor <> OLD.amount_minor THEN
        RAISE EXCEPTION 'milestone terms are immutable (AMD-INN-03)';
    END IF;
    IF OLD.state <> 'pending' OR NEW.state NOT IN ('released', 'refunded') THEN
        RAISE EXCEPTION 'illegal milestone transition % -> % (AMD-INN-03)',
            OLD.state, NEW.state;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER escrow_milestones_guard
    BEFORE UPDATE OR DELETE ON escrow_milestones
    FOR EACH ROW EXECUTE FUNCTION escrow_milestones_guard();

ALTER TABLE escrow_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrow_milestones ENABLE ROW LEVEL SECURITY;
CREATE POLICY escrow_agreements_party_read ON escrow_agreements
    FOR SELECT USING (app_user() IN (payer, payee));
CREATE POLICY escrow_milestones_party_read ON escrow_milestones
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM escrow_agreements a
         WHERE a.escrow_id = escrow_milestones.escrow_id
           AND app_user() IN (a.payer, a.payee)));

-- Create an escrow. The milestone list is the contract: 1..12 positive
-- amounts summing to the hold, capped at 5,000,000 minor total.
-- Outcomes: 'created' | 'forbidden' | 'kyc_required' | 'unknown_payee'
-- | 'self' | 'invalid_amounts' | 'wallet_unavailable' | 'insufficient_funds'.
CREATE OR REPLACE FUNCTION create_escrow(p_payee uuid, p_amounts bigint[])
RETURNS TABLE(outcome text, escrow_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user   uuid := app_user();
    v_wallet uuid;
    v_total  bigint;
    v_escrow uuid;
    v_hold   uuid;
    v_hold_outcome text;
    v_seq    smallint := 0;
    v_amount bigint;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF p_payee IS NULL OR p_payee = v_user THEN
        RETURN QUERY SELECT 'self', NULL::uuid;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = p_payee) THEN
        RETURN QUERY SELECT 'unknown_payee', NULL::uuid;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = v_user AND u.kyc_state = 'verified')
       OR NOT EXISTS (SELECT 1 FROM users u
                       WHERE u.user_id = p_payee AND u.kyc_state = 'verified') THEN
        RETURN QUERY SELECT 'kyc_required', NULL::uuid;
        RETURN;
    END IF;
    IF p_amounts IS NULL OR cardinality(p_amounts) < 1
       OR cardinality(p_amounts) > 12
       OR EXISTS (SELECT 1 FROM unnest(p_amounts) a
                   WHERE a IS NULL OR a <= 0) THEN
        RETURN QUERY SELECT 'invalid_amounts', NULL::uuid;
        RETURN;
    END IF;
    SELECT sum(a) INTO v_total FROM unnest(p_amounts) a;
    IF v_total > 5000000 THEN
        RETURN QUERY SELECT 'invalid_amounts', NULL::uuid;
        RETURN;
    END IF;
    SELECT w.wallet_id INTO v_wallet FROM wallets w
     WHERE w.owner = v_user AND w.status = 'active';
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'wallet_unavailable', NULL::uuid;
        RETURN;
    END IF;
    v_escrow := gen_random_uuid();
    SELECT h.outcome, h.hold_id INTO v_hold_outcome, v_hold
      FROM place_wallet_hold(v_wallet, v_total, NULL) h;
    IF v_hold_outcome <> 'placed' THEN
        RETURN QUERY SELECT v_hold_outcome, NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO escrow_agreements (escrow_id, payer, payee, total_minor, hold_id)
    VALUES (v_escrow, v_user, p_payee, v_total, v_hold);
    FOREACH v_amount IN ARRAY p_amounts LOOP
        v_seq := v_seq + 1;
        INSERT INTO escrow_milestones (escrow_id, seq, amount_minor)
        VALUES (v_escrow, v_seq, v_amount);
    END LOOP;
    RETURN QUERY SELECT 'created', v_escrow;
END $$;

-- Release one milestone to the payee. Payer only. When the last pending
-- milestone releases, the hold is voided and the escrow completes.
-- Outcomes: 'released' | 'completed' | 'forbidden' | 'unknown_escrow'
-- | 'unknown_milestone'.
CREATE OR REPLACE FUNCTION release_escrow_milestone(p_escrow uuid, p_seq smallint)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user   uuid := app_user();
    v_escrow escrow_agreements%ROWTYPE;
    v_ms     escrow_milestones%ROWTYPE;
    v_payer_wallet uuid;
    v_payee_wallet uuid;
    v_balance bigint;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_escrow FROM escrow_agreements a
     WHERE a.escrow_id = p_escrow AND a.state = 'active' FOR UPDATE;
    IF NOT FOUND OR v_escrow.payer <> v_user THEN
        RETURN 'unknown_escrow';
    END IF;
    SELECT * INTO v_ms FROM escrow_milestones m
     WHERE m.escrow_id = p_escrow AND m.seq = p_seq AND m.state = 'pending'
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_milestone';
    END IF;
    SELECT w.wallet_id INTO v_payer_wallet FROM wallets w
     WHERE w.owner = v_escrow.payer AND w.status = 'active';
    SELECT w.wallet_id INTO v_payee_wallet FROM wallets w
     WHERE w.owner = v_escrow.payee AND w.status = 'active';
    IF v_payer_wallet IS NULL OR v_payee_wallet IS NULL THEN
        RETURN 'forbidden';
    END IF;
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
     WHERE escrow_id = p_escrow AND seq = p_seq;
    IF NOT EXISTS (SELECT 1 FROM escrow_milestones m
                    WHERE m.escrow_id = p_escrow AND m.state = 'pending') THEN
        PERFORM void_wallet_hold(v_escrow.hold_id);
        UPDATE escrow_agreements
           SET state = 'completed', resolved_at = now(), resolved_by = v_user
         WHERE escrow_id = p_escrow;
        RETURN 'completed';
    END IF;
    RETURN 'released';
END $$;

-- Either party may dispute an active escrow; value stays held.
-- Outcomes: 'disputed' | 'forbidden' | 'unknown_escrow'.
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
       SET state = 'disputed'
     WHERE a.escrow_id = p_escrow AND a.state = 'active'
       AND v_user IN (a.payer, a.payee);
    IF NOT FOUND THEN
        RETURN 'unknown_escrow';
    END IF;
    RETURN 'disputed';
END $$;

-- Moderator resolves a dispute: 'refund' voids the hold and refunds the
-- remaining milestones; 'release' pays every remaining milestone to the
-- payee, voids the hold, and completes the escrow. Audited either way.
-- Outcomes: 'resolved' | 'forbidden' | 'unknown_escrow' | 'invalid_decision'.
CREATE OR REPLACE FUNCTION resolve_escrow(p_escrow uuid, p_decision text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user   uuid := app_user();
    v_escrow escrow_agreements%ROWTYPE;
    v_ms     escrow_milestones%ROWTYPE;
    v_payer_wallet uuid;
    v_payee_wallet uuid;
    v_balance bigint;
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

-- ============================================================ AMD-INN-04 ===
-- Group stakes: a pinned stake on a group-table seat. Refunded when the
-- edge has verified the venue check-in token (venues.checkin_secret — the
-- token never touches the DB); forfeited by the 24 h sweep.

CREATE TABLE group_stakes (
    stake_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id     uuid NOT NULL REFERENCES group_tables (table_id),
    user_id      uuid NOT NULL REFERENCES users (user_id),
    hold_id      uuid NOT NULL REFERENCES wallet_holds (hold_id),
    amount_minor bigint NOT NULL CHECK (amount_minor = 50000),
    state        text NOT NULL DEFAULT 'staked'
        CHECK (state IN ('staked', 'refunded', 'forfeited')),
    placed_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz
);
CREATE UNIQUE INDEX group_stakes_one_active
    ON group_stakes (table_id, user_id) WHERE state = 'staked';
CREATE UNIQUE INDEX group_stakes_hold ON group_stakes (hold_id);

CREATE OR REPLACE FUNCTION group_stakes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'group_stakes is append-only (AMD-INN-04)';
    END IF;
    IF NEW.table_id <> OLD.table_id OR NEW.user_id <> OLD.user_id
       OR NEW.hold_id <> OLD.hold_id OR NEW.amount_minor <> OLD.amount_minor
       OR NEW.placed_at <> OLD.placed_at THEN
        RAISE EXCEPTION 'stake terms are immutable (AMD-INN-04)';
    END IF;
    IF OLD.state <> 'staked' OR NEW.state NOT IN ('refunded', 'forfeited') THEN
        RAISE EXCEPTION 'illegal stake transition % -> % (AMD-INN-04)',
            OLD.state, NEW.state;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER group_stakes_guard
    BEFORE UPDATE OR DELETE ON group_stakes
    FOR EACH ROW EXECUTE FUNCTION group_stakes_guard();

ALTER TABLE group_stakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY group_stakes_owner_read ON group_stakes
    FOR SELECT USING (user_id = app_user());

-- Stake a seat. The table must be open and under the SEC-33 six-seat cap;
-- one active stake per user per table.
-- Outcomes: 'staked' | 'forbidden' | 'kyc_required' | 'unknown_table'
-- | 'table_closed' | 'table_full' | 'stake_active' | 'wallet_unavailable'
-- | 'insufficient_funds'.
CREATE OR REPLACE FUNCTION place_group_stake(p_table uuid)
RETURNS TABLE(outcome text, stake_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user   uuid := app_user();
    v_table  group_tables%ROWTYPE;
    v_wallet uuid;
    v_stake  uuid;
    v_hold   uuid;
    v_hold_outcome text;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = v_user AND u.kyc_state = 'verified') THEN
        RETURN QUERY SELECT 'kyc_required', NULL::uuid;
        RETURN;
    END IF;
    SELECT * INTO v_table FROM group_tables t
     WHERE t.table_id = p_table FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_table', NULL::uuid;
        RETURN;
    END IF;
    IF v_table.state <> 'open' THEN
        RETURN QUERY SELECT 'table_closed', NULL::uuid;
        RETURN;
    END IF;
    IF (SELECT count(*) FROM group_stakes s
         WHERE s.table_id = p_table AND s.state = 'staked') >= 6 THEN
        RETURN QUERY SELECT 'table_full', NULL::uuid;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM group_stakes s
                WHERE s.table_id = p_table AND s.user_id = v_user
                  AND s.state = 'staked') THEN
        RETURN QUERY SELECT 'stake_active', NULL::uuid;
        RETURN;
    END IF;
    SELECT w.wallet_id INTO v_wallet FROM wallets w
     WHERE w.owner = v_user AND w.status = 'active';
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'wallet_unavailable', NULL::uuid;
        RETURN;
    END IF;
    v_stake := gen_random_uuid();
    SELECT h.outcome, h.hold_id INTO v_hold_outcome, v_hold
      FROM place_wallet_hold(v_wallet, 50000, NULL) h;
    IF v_hold_outcome <> 'placed' THEN
        RETURN QUERY SELECT v_hold_outcome, NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO group_stakes (stake_id, table_id, user_id, hold_id)
    VALUES (v_stake, p_table, v_user, v_hold);
    RETURN QUERY SELECT 'staked', v_stake;
END $$;

-- Refund after the edge verified venue check-in. Owner or a moderator.
-- Outcomes: 'refunded' | 'forbidden' | 'unknown_stake'.
CREATE OR REPLACE FUNCTION refund_group_stake(p_stake uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user  uuid := app_user();
    v_stake group_stakes%ROWTYPE;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_stake FROM group_stakes s
     WHERE s.stake_id = p_stake AND s.state = 'staked' FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_stake';
    END IF;
    IF v_stake.user_id <> v_user AND NOT app_moderator() THEN
        RETURN 'forbidden';
    END IF;
    PERFORM void_wallet_hold(v_stake.hold_id);
    UPDATE group_stakes
       SET state = 'refunded', resolved_at = now()
     WHERE stake_id = p_stake;
    RETURN 'refunded';
END $$;

-- Moderator sweep: stakes older than the pinned 24 h with no check-in
-- refund are forfeited — the hold posts and the value moves user ->
-- platform as fee entries. Returns the number forfeited.
CREATE OR REPLACE FUNCTION forfeit_group_stakes()
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user  uuid := app_user();
    v_stake group_stakes%ROWTYPE;
    v_wallet uuid;
    v_balance bigint;
    v_count integer := 0;
BEGIN
    IF v_user IS NULL OR NOT app_moderator()
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'forbidden';
    END IF;
    FOR v_stake IN SELECT * FROM group_stakes s
                    WHERE s.state = 'staked'
                      AND s.placed_at <= now() - interval '24 hours'
                    FOR UPDATE LOOP
        SELECT w.wallet_id INTO v_wallet FROM wallets w
         WHERE w.owner = v_stake.user_id AND w.status = 'active';
        -- Wallet gone or frozen: skip this sweep; the next run retries.
        IF v_wallet IS NULL THEN
            CONTINUE;
        END IF;
        UPDATE wallet_holds h
           SET state = 'posted', resolved_at = now()
         WHERE h.hold_id = v_stake.hold_id AND h.state = 'pending';
        SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                                 THEN e.amount_minor ELSE -e.amount_minor END), 0)
          INTO v_balance FROM wallet_entries e WHERE e.wallet_id = v_wallet;
        INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)
        VALUES (v_wallet, 'fee_charge', v_stake.amount_minor,
                v_balance - v_stake.amount_minor);
        SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                                 THEN e.amount_minor ELSE -e.amount_minor END), 0)
          INTO v_balance FROM wallet_entries e
         WHERE e.wallet_id = '00000000-0000-0000-0000-00000000fee1';
        INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)
        VALUES ('00000000-0000-0000-0000-00000000fee1', 'fee_revenue',
                v_stake.amount_minor, v_balance + v_stake.amount_minor);
        UPDATE group_stakes
           SET state = 'forfeited', resolved_at = now()
         WHERE stake_id = v_stake.stake_id;
        v_count := v_count + 1;
    END LOOP;
    PERFORM admin_audit_log(
        v_user,
        'group_stakes.forfeit_sweep',
        'no_checkin_24h',
        'group_stakes', '*',
        NULL,
        jsonb_build_object('forfeited', v_count)
    );
    RETURN v_count;
END $$;

-- ============================================================ AMD-INN-06 ===
-- Selective-disclosure grants. A grant proves exactly one claim to exactly
-- one verifier, once, inside a pinned 900 s TTL. The secret is returned to
-- the holder at issue and never stored in clear — only its digest — so a
-- database read cannot replay a grant.

CREATE TABLE disclosure_grants (
    grant_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account      uuid NOT NULL REFERENCES users (user_id),
    claim        text NOT NULL CHECK (claim IN ('over_18', 'kyc_verified')),
    secret_digest text NOT NULL,
    issued_at    timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    CHECK (expires_at > issued_at)
);
CREATE INDEX disclosure_grants_account ON disclosure_grants (account);

CREATE OR REPLACE FUNCTION disclosure_grants_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'disclosure_grants is append-only (AMD-INN-06)';
    END IF;
    IF NEW.account <> OLD.account OR NEW.claim <> OLD.claim
       OR NEW.secret_digest <> OLD.secret_digest
       OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at THEN
        RAISE EXCEPTION 'grant terms are immutable (AMD-INN-06)';
    END IF;
    -- The only legal mutation: unused -> used, exactly once.
    IF OLD.used_at IS NOT NULL OR NEW.used_at IS NULL THEN
        RAISE EXCEPTION 'grant use is single and terminal (AMD-INN-06)';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER disclosure_grants_guard
    BEFORE UPDATE OR DELETE ON disclosure_grants
    FOR EACH ROW EXECUTE FUNCTION disclosure_grants_guard();

ALTER TABLE disclosure_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY disclosure_grants_owner_read ON disclosure_grants
    FOR SELECT USING (account = app_user());

-- Issue a grant. 'kyc_verified' requires the verified KYC state; 'over_18'
-- is proven from the declared birth year. TTL is pinned at 900 s.
-- Outcomes: 'issued' | 'forbidden' | 'invalid_claim' | 'claim_not_proven'.
CREATE OR REPLACE FUNCTION issue_disclosure_grant(p_claim text)
RETURNS TABLE(outcome text, grant_id uuid, secret text, expires_at timestamptz)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user   uuid := app_user();
    v_secret text;
    v_grant  uuid;
    v_exp    timestamptz;
BEGIN
    IF v_user IS NULL THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid, NULL::text, NULL::timestamptz;
        RETURN;
    END IF;
    IF p_claim NOT IN ('over_18', 'kyc_verified') THEN
        RETURN QUERY SELECT 'invalid_claim', NULL::uuid, NULL::text, NULL::timestamptz;
        RETURN;
    END IF;
    IF p_claim = 'kyc_verified'
       AND NOT EXISTS (SELECT 1 FROM users u
                        WHERE u.user_id = v_user AND u.kyc_state = 'verified') THEN
        RETURN QUERY SELECT 'claim_not_proven', NULL::uuid, NULL::text, NULL::timestamptz;
        RETURN;
    END IF;
    IF p_claim = 'over_18'
       AND NOT EXISTS (SELECT 1 FROM users u
                        WHERE u.user_id = v_user AND u.birth_year IS NOT NULL
                          AND u.birth_year <= extract(year FROM now())::int - 18) THEN
        RETURN QUERY SELECT 'claim_not_proven', NULL::uuid, NULL::text, NULL::timestamptz;
        RETURN;
    END IF;
    v_secret := encode(gen_random_bytes(24), 'hex');
    v_exp := now() + interval '900 seconds';
    INSERT INTO disclosure_grants (account, claim, secret_digest, expires_at)
    VALUES (v_user, p_claim, encode(digest(v_secret, 'sha256'), 'hex'), v_exp)
    RETURNING disclosure_grants.grant_id INTO v_grant;
    RETURN QUERY SELECT 'issued', v_grant, v_secret, v_exp;
END $$;

-- Redeem a grant. Venue-ops only (the verifier console); returns the claim
-- and marks the grant used. The verifier learns the claim — never the
-- account, the birth year, or the KYC record.
-- Returns: 'over_18' | 'kyc_verified' | 'forbidden' | 'invalid' | 'expired'
-- | 'used'.
CREATE OR REPLACE FUNCTION redeem_disclosure_grant(p_grant uuid, p_secret text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_grant disclosure_grants%ROWTYPE;
BEGIN
    IF NOT app_venue_ops() THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_grant FROM disclosure_grants g
     WHERE g.grant_id = p_grant
       AND g.secret_digest = encode(digest(COALESCE(p_secret, ''), 'sha256'), 'hex')
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'invalid';
    END IF;
    IF v_grant.used_at IS NOT NULL THEN
        RETURN 'used';
    END IF;
    IF v_grant.expires_at <= now() THEN
        RETURN 'expired';
    END IF;
    UPDATE disclosure_grants SET used_at = now() WHERE grant_id = p_grant;
    RETURN v_grant.claim;
END $$;

-- ============================================================ AMD-INN-08 ===
-- Serendipity windows: user-declared weekly availability. Max four active
-- windows per account; windows pause and resume but are never deleted and
-- their terms never change — delete and recreate instead.

CREATE TABLE serendipity_windows (
    window_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account    uuid NOT NULL REFERENCES users (user_id),
    weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    hour_start smallint NOT NULL CHECK (hour_start BETWEEN 0 AND 23),
    hour_end   smallint NOT NULL CHECK (hour_end BETWEEN 1 AND 24),
    market     text NOT NULL CHECK (char_length(market) BETWEEN 1 AND 64),
    state      text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'paused')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (hour_end > hour_start)
);
CREATE INDEX serendipity_windows_account ON serendipity_windows (account);
CREATE INDEX serendipity_windows_match
    ON serendipity_windows (weekday, state) WHERE state = 'active';

CREATE OR REPLACE FUNCTION serendipity_windows_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'serendipity_windows is append-only (AMD-INN-08)';
    END IF;
    IF NEW.account <> OLD.account OR NEW.weekday <> OLD.weekday
       OR NEW.hour_start <> OLD.hour_start OR NEW.hour_end <> OLD.hour_end
       OR NEW.market <> OLD.market OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'window terms are immutable (AMD-INN-08)';
    END IF;
    IF NEW.state NOT IN ('active', 'paused') THEN
        RAISE EXCEPTION 'illegal window transition % -> % (AMD-INN-08)',
            OLD.state, NEW.state;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER serendipity_windows_guard
    BEFORE UPDATE OR DELETE ON serendipity_windows
    FOR EACH ROW EXECUTE FUNCTION serendipity_windows_guard();

ALTER TABLE serendipity_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY serendipity_windows_owner_read ON serendipity_windows
    FOR SELECT USING (account = app_user());

-- Outcomes: 'added' | 'forbidden' | 'invalid_window' | 'too_many'.
CREATE OR REPLACE FUNCTION add_serendipity_window(
    p_weekday smallint, p_hour_start smallint, p_hour_end smallint,
    p_market text)
RETURNS TABLE(outcome text, window_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_id   uuid;
BEGIN
    IF v_user IS NULL THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF p_weekday IS NULL OR p_weekday NOT BETWEEN 0 AND 6
       OR p_hour_start IS NULL OR p_hour_start NOT BETWEEN 0 AND 23
       OR p_hour_end IS NULL OR p_hour_end NOT BETWEEN 1 AND 24
       OR p_hour_end <= p_hour_start
       OR p_market IS NULL OR char_length(p_market) NOT BETWEEN 1 AND 64 THEN
        RETURN QUERY SELECT 'invalid_window', NULL::uuid;
        RETURN;
    END IF;
    IF (SELECT count(*) FROM serendipity_windows w
         WHERE w.account = v_user AND w.state = 'active') >= 4 THEN
        RETURN QUERY SELECT 'too_many', NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO serendipity_windows (account, weekday, hour_start, hour_end, market)
    VALUES (v_user, p_weekday, p_hour_start, p_hour_end, p_market)
    RETURNING serendipity_windows.window_id INTO v_id;
    RETURN QUERY SELECT 'added', v_id;
END $$;

-- Pause or resume. Resuming honours the same four-active cap.
-- Outcomes: 'updated' | 'forbidden' | 'unknown_window' | 'invalid_state'
-- | 'too_many'.
CREATE OR REPLACE FUNCTION set_serendipity_window_state(p_window uuid, p_state text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    IF p_state NOT IN ('active', 'paused') THEN
        RETURN 'invalid_state';
    END IF;
    IF p_state = 'active'
       AND (SELECT count(*) FROM serendipity_windows w
             WHERE w.account = v_user AND w.state = 'active'
               AND w.window_id <> p_window) >= 4 THEN
        RETURN 'too_many';
    END IF;
    UPDATE serendipity_windows w
       SET state = p_state
     WHERE w.window_id = p_window AND w.account = v_user;
    IF NOT FOUND THEN
        RETURN 'unknown_window';
    END IF;
    RETURN 'updated';
END $$;

-- Do the caller and a peer overlap on at least one active window? Same
-- weekday, same market, intersecting hours. Pure read; reveals a boolean,
-- never the peer's windows.
CREATE OR REPLACE FUNCTION serendipity_overlap(p_peer uuid)
RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
BEGIN
    IF v_user IS NULL OR p_peer IS NULL OR p_peer = v_user THEN
        RETURN false;
    END IF;
    RETURN EXISTS (
        SELECT 1 FROM serendipity_windows a
        JOIN serendipity_windows b
          ON b.account = p_peer AND b.state = 'active'
         AND b.weekday = a.weekday AND b.market = a.market
         AND b.hour_start < a.hour_end AND a.hour_start < b.hour_end
        WHERE a.account = v_user AND a.state = 'active');
END $$;

-- ============================================================ AMD-INN-10 ===
-- Host-mediated introductions. A KYC-verified host proposes two
-- KYC-verified parties; each party answers for themselves. When both
-- accept, the pair surfaces at MUTUAL — written through the FR-29 consent
-- ledger (DETECTED -> EXPRESSED -> MUTUAL), never by direct UPDATE. OPEN
-- still requires the standard offer flow.

CREATE TABLE introductions (
    intro_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host       uuid NOT NULL REFERENCES users (user_id),
    party_lo   uuid NOT NULL REFERENCES users (user_id),
    party_hi   uuid NOT NULL REFERENCES users (user_id),
    state      text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'accepted', 'declined', 'expired')),
    lo_at      timestamptz,
    hi_at      timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CHECK (party_lo < party_hi),
    CHECK (host <> party_lo AND host <> party_hi)
);
-- One open introduction per canonical pair.
CREATE UNIQUE INDEX introductions_one_open
    ON introductions (party_lo, party_hi)
    WHERE state IN ('pending', 'accepted');
CREATE INDEX introductions_host ON introductions (host);

CREATE OR REPLACE FUNCTION introductions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'introductions is append-only (AMD-INN-10)';
    END IF;
    IF NEW.host <> OLD.host OR NEW.party_lo <> OLD.party_lo
       OR NEW.party_hi <> OLD.party_hi OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'introduction terms are immutable (AMD-INN-10)';
    END IF;
    IF OLD.state <> 'pending'
       OR NEW.state NOT IN ('accepted', 'declined', 'expired') THEN
        RAISE EXCEPTION 'illegal introduction transition % -> % (AMD-INN-10)',
            OLD.state, NEW.state;
    END IF;
    IF OLD.lo_at IS NOT NULL AND NEW.lo_at IS DISTINCT FROM OLD.lo_at THEN
        RAISE EXCEPTION 'introduction answers are set-once (AMD-INN-10)';
    END IF;
    IF OLD.hi_at IS NOT NULL AND NEW.hi_at IS DISTINCT FROM OLD.hi_at THEN
        RAISE EXCEPTION 'introduction answers are set-once (AMD-INN-10)';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER introductions_guard
    BEFORE UPDATE OR DELETE ON introductions
    FOR EACH ROW EXECUTE FUNCTION introductions_guard();

ALTER TABLE introductions ENABLE ROW LEVEL SECURITY;
CREATE POLICY introductions_member_read ON introductions
    FOR SELECT USING (app_user() IN (host, party_lo, party_hi));

-- Propose. All three KYC-verified; a block between the parties in either
-- direction is an absolute refusal.
-- Outcomes: 'proposed' | 'forbidden' | 'kyc_required' | 'invalid_parties'
-- | 'blocked' | 'duplicate'.
CREATE OR REPLACE FUNCTION propose_introduction(p_a uuid, p_b uuid)
RETURNS TABLE(outcome text, intro_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_lo   uuid;
    v_hi   uuid;
    v_id   uuid;
BEGIN
    IF v_user IS NULL THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF p_a IS NULL OR p_b IS NULL OR p_a = p_b
       OR v_user IN (p_a, p_b)
       OR NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = p_a)
       OR NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = p_b) THEN
        RETURN QUERY SELECT 'invalid_parties', NULL::uuid;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = v_user AND u.kyc_state = 'verified')
       OR NOT EXISTS (SELECT 1 FROM users u
                       WHERE u.user_id = p_a AND u.kyc_state = 'verified')
       OR NOT EXISTS (SELECT 1 FROM users u
                       WHERE u.user_id = p_b AND u.kyc_state = 'verified') THEN
        RETURN QUERY SELECT 'kyc_required', NULL::uuid;
        RETURN;
    END IF;
    v_lo := LEAST(p_a, p_b);
    v_hi := GREATEST(p_a, p_b);
    IF EXISTS (SELECT 1 FROM blocks b
                WHERE (b.blocker = v_lo AND b.blocked = v_hi)
                   OR (b.blocker = v_hi AND b.blocked = v_lo)) THEN
        RETURN QUERY SELECT 'blocked', NULL::uuid;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM introductions i
                WHERE i.party_lo = v_lo AND i.party_hi = v_hi
                  AND i.state IN ('pending', 'accepted')) THEN
        RETURN QUERY SELECT 'duplicate', NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO introductions (host, party_lo, party_hi)
    VALUES (v_user, v_lo, v_hi)
    RETURNING introductions.intro_id INTO v_id;
    RETURN QUERY SELECT 'proposed', v_id;
END $$;

-- A party answers. The first accept is recorded; the second accept moves
-- the introduction to 'accepted' and walks the pair's consent ledger to
-- MUTUAL — DETECTED, EXPRESSED, MUTUAL, each row through FR-29.
-- Outcomes: 'recorded' | 'accepted' | 'declined' | 'forbidden'
-- | 'unknown_introduction' | 'invalid_decision'.
CREATE OR REPLACE FUNCTION answer_introduction(p_intro uuid, p_decision text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user  uuid := app_user();
    v_intro introductions%ROWTYPE;
    v_pair  matches%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    IF p_decision NOT IN ('accept', 'decline') THEN
        RETURN 'invalid_decision';
    END IF;
    SELECT * INTO v_intro FROM introductions i
     WHERE i.intro_id = p_intro AND i.state = 'pending' FOR UPDATE;
    IF NOT FOUND OR v_user NOT IN (v_intro.party_lo, v_intro.party_hi) THEN
        RETURN 'unknown_introduction';
    END IF;
    IF p_decision = 'decline' THEN
        UPDATE introductions
           SET state = 'declined', resolved_at = now()
         WHERE intro_id = p_intro;
        RETURN 'declined';
    END IF;
    UPDATE introductions
       SET lo_at = CASE WHEN v_user = v_intro.party_lo THEN now() ELSE lo_at END,
           hi_at = CASE WHEN v_user = v_intro.party_hi THEN now() ELSE hi_at END
     WHERE intro_id = p_intro;
    IF (v_intro.party_lo = v_user AND v_intro.hi_at IS NULL)
       OR (v_intro.party_hi = v_user AND v_intro.lo_at IS NULL) THEN
        RETURN 'recorded';
    END IF;
    -- Both parties have accepted: open the pair at MUTUAL via the ledger.
    UPDATE introductions
       SET state = 'accepted', resolved_at = now()
     WHERE intro_id = p_intro;
    INSERT INTO matches (user_lo, user_hi)
    VALUES (v_intro.party_lo, v_intro.party_hi)
    ON CONFLICT (user_lo, user_hi) DO NOTHING;
    SELECT * INTO v_pair FROM matches m
     WHERE m.user_lo = v_intro.party_lo AND m.user_hi = v_intro.party_hi;
    IF v_pair.state = 'DETECTED' THEN
        INSERT INTO consent_ledger (pair_id, actor, from_state, to_state)
        VALUES (v_pair.pair_id, v_intro.party_lo, 'DETECTED', 'EXPRESSED'),
               (v_pair.pair_id, v_intro.party_hi, 'EXPRESSED', 'MUTUAL');
    ELSIF v_pair.state = 'NUDGED' THEN
        INSERT INTO consent_ledger (pair_id, actor, from_state, to_state)
        VALUES (v_pair.pair_id, v_intro.party_lo, 'NUDGED', 'EXPRESSED'),
               (v_pair.pair_id, v_intro.party_hi, 'EXPRESSED', 'MUTUAL');
    ELSIF v_pair.state = 'EXPRESSED' THEN
        INSERT INTO consent_ledger (pair_id, actor, from_state, to_state)
        VALUES (v_pair.pair_id, v_intro.party_hi, 'EXPRESSED', 'MUTUAL');
    END IF;
    RETURN 'accepted';
END $$;

-- Moderator sweep: unanswered introductions expire after the pinned 72 h.
CREATE OR REPLACE FUNCTION expire_introductions()
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_count integer;
BEGIN
    IF NOT app_moderator() THEN
        RAISE EXCEPTION 'forbidden';
    END IF;
    UPDATE introductions i
       SET state = 'expired', resolved_at = now()
     WHERE i.state = 'pending'
       AND i.created_at <= now() - interval '72 hours';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END $$;

-- ============================================================ AMD-INN-09 ===
-- Verification attestation claims (the AMD-INN-09 verification token — the SEC-17 repo-wide guard bans the document vocabulary in
-- schema, so the wire name is attestation). The database answers which
-- claims the caller may carry; the edge signs them into the portable
-- token. No table — attestations are stateless HMAC tokens verified
-- without a lookup.
CREATE OR REPLACE FUNCTION attestation_claims()
RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user   uuid := app_user();
    v_claims text[] := ARRAY[]::text[];
BEGIN
    IF v_user IS NULL THEN
        RETURN jsonb_build_object('claims', v_claims);
    END IF;
    IF EXISTS (SELECT 1 FROM users u
                WHERE u.user_id = v_user AND u.kyc_state = 'verified') THEN
        v_claims := v_claims || 'kyc_verified';
    END IF;
    IF EXISTS (SELECT 1 FROM users u
                WHERE u.user_id = v_user AND u.birth_year IS NOT NULL
                  AND u.birth_year <= extract(year FROM now())::int - 18) THEN
        v_claims := v_claims || 'over_18';
    END IF;
    RETURN jsonb_build_object('claims', v_claims);
END $$;

-- ------------------------------------------------------------ grants -------
-- Reads are RLS-governed; every write flows through the definers above.
GRANT SELECT ON presence_bonds, met_receipts, escrow_agreements,
                escrow_milestones, group_stakes, disclosure_grants,
                serendipity_windows, introductions TO presence_app;
GRANT EXECUTE ON FUNCTION place_presence_bond() TO presence_app;
GRANT EXECUTE ON FUNCTION release_presence_bond(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION forfeit_presence_bond(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION submit_met_receipt(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION expire_met_receipts() TO presence_app;
GRANT EXECUTE ON FUNCTION create_escrow(uuid, bigint[]) TO presence_app;
GRANT EXECUTE ON FUNCTION release_escrow_milestone(uuid, smallint) TO presence_app;
GRANT EXECUTE ON FUNCTION dispute_escrow(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION resolve_escrow(uuid, text) TO presence_app;
GRANT EXECUTE ON FUNCTION place_group_stake(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION refund_group_stake(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION forfeit_group_stakes() TO presence_app;
GRANT EXECUTE ON FUNCTION issue_disclosure_grant(text) TO presence_app;
GRANT EXECUTE ON FUNCTION redeem_disclosure_grant(uuid, text) TO presence_app;
GRANT EXECUTE ON FUNCTION add_serendipity_window(smallint, smallint, smallint, text) TO presence_app;
GRANT EXECUTE ON FUNCTION set_serendipity_window_state(uuid, text) TO presence_app;
GRANT EXECUTE ON FUNCTION serendipity_overlap(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION propose_introduction(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION answer_introduction(uuid, text) TO presence_app;
GRANT EXECUTE ON FUNCTION expire_introductions() TO presence_app;
GRANT EXECUTE ON FUNCTION attestation_claims() TO presence_app;

COMMIT;
