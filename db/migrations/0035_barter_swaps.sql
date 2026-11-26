-- presence — migration 0035: barter swaps (batch 60, SRS Addendum 001
-- AMD-SWP-01..05).
--
-- AMD-SWP-01  swap_listings: a structured have/want record — have category,
--             want set (1..3 distinct), value estimate, market, state —
--             and nothing else (no description, no photo, no free text;
--             FR-87/FR-96/SEC-37 unchanged). Terms immutable; the
--             listed|held|swapped|removed state machine is guarded; at
--             most 12 live swaps per owner. A swap is a marketplace mode:
--             it gates under the existing `marketplace` vertical.
-- AMD-SWP-02  reciprocal matching: swap_candidates is reciprocal through
--             the TR-18 materialized taxonomy_closure, same-market,
--             KYC-gated, block-aware both directions, callable only by a
--             caller holding a listed swap, LIMIT 50, no owner projection
--             (FR-30).
-- AMD-SWP-03  swap_agreements: the optional cash balancer is reserved as a
--             wallet hold AT PROPOSE TIME inside the AMD-PAY-15 settlement
--             gate (the AMD-PAY-12 definers; no new value machinery).
--             Acceptance re-proves both sides' KYC and waits for both
--             required bonds; confirmations are set-once; the second
--             confirmation settles atomically. Proposals expire at 72 h
--             (cancel + unwind); accepted agreements escalate to disputed
--             at 168 h. Every transition lands in swap_events, which is
--             append-only for every path.
-- AMD-SWP-04  swap_bonds: pinned at 100000 minor (NGN 1,000 — the
--             presence_bonds amount), hold-backed, one active bond per
--             party per agreement. A forfeited bond pays THE COUNTERPARTY,
--             never the fee wallet. v1 barter carries NO cash fee.
-- AMD-SWP-05  moderation alone resolves a disputed swap: refund unwinds
--             and relists, release settles and completes; an optional bond
--             forfeits to the other party. Audited via admin_audit_log.
--             dsar_export gains a 'swaps' key; wallet_reconciliation gains
--             openSwapDisputes, oldestSwapDisputeSeconds and stuckSwaps so
--             stuck barter value is observable (the AMD-ESC-02 discipline).
--
-- Every hold-touching definer requires app.transfer_settlement='on',
-- exactly like the escrow definers.

BEGIN;

-- ------------------------------------------------------------- tables ------

CREATE TABLE swap_listings (
    swap_listing_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner        uuid NOT NULL REFERENCES users (user_id),
    have_category text NOT NULL REFERENCES taxonomy_nodes (node_id),
    want_categories text[] NOT NULL,
    value_estimate_minor bigint NOT NULL
               CHECK (value_estimate_minor > 0
                      AND value_estimate_minor <= 5000000),
    currency     text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
    market       text NOT NULL REFERENCES market_config (market_id),
    state        text NOT NULL DEFAULT 'listed'
               CHECK (state IN ('listed', 'held', 'swapped', 'removed')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    closed_at    timestamptz
);
CREATE INDEX swap_listings_browse
    ON swap_listings (market, have_category, state)
    WHERE state IN ('listed', 'held');
CREATE INDEX swap_listings_owner ON swap_listings (owner);

CREATE TABLE swap_agreements (
    agreement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    proposer_listing uuid NOT NULL REFERENCES swap_listings (swap_listing_id),
    counterparty_listing uuid NOT NULL REFERENCES swap_listings (swap_listing_id),
    proposer     uuid NOT NULL REFERENCES users (user_id),
    counterparty uuid NOT NULL REFERENCES users (user_id),
    -- The balancer the proposer offers the counterparty; 0 = pure barter.
    -- Reserved as a wallet hold at propose time (AMD-SWP-03).
    balance_minor bigint NOT NULL DEFAULT 0
               CHECK (balance_minor >= 0 AND balance_minor <= 5000000),
    balance_hold_id uuid REFERENCES wallet_holds (hold_id),
    requires_bond boolean NOT NULL DEFAULT false,
    state        text NOT NULL DEFAULT 'proposed'
               CHECK (state IN ('proposed', 'accepted', 'completed',
                                'cancelled', 'disputed')),
    proposer_confirmed_at     timestamptz,
    counterparty_confirmed_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz,           -- accept / reject / cancel
    disputed_at  timestamptz,
    completed_at timestamptz,
    CHECK (proposer <> counterparty)
);
-- One open agreement per listing: a listing's held state and an agreement's
-- open state can never diverge.
CREATE UNIQUE INDEX swap_agreements_one_open_proposer
    ON swap_agreements (proposer_listing)
    WHERE state IN ('proposed', 'accepted');
CREATE UNIQUE INDEX swap_agreements_one_open_counterparty
    ON swap_agreements (counterparty_listing)
    WHERE state IN ('proposed', 'accepted');
CREATE INDEX swap_agreements_proposer ON swap_agreements (proposer);
CREATE INDEX swap_agreements_counterparty ON swap_agreements (counterparty);
CREATE INDEX swap_agreements_disputed ON swap_agreements (disputed_at)
    WHERE state = 'disputed';

CREATE TABLE swap_bonds (
    swap_bond_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agreement_id uuid NOT NULL REFERENCES swap_agreements (agreement_id),
    party        uuid NOT NULL REFERENCES users (user_id),
    hold_id      uuid NOT NULL REFERENCES wallet_holds (hold_id),
    amount_minor bigint NOT NULL DEFAULT 100000 CHECK (amount_minor = 100000),
    state        text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'released', 'forfeited')),
    placed_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz
);
CREATE UNIQUE INDEX swap_bonds_one_active
    ON swap_bonds (agreement_id, party)
    WHERE state = 'active';

CREATE TABLE swap_events (
    seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    listing_id   uuid REFERENCES swap_listings (swap_listing_id),
    agreement_id uuid REFERENCES swap_agreements (agreement_id),
    actor        uuid,
    from_state   text,
    to_state     text NOT NULL,
    at           timestamptz NOT NULL DEFAULT now(),
    CHECK (listing_id IS NOT NULL OR agreement_id IS NOT NULL)
);
CREATE INDEX swap_events_listing ON swap_events (listing_id);
CREATE INDEX swap_events_agreement ON swap_events (agreement_id);

-- ------------------------------------------------------------- guards ------

CREATE OR REPLACE FUNCTION swap_listings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'swap_listings is append-only (AMD-SWP-01)';
    END IF;
    IF NEW.owner <> OLD.owner OR NEW.have_category <> OLD.have_category
       OR NEW.want_categories <> OLD.want_categories
       OR NEW.value_estimate_minor <> OLD.value_estimate_minor
       OR NEW.currency <> OLD.currency OR NEW.market <> OLD.market
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'swap listing terms are immutable (AMD-SWP-01)';
    END IF;
    IF NOT ((OLD.state = 'listed' AND NEW.state IN ('held', 'removed'))
         OR (OLD.state = 'held'   AND NEW.state IN ('listed', 'swapped'))) THEN
        RAISE EXCEPTION 'illegal swap listing transition % -> % (AMD-SWP-01)',
            OLD.state, NEW.state;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER swap_listings_guard
    BEFORE UPDATE OR DELETE ON swap_listings
    FOR EACH ROW EXECUTE FUNCTION swap_listings_guard();

CREATE OR REPLACE FUNCTION swap_agreements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'swap_agreements is append-only (AMD-SWP-03)';
    END IF;
    IF NEW.proposer_listing <> OLD.proposer_listing
       OR NEW.counterparty_listing <> OLD.counterparty_listing
       OR NEW.proposer <> OLD.proposer OR NEW.counterparty <> OLD.counterparty
       OR NEW.balance_minor <> OLD.balance_minor
       OR NEW.balance_hold_id IS DISTINCT FROM OLD.balance_hold_id
       OR NEW.requires_bond <> OLD.requires_bond
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'swap agreement terms are immutable (AMD-SWP-03)';
    END IF;
    -- Confirmations are set-once facts.
    IF (NEW.proposer_confirmed_at IS DISTINCT FROM OLD.proposer_confirmed_at
        AND OLD.proposer_confirmed_at IS NOT NULL)
       OR (NEW.counterparty_confirmed_at IS DISTINCT FROM OLD.counterparty_confirmed_at
           AND OLD.counterparty_confirmed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'swap confirmations are set-once (AMD-SWP-03)';
    END IF;
    -- A same-state update may only set the confirmation stamps; every
    -- timestamp of a lifecycle fact moves only with its transition.
    IF NEW.state = OLD.state THEN
        IF NEW.decided_at IS DISTINCT FROM OLD.decided_at
           OR NEW.disputed_at IS DISTINCT FROM OLD.disputed_at
           OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
            RAISE EXCEPTION 'illegal swap agreement update (AMD-SWP-03)';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT ((OLD.state = 'proposed' AND NEW.state IN ('accepted', 'cancelled'))
         OR (OLD.state = 'accepted' AND NEW.state IN ('completed', 'disputed'))
         OR (OLD.state = 'disputed' AND NEW.state IN ('completed', 'cancelled'))) THEN
        RAISE EXCEPTION 'illegal swap agreement transition % -> % (AMD-SWP-03)',
            OLD.state, NEW.state;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER swap_agreements_guard
    BEFORE UPDATE OR DELETE ON swap_agreements
    FOR EACH ROW EXECUTE FUNCTION swap_agreements_guard();

CREATE OR REPLACE FUNCTION swap_bonds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'swap_bonds is append-only (AMD-SWP-04)';
    END IF;
    IF NEW.agreement_id <> OLD.agreement_id OR NEW.party <> OLD.party
       OR NEW.hold_id <> OLD.hold_id OR NEW.amount_minor <> OLD.amount_minor
       OR NEW.placed_at <> OLD.placed_at THEN
        RAISE EXCEPTION 'swap bond terms are immutable (AMD-SWP-04)';
    END IF;
    IF NOT (OLD.state = 'active' AND NEW.state IN ('released', 'forfeited')) THEN
        RAISE EXCEPTION 'illegal swap bond transition % -> % (AMD-SWP-04)',
            OLD.state, NEW.state;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER swap_bonds_guard
    BEFORE UPDATE OR DELETE ON swap_bonds
    FOR EACH ROW EXECUTE FUNCTION swap_bonds_guard();

CREATE OR REPLACE FUNCTION swap_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'swap_events is append-only (AMD-SWP-05)';
END $$;
CREATE TRIGGER swap_events_guard
    BEFORE UPDATE OR DELETE ON swap_events
    FOR EACH ROW EXECUTE FUNCTION swap_events_guard();

-- ----------------------------------------------------------------- RLS ----

ALTER TABLE swap_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE swap_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE swap_bonds ENABLE ROW LEVEL SECURITY;
ALTER TABLE swap_events ENABLE ROW LEVEL SECURITY;

-- Browse reads: the owner, a moderator, or a KYC-verified caller reading a
-- live (listed | held) listing. No path reads a removed or swapped listing
-- but its owner and moderation.
CREATE POLICY swap_listings_read ON swap_listings
    FOR SELECT USING (
        owner = app_user()
        OR app_moderator()
        OR (state IN ('listed', 'held') AND EXISTS (
               SELECT 1 FROM users u
                WHERE u.user_id = app_user() AND u.kyc_state = 'verified')));

CREATE POLICY swap_agreements_party_read ON swap_agreements
    FOR SELECT USING (app_user() IN (proposer, counterparty) OR app_moderator());

CREATE POLICY swap_bonds_party_read ON swap_bonds
    FOR SELECT USING (
        app_moderator()
        OR EXISTS (SELECT 1 FROM swap_agreements a
                    WHERE a.agreement_id = swap_bonds.agreement_id
                      AND app_user() IN (a.proposer, a.counterparty)));

CREATE POLICY swap_events_party_read ON swap_events
    FOR SELECT USING (
        app_moderator()
        OR EXISTS (SELECT 1 FROM swap_listings l
                    WHERE l.swap_listing_id = swap_events.listing_id
                      AND l.owner = app_user())
        OR EXISTS (SELECT 1 FROM swap_agreements a
                    WHERE a.agreement_id = swap_events.agreement_id
                      AND app_user() IN (a.proposer, a.counterparty)));

-- ------------------------------------------------------- AMD-SWP-02 --------

-- Category coverage rides the materialized TR-18 closure: a want covers
-- its own node and every descendant (no self-hop in the closure, hence
-- the equality arm). Four levels deep at most, by construction.
CREATE OR REPLACE FUNCTION swap_category_covers(p_want text, p_have text)
RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT p_want = p_have
        OR EXISTS (SELECT 1 FROM taxonomy_closure tc
                    WHERE tc.node_id = p_have AND tc.ancestor_id = p_want)
$$;

-- Two listed swaps are compatible when each side's want set covers the
-- other's have, the owners differ, and the market matches.
CREATE OR REPLACE FUNCTION swap_compatible(p_a uuid, p_b uuid)
RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((
        SELECT a.state = 'listed' AND b.state = 'listed'
               AND a.owner <> b.owner AND a.market = b.market
               AND EXISTS (SELECT 1 FROM unnest(a.want_categories) w
                            WHERE swap_category_covers(w, b.have_category))
               AND EXISTS (SELECT 1 FROM unnest(b.want_categories) w
                            WHERE swap_category_covers(w, a.have_category))
          FROM swap_listings a, swap_listings b
         WHERE a.swap_listing_id = p_a AND b.swap_listing_id = p_b), false)
$$;

-- The candidate surface: reciprocal compatibility, KYC-gated, block-aware
-- in both directions, and callable only by a caller who themselves holds a
-- listed swap — a browser must have skin in the swap. The projection
-- carries no owner (FR-30): the caller learns the counterparty through
-- their own agreement row, exactly like an AMD-PAY transfer.
CREATE OR REPLACE FUNCTION swap_candidates()
RETURNS TABLE(swap_listing_id uuid, have_category text, want_categories text[],
              value_estimate_minor bigint, market text, listed_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT c.swap_listing_id, c.have_category, c.want_categories,
           c.value_estimate_minor, c.market, c.created_at
      FROM swap_listings c
     WHERE c.state = 'listed'
       AND c.owner <> app_user()
       AND EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = app_user() AND u.kyc_state = 'verified')
       AND EXISTS (SELECT 1 FROM swap_listings mine
                    WHERE mine.owner = app_user()
                      AND mine.state = 'listed'
                      AND mine.market = c.market
                      AND EXISTS (SELECT 1 FROM unnest(mine.want_categories) w
                                   WHERE swap_category_covers(w, c.have_category))
                      AND EXISTS (SELECT 1 FROM unnest(c.want_categories) w
                                   WHERE swap_category_covers(w, mine.have_category)))
       AND NOT EXISTS (SELECT 1 FROM blocks b
                        WHERE (b.blocker = LEAST(app_user(), c.owner)
                               AND b.blocked = GREATEST(app_user(), c.owner))
                           OR (b.blocked = LEAST(app_user(), c.owner)
                               AND b.blocker = GREATEST(app_user(), c.owner)))
     ORDER BY c.created_at DESC
     LIMIT 50
$$;

-- ------------------------------------------------------- AMD-SWP-01/02 ----

-- Create a swap listing (created directly in the listed state — a swap
-- listing is an offer to exchange, live immediately). Gates: KYC-verified
-- owner; governed categories (have exists and is not sensitive — TR-22;
-- wants are 1..3 distinct existing non-sensitive nodes); configured
-- market; value estimate inside the AMD-PAY-05 ceiling; at most 12 live
-- (listed | held) swap listings per owner.
-- Outcomes: 'created' | 'forbidden' | 'kyc_required' | 'unknown_category'
-- | 'sensitive_category' | 'invalid_wants' | 'invalid_value'
-- | 'unknown_market' | 'too_many'.
CREATE OR REPLACE FUNCTION create_swap_listing(
    p_have_category text, p_want_categories text[],
    p_value_estimate_minor bigint, p_market text)
RETURNS TABLE(outcome text, swap_listing_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_id   uuid;
BEGIN
    IF v_user IS NULL THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = v_user AND u.kyc_state = 'verified') THEN
        RETURN QUERY SELECT 'kyc_required', NULL::uuid;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM taxonomy_nodes n
                    WHERE n.node_id = p_have_category) THEN
        RETURN QUERY SELECT 'unknown_category', NULL::uuid;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM taxonomy_nodes n
                WHERE n.node_id = p_have_category AND n.sensitive) THEN
        RETURN QUERY SELECT 'sensitive_category', NULL::uuid;
        RETURN;
    END IF;
    IF p_want_categories IS NULL
       OR array_length(p_want_categories, 1) IS NULL
       OR array_length(p_want_categories, 1) > 3
       OR (SELECT count(DISTINCT w) FROM unnest(p_want_categories) w)
          <> array_length(p_want_categories, 1)
       OR EXISTS (SELECT 1 FROM unnest(p_want_categories) w
                   WHERE NOT EXISTS (SELECT 1 FROM taxonomy_nodes n
                                      WHERE n.node_id = w AND NOT n.sensitive)) THEN
        RETURN QUERY SELECT 'invalid_wants', NULL::uuid;
        RETURN;
    END IF;
    IF p_value_estimate_minor IS NULL OR p_value_estimate_minor <= 0
       OR p_value_estimate_minor > 5000000 THEN
        RETURN QUERY SELECT 'invalid_value', NULL::uuid;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM market_config m
                    WHERE m.market_id = p_market AND m.active) THEN
        RETURN QUERY SELECT 'unknown_market', NULL::uuid;
        RETURN;
    END IF;
    IF (SELECT count(*) FROM swap_listings l
         WHERE l.owner = v_user AND l.state IN ('listed', 'held')) >= 12 THEN
        RETURN QUERY SELECT 'too_many', NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO swap_listings (owner, have_category, want_categories,
                               value_estimate_minor, market)
    VALUES (v_user, p_have_category, p_want_categories,
            p_value_estimate_minor, p_market)
    RETURNING swap_listings.swap_listing_id INTO v_id;
    INSERT INTO swap_events (listing_id, actor, from_state, to_state)
    VALUES (v_id, v_user, NULL, 'listed');
    RETURN QUERY SELECT 'created', v_id;
END $$;

-- Owner takedown of a listed swap. A held swap is refused — its agreement
-- resolves first, so a listing is never removed out from under a swap.
-- Outcomes: 'removed' | 'forbidden' | 'unknown_listing' | 'illegal_state'.
CREATE OR REPLACE FUNCTION delist_swap_listing(p_listing uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_listing swap_listings%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_listing FROM swap_listings l
     WHERE l.swap_listing_id = p_listing FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_listing';
    END IF;
    IF v_listing.owner <> v_user THEN
        RETURN 'forbidden';
    END IF;
    IF v_listing.state <> 'listed' THEN
        RETURN 'illegal_state';
    END IF;
    UPDATE swap_listings
       SET state = 'removed', closed_at = now()
     WHERE swap_listing_id = p_listing;
    INSERT INTO swap_events (listing_id, actor, from_state, to_state)
    VALUES (p_listing, v_user, 'listed', 'removed');
    RETURN 'removed';
END $$;

-- Internal unwind: void the balancer hold, release every active bond, and
-- relist both listings. Called by reject / cancel / expiry. Never granted
-- to the app role — the public definers compose it.
CREATE OR REPLACE FUNCTION swap_unwind(p_agreement uuid)
RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_agr  swap_agreements%ROWTYPE;
    v_bond swap_bonds%ROWTYPE;
BEGIN
    SELECT * INTO v_agr FROM swap_agreements a
     WHERE a.agreement_id = p_agreement FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    IF v_agr.balance_hold_id IS NOT NULL THEN
        PERFORM void_wallet_hold(v_agr.balance_hold_id);
    END IF;
    FOR v_bond IN
        SELECT * FROM swap_bonds b
         WHERE b.agreement_id = p_agreement AND b.state = 'active'
    LOOP
        PERFORM void_wallet_hold(v_bond.hold_id);
        UPDATE swap_bonds
           SET state = 'released', resolved_at = now()
         WHERE swap_bond_id = v_bond.swap_bond_id;
    END LOOP;
    UPDATE swap_listings
       SET state = 'listed'
     WHERE swap_listing_id IN (v_agr.proposer_listing,
                               v_agr.counterparty_listing)
       AND state = 'held';
END $$;

-- ------------------------------------------------------- AMD-SWP-03 --------

-- Propose a swap: the proposer's listed swap for the counterparty's, with
-- an optional cash balancer (proposer → counterparty) reserved as a wallet
-- hold AT PROPOSE TIME and an optional bond requirement. Both listings
-- move to held atomically with the agreement. A zero balancer places no
-- hold — a pure goods swap.
-- Outcomes: 'proposed' | 'forbidden' | 'kyc_required' | 'unknown_listing'
-- | 'self' | 'unavailable' | 'incompatible' | 'blocked'
-- | 'invalid_balance' | 'wallet_unavailable' | the place_wallet_hold
-- outcome verbatim when the hold fails (e.g. 'insufficient_funds').
CREATE OR REPLACE FUNCTION propose_swap(
    p_my_listing uuid, p_their_listing uuid,
    p_balance_minor bigint, p_requires_bond boolean)
RETURNS TABLE(outcome text, agreement_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_mine swap_listings%ROWTYPE;
    v_theirs swap_listings%ROWTYPE;
    v_wallet uuid;
    v_hold uuid;
    v_hold_outcome text;
    v_id uuid;
BEGIN
    IF v_user IS NULL THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'wallet_unavailable', NULL::uuid;
        RETURN;
    END IF;
    IF p_my_listing = p_their_listing THEN
        RETURN QUERY SELECT 'self', NULL::uuid;
        RETURN;
    END IF;
    -- Lock both listings in a fixed order — no deadlock between crossed
    -- proposals.
    SELECT * INTO v_mine FROM swap_listings l
     WHERE l.swap_listing_id = LEAST(p_my_listing, p_their_listing)
     FOR UPDATE;
    SELECT * INTO v_theirs FROM swap_listings l
     WHERE l.swap_listing_id = GREATEST(p_my_listing, p_their_listing)
     FOR UPDATE;
    IF v_mine.swap_listing_id IS NULL OR v_theirs.swap_listing_id IS NULL THEN
        RETURN QUERY SELECT 'unknown_listing', NULL::uuid;
        RETURN;
    END IF;
    IF v_mine.swap_listing_id <> p_my_listing THEN
        -- The LEAST/GREATEST walk renamed the pair; swap the records back.
        DECLARE
            v_tmp swap_listings%ROWTYPE;
        BEGIN
            v_tmp := v_mine; v_mine := v_theirs; v_theirs := v_tmp;
        END;
    END IF;
    IF v_mine.owner <> v_user THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF v_theirs.owner = v_user THEN
        RETURN QUERY SELECT 'self', NULL::uuid;
        RETURN;
    END IF;
    IF v_mine.state <> 'listed' OR v_theirs.state <> 'listed' THEN
        RETURN QUERY SELECT 'unavailable', NULL::uuid;
        RETURN;
    END IF;
    IF p_balance_minor IS NULL OR p_balance_minor < 0
       OR p_balance_minor > 5000000 THEN
        RETURN QUERY SELECT 'invalid_balance', NULL::uuid;
        RETURN;
    END IF;
    -- Both sides must still be KYC-verified — states can move after a
    -- listing was created.
    IF EXISTS (SELECT 1 FROM users u
                WHERE u.user_id IN (v_user, v_theirs.owner)
                  AND u.kyc_state <> 'verified') THEN
        RETURN QUERY SELECT 'kyc_required', NULL::uuid;
        RETURN;
    END IF;
    -- A block in either direction is an absolute refusal.
    IF EXISTS (SELECT 1 FROM blocks b
                WHERE (b.blocker = LEAST(v_user, v_theirs.owner)
                       AND b.blocked = GREATEST(v_user, v_theirs.owner))
                   OR (b.blocked = LEAST(v_user, v_theirs.owner)
                       AND b.blocker = GREATEST(v_user, v_theirs.owner))) THEN
        RETURN QUERY SELECT 'blocked', NULL::uuid;
        RETURN;
    END IF;
    IF NOT swap_compatible(p_my_listing, p_their_listing) THEN
        RETURN QUERY SELECT 'incompatible', NULL::uuid;
        RETURN;
    END IF;
    -- Reserve the balancer before the agreement row exists: the hold is the
    -- proof the proposer can pay. A place failure answers verbatim.
    IF p_balance_minor > 0 THEN
        SELECT w.wallet_id INTO v_wallet FROM wallets w
         WHERE w.owner = v_user AND w.currency = 'NGN' AND w.status = 'active';
        IF v_wallet IS NULL THEN
            RETURN QUERY SELECT 'wallet_unavailable', NULL::uuid;
            RETURN;
        END IF;
        SELECT h.outcome, h.hold_id INTO v_hold_outcome, v_hold
          FROM place_wallet_hold(v_wallet, p_balance_minor, NULL) h;
        IF v_hold_outcome <> 'placed' THEN
            RETURN QUERY SELECT v_hold_outcome, NULL::uuid;
            RETURN;
        END IF;
    END IF;
    BEGIN
        INSERT INTO swap_agreements (proposer_listing, counterparty_listing,
                                     proposer, counterparty, balance_minor,
                                     balance_hold_id, requires_bond)
        VALUES (p_my_listing, p_their_listing, v_user, v_theirs.owner,
                p_balance_minor, v_hold, COALESCE(p_requires_bond, false))
        RETURNING swap_agreements.agreement_id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        -- One-open-agreement-per-listing fired. The hold predates this
        -- subtransaction, so the rollback keeps it — void it explicitly.
        IF v_hold IS NOT NULL THEN
            PERFORM void_wallet_hold(v_hold);
        END IF;
        RETURN QUERY SELECT 'unavailable', NULL::uuid;
        RETURN;
    END;
    UPDATE swap_listings SET state = 'held'
     WHERE swap_listing_id IN (p_my_listing, p_their_listing);
    INSERT INTO swap_events (listing_id, actor, from_state, to_state)
    VALUES (p_my_listing, v_user, 'listed', 'held'),
           (p_their_listing, v_user, 'listed', 'held');
    INSERT INTO swap_events (agreement_id, actor, from_state, to_state)
    VALUES (v_id, v_user, NULL, 'proposed');
    RETURN QUERY SELECT 'proposed', v_id;
END $$;

-- Stake the pinned swap bond (AMD-SWP-04): 100000 minor from the caller's
-- own wallet as a hold, one active bond per party per agreement.
-- Outcomes: 'staked' | 'forbidden' | 'kyc_required' | 'unknown_agreement'
-- | 'illegal_state' | 'bond_not_required' | 'bond_active'
-- | 'wallet_unavailable' | the place_wallet_hold outcome verbatim.
CREATE OR REPLACE FUNCTION stake_swap_bond(p_agreement uuid)
RETURNS TABLE(outcome text, swap_bond_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_agr  swap_agreements%ROWTYPE;
    v_wallet uuid;
    v_hold uuid;
    v_hold_outcome text;
    v_id uuid;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    SELECT * INTO v_agr FROM swap_agreements a
     WHERE a.agreement_id = p_agreement FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_agreement', NULL::uuid;
        RETURN;
    END IF;
    IF v_user NOT IN (v_agr.proposer, v_agr.counterparty) THEN
        RETURN QUERY SELECT 'forbidden', NULL::uuid;
        RETURN;
    END IF;
    IF v_agr.state NOT IN ('proposed', 'accepted') THEN
        RETURN QUERY SELECT 'illegal_state', NULL::uuid;
        RETURN;
    END IF;
    IF NOT v_agr.requires_bond THEN
        RETURN QUERY SELECT 'bond_not_required', NULL::uuid;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = v_user AND u.kyc_state = 'verified') THEN
        RETURN QUERY SELECT 'kyc_required', NULL::uuid;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM swap_bonds b
                WHERE b.agreement_id = p_agreement AND b.party = v_user
                  AND b.state = 'active') THEN
        RETURN QUERY SELECT 'bond_active', NULL::uuid;
        RETURN;
    END IF;
    SELECT w.wallet_id INTO v_wallet FROM wallets w
     WHERE w.owner = v_user AND w.currency = 'NGN' AND w.status = 'active';
    IF v_wallet IS NULL THEN
        RETURN QUERY SELECT 'wallet_unavailable', NULL::uuid;
        RETURN;
    END IF;
    SELECT h.outcome, h.hold_id INTO v_hold_outcome, v_hold
      FROM place_wallet_hold(v_wallet, 100000, NULL) h;
    IF v_hold_outcome <> 'placed' THEN
        RETURN QUERY SELECT v_hold_outcome, NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO swap_bonds (agreement_id, party, hold_id)
    VALUES (p_agreement, v_user, v_hold)
    RETURNING swap_bonds.swap_bond_id INTO v_id;
    INSERT INTO swap_events (agreement_id, actor, from_state, to_state)
    VALUES (p_agreement, v_user, NULL, 'bond_staked');
    RETURN QUERY SELECT 'staked', v_id;
END $$;

-- The counterparty answers a proposal. Acceptance re-proves BOTH sides'
-- KYC (states can move after the write — the AMD-DATE-05 re-proof shape)
-- and, when the bond is required, refuses until both parties hold an
-- active bond. Rejection unwinds everything: the balancer hold voids, the
-- bonds release, the listings relist.
-- Outcomes: 'accepted' | 'cancelled' | 'bond_required' | 'forbidden'
-- | 'kyc_required' | 'unknown_agreement' | 'illegal_state'.
CREATE OR REPLACE FUNCTION respond_swap(p_agreement uuid, p_accept boolean)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_agr  swap_agreements%ROWTYPE;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_agr FROM swap_agreements a
     WHERE a.agreement_id = p_agreement FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_agreement';
    END IF;
    IF v_user <> v_agr.counterparty THEN
        RETURN 'forbidden';
    END IF;
    IF v_agr.state <> 'proposed' THEN
        RETURN 'illegal_state';
    END IF;
    IF p_accept IS NULL THEN
        RETURN 'forbidden';
    END IF;
    IF NOT p_accept THEN
        PERFORM swap_unwind(p_agreement);
        UPDATE swap_agreements
           SET state = 'cancelled', decided_at = now()
         WHERE agreement_id = p_agreement;
        INSERT INTO swap_events (agreement_id, actor, from_state, to_state)
        VALUES (p_agreement, v_user, 'proposed', 'cancelled');
        RETURN 'cancelled';
    END IF;
    IF EXISTS (SELECT 1 FROM users u
                WHERE u.user_id IN (v_agr.proposer, v_agr.counterparty)
                  AND u.kyc_state <> 'verified') THEN
        RETURN 'kyc_required';
    END IF;
    IF v_agr.requires_bond
       AND (SELECT count(*) FROM swap_bonds b
             WHERE b.agreement_id = p_agreement AND b.state = 'active') < 2 THEN
        RETURN 'bond_required';
    END IF;
    UPDATE swap_agreements
       SET state = 'accepted', decided_at = now()
     WHERE agreement_id = p_agreement;
    INSERT INTO swap_events (agreement_id, actor, from_state, to_state)
    VALUES (p_agreement, v_user, 'proposed', 'accepted');
    RETURN 'accepted';
END $$;

-- The proposer withdraws an unanswered proposal; everything unwinds.
-- Outcomes: 'cancelled' | 'forbidden' | 'unknown_agreement' | 'illegal_state'.
CREATE OR REPLACE FUNCTION cancel_swap(p_agreement uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_agr  swap_agreements%ROWTYPE;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_agr FROM swap_agreements a
     WHERE a.agreement_id = p_agreement FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_agreement';
    END IF;
    IF v_user <> v_agr.proposer THEN
        RETURN 'forbidden';
    END IF;
    IF v_agr.state <> 'proposed' THEN
        RETURN 'illegal_state';
    END IF;
    PERFORM swap_unwind(p_agreement);
    UPDATE swap_agreements
       SET state = 'cancelled', decided_at = now()
     WHERE agreement_id = p_agreement;
    INSERT INTO swap_events (agreement_id, actor, from_state, to_state)
    VALUES (p_agreement, v_user, 'proposed', 'cancelled');
    RETURN 'cancelled';
END $$;

-- Internal settlement primitive: post a pending hold as a transfer_out
-- from the source owner's wallet and a transfer_in to the destination
-- owner's wallet, with running balances — the forfeit/balance-settlement
-- primitive. transfer_out from the source, transfer_in to the destination,
-- no fee (AMD-SWP-04: barter legs carry no surcharge in v1). Never granted
-- to the app role.
CREATE OR REPLACE FUNCTION swap_post_hold(p_hold uuid, p_from uuid, p_to uuid)
RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_hold wallet_holds%ROWTYPE;
    v_from_wallet uuid;
    v_to_wallet   uuid;
    v_balance bigint;
BEGIN
    SELECT * INTO v_hold FROM wallet_holds h
     WHERE h.hold_id = p_hold AND h.state = 'pending' FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'swap hold is not pending (AMD-SWP-03)';
    END IF;
    SELECT w.wallet_id INTO v_from_wallet FROM wallets w
     WHERE w.owner = p_from AND w.currency = 'NGN' AND w.status = 'active';
    SELECT w.wallet_id INTO v_to_wallet FROM wallets w
     WHERE w.owner = p_to AND w.currency = 'NGN' AND w.status = 'active';
    IF v_from_wallet IS NULL OR v_to_wallet IS NULL THEN
        RAISE EXCEPTION 'swap settlement wallet missing (AMD-SWP-03)';
    END IF;
    UPDATE wallet_holds
       SET state = 'posted', resolved_at = now()
     WHERE hold_id = p_hold;
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_balance
      FROM wallet_entries e WHERE e.wallet_id = v_from_wallet;
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)
    VALUES (v_from_wallet, 'transfer_out', v_hold.amount_minor,
            v_balance - v_hold.amount_minor);
    SELECT COALESCE(sum(CASE WHEN e.kind IN ('fund', 'transfer_in', 'fee_revenue')
                             THEN e.amount_minor ELSE -e.amount_minor END), 0)
      INTO v_balance
      FROM wallet_entries e WHERE e.wallet_id = v_to_wallet;
    INSERT INTO wallet_entries (wallet_id, kind, amount_minor, balance_after)
    VALUES (v_to_wallet, 'transfer_in', v_hold.amount_minor,
            v_balance + v_hold.amount_minor);
END $$;

-- Either party confirms the exchange exactly once (set-once). The second
-- confirmation settles atomically: the balancer posts to the counterparty,
-- the bonds release, the agreement completes, both listings move to
-- swapped.
-- Outcomes: 'confirmed' | 'completed' | 'forbidden' | 'unknown_agreement'
-- | 'illegal_state'.
CREATE OR REPLACE FUNCTION confirm_swap_exchange(p_agreement uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_agr  swap_agreements%ROWTYPE;
    v_bond swap_bonds%ROWTYPE;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_agr FROM swap_agreements a
     WHERE a.agreement_id = p_agreement FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_agreement';
    END IF;
    IF v_user NOT IN (v_agr.proposer, v_agr.counterparty) THEN
        RETURN 'forbidden';
    END IF;
    IF v_agr.state <> 'accepted' THEN
        RETURN 'illegal_state';
    END IF;
    IF v_user = v_agr.proposer THEN
        IF v_agr.proposer_confirmed_at IS NOT NULL THEN
            RETURN 'illegal_state';
        END IF;
        UPDATE swap_agreements SET proposer_confirmed_at = now()
         WHERE agreement_id = p_agreement;
    ELSE
        IF v_agr.counterparty_confirmed_at IS NOT NULL THEN
            RETURN 'illegal_state';
        END IF;
        UPDATE swap_agreements SET counterparty_confirmed_at = now()
         WHERE agreement_id = p_agreement;
    END IF;
    IF (v_user = v_agr.proposer AND v_agr.counterparty_confirmed_at IS NULL)
       OR (v_user = v_agr.counterparty AND v_agr.proposer_confirmed_at IS NULL) THEN
        RETURN 'confirmed';
    END IF;
    -- Both confirmations in: settle.
    IF v_agr.balance_hold_id IS NOT NULL THEN
        PERFORM swap_post_hold(v_agr.balance_hold_id,
                               v_agr.proposer, v_agr.counterparty);
    END IF;
    FOR v_bond IN
        SELECT * FROM swap_bonds b
         WHERE b.agreement_id = p_agreement AND b.state = 'active'
    LOOP
        PERFORM void_wallet_hold(v_bond.hold_id);
        UPDATE swap_bonds
           SET state = 'released', resolved_at = now()
         WHERE swap_bond_id = v_bond.swap_bond_id;
    END LOOP;
    UPDATE swap_agreements
       SET state = 'completed', completed_at = now()
     WHERE agreement_id = p_agreement;
    UPDATE swap_listings
       SET state = 'swapped', closed_at = now()
     WHERE swap_listing_id IN (v_agr.proposer_listing,
                               v_agr.counterparty_listing);
    INSERT INTO swap_events (listing_id, actor, from_state, to_state)
    VALUES (v_agr.proposer_listing, v_user, 'held', 'swapped'),
           (v_agr.counterparty_listing, v_user, 'held', 'swapped');
    INSERT INTO swap_events (agreement_id, actor, from_state, to_state)
    VALUES (p_agreement, v_user, 'accepted', 'completed');
    RETURN 'completed';
END $$;

-- Either party disputes an accepted agreement; the balancer and the bonds
-- stay frozen until moderation resolves. No value moves here, so no
-- settlement gate — a dispute must always be available (safety surfaces
-- never depend on the rail).
-- Outcomes: 'disputed' | 'forbidden' | 'unknown_agreement' | 'illegal_state'.
CREATE OR REPLACE FUNCTION dispute_swap(p_agreement uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_agr  swap_agreements%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_agr FROM swap_agreements a
     WHERE a.agreement_id = p_agreement FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_agreement';
    END IF;
    IF v_user NOT IN (v_agr.proposer, v_agr.counterparty) THEN
        RETURN 'forbidden';
    END IF;
    IF v_agr.state <> 'accepted' THEN
        RETURN 'illegal_state';
    END IF;
    UPDATE swap_agreements
       SET state = 'disputed', disputed_at = now()
     WHERE agreement_id = p_agreement;
    INSERT INTO swap_events (agreement_id, actor, from_state, to_state)
    VALUES (p_agreement, v_user, 'accepted', 'disputed');
    RETURN 'disputed';
END $$;

-- Moderation alone resolves a disputed swap. 'release' posts the balancer
-- to the counterparty, completes the agreement and moves both listings to
-- swapped; 'refund' voids the balancer, cancels the agreement and relists
-- both listings. p_forfeit_bond optionally names one active bond on the
-- agreement to forfeit — the value moves to the OTHER party (AMD-SWP-04:
-- the wronged party, not platform revenue). v1 charges no cash fee on the
-- swap leg. Remaining bonds release. Audited.
-- Outcomes: 'resolved' | 'forbidden' | 'invalid_decision'
-- | 'unknown_agreement' | 'unknown_bond'.
CREATE OR REPLACE FUNCTION resolve_swap(
    p_agreement uuid, p_decision text, p_forfeit_bond uuid DEFAULT NULL)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_agr  swap_agreements%ROWTYPE;
    v_bond swap_bonds%ROWTYPE;
    v_innocent uuid;
BEGIN
    IF v_user IS NULL OR NOT app_moderator()
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF p_decision NOT IN ('refund', 'release') THEN
        RETURN 'invalid_decision';
    END IF;
    SELECT * INTO v_agr FROM swap_agreements a
     WHERE a.agreement_id = p_agreement AND a.state = 'disputed' FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_agreement';
    END IF;
    IF p_forfeit_bond IS NOT NULL THEN
        SELECT * INTO v_bond FROM swap_bonds b
         WHERE b.swap_bond_id = p_forfeit_bond
           AND b.agreement_id = p_agreement AND b.state = 'active'
         FOR UPDATE;
        IF NOT FOUND THEN
            RETURN 'unknown_bond';
        END IF;
        v_innocent := CASE WHEN v_bond.party = v_agr.proposer
                           THEN v_agr.counterparty ELSE v_agr.proposer END;
        PERFORM swap_post_hold(v_bond.hold_id, v_bond.party, v_innocent);
        UPDATE swap_bonds
           SET state = 'forfeited', resolved_at = now()
         WHERE swap_bond_id = p_forfeit_bond;
    END IF;
    IF p_decision = 'release' THEN
        IF v_agr.balance_hold_id IS NOT NULL THEN
            PERFORM swap_post_hold(v_agr.balance_hold_id,
                                   v_agr.proposer, v_agr.counterparty);
        END IF;
        UPDATE swap_agreements
           SET state = 'completed', completed_at = now()
         WHERE agreement_id = p_agreement;
        UPDATE swap_listings
           SET state = 'swapped', closed_at = now()
         WHERE swap_listing_id IN (v_agr.proposer_listing,
                                   v_agr.counterparty_listing);
        INSERT INTO swap_events (listing_id, actor, from_state, to_state)
        VALUES (v_agr.proposer_listing, v_user, 'held', 'swapped'),
               (v_agr.counterparty_listing, v_user, 'held', 'swapped');
    ELSE
        IF v_agr.balance_hold_id IS NOT NULL THEN
            PERFORM void_wallet_hold(v_agr.balance_hold_id);
        END IF;
        UPDATE swap_agreements
           SET state = 'cancelled', decided_at = now()
         WHERE agreement_id = p_agreement;
        UPDATE swap_listings
           SET state = 'listed'
         WHERE swap_listing_id IN (v_agr.proposer_listing,
                                   v_agr.counterparty_listing)
           AND state = 'held';
        INSERT INTO swap_events (listing_id, actor, from_state, to_state)
        VALUES (v_agr.proposer_listing, v_user, 'held', 'listed'),
               (v_agr.counterparty_listing, v_user, 'held', 'listed');
    END IF;
    -- Remaining active bonds release on either decision.
    FOR v_bond IN
        SELECT * FROM swap_bonds b
         WHERE b.agreement_id = p_agreement AND b.state = 'active'
    LOOP
        PERFORM void_wallet_hold(v_bond.hold_id);
        UPDATE swap_bonds
           SET state = 'released', resolved_at = now()
         WHERE swap_bond_id = v_bond.swap_bond_id;
    END LOOP;
    INSERT INTO swap_events (agreement_id, actor, from_state, to_state)
    VALUES (p_agreement, v_user, 'disputed',
            CASE WHEN p_decision = 'release' THEN 'completed' ELSE 'cancelled' END);
    PERFORM admin_audit_log(
        NULL,
        'swap.agreement.resolved',
        p_decision,
        'swap_agreement', p_agreement::text,
        jsonb_build_object('state', 'disputed',
                           'balanceMinor', v_agr.balance_minor),
        jsonb_build_object('decision', p_decision, 'actor', v_user,
                           'forfeitedBond', p_forfeit_bond)
    );
    RETURN 'resolved';
END $$;

-- The expiry clocks (AMD-SWP-03): unanswered proposals cancel and unwind at
-- 72 h; accepted agreements without a completed exchange escalate to
-- disputed at 168 h so a stalled exchange is seen, never silently stuck
-- (the AMD-ESC-02 visibility discipline). Value moves on the unwind path,
-- so the expirer refuses to run with the settlement rail off. Returns the
-- number of agreements moved.
CREATE OR REPLACE FUNCTION expire_stale_swaps()
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    r record;
    n integer := 0;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'settlement gate required (AMD-SWP-03)';
    END IF;
    FOR r IN
        SELECT agreement_id FROM swap_agreements
         WHERE state = 'proposed'
           AND created_at < now() - interval '72 hours'
    LOOP
        UPDATE swap_agreements
           SET state = 'cancelled', decided_at = now()
         WHERE agreement_id = r.agreement_id;
        PERFORM swap_unwind(r.agreement_id);
        INSERT INTO swap_events (agreement_id, actor, from_state, to_state)
        VALUES (r.agreement_id, NULL, 'proposed', 'cancelled');
        n := n + 1;
    END LOOP;
    FOR r IN
        SELECT agreement_id FROM swap_agreements
         WHERE state = 'accepted'
           AND decided_at < now() - interval '168 hours'
    LOOP
        UPDATE swap_agreements
           SET state = 'disputed', disputed_at = now()
         WHERE agreement_id = r.agreement_id;
        INSERT INTO swap_events (agreement_id, actor, from_state, to_state)
        VALUES (r.agreement_id, NULL, 'accepted', 'disputed');
        n := n + 1;
    END LOOP;
    RETURN n;
END $$;

-- ------------------------------------------------------------ DSAR ---------
-- AMD-SWP-05: the swap surface joins the export. Listing and agreement
-- rows are financial records — they survive account deletion tied to the
-- tombstone, exactly like transfers and orders (AMD-PAY-09/14).
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
                           WHERE uid IN (a.proposer, a.counterparty)), '[]'::jsonb))
    )
$$;

-- Redefined: keep the existing grant discipline.
REVOKE ALL ON FUNCTION dsar_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dsar_export(uuid) TO presence_app;

-- -------------------------------------------------- reconciliation ---------
-- AMD-SWP-05: the swap dispute queue joins reconciliation — open count,
-- oldest age and stuck accepted agreements — the AMD-ESC-02 liveness
-- discipline applied to barter value.
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
                            AND a.created_at < now() - interval '30 days'),
        'openSwapDisputes', (SELECT count(*) FROM swap_agreements a
                              WHERE a.state = 'disputed'),
        'oldestSwapDisputeSeconds', COALESCE((SELECT EXTRACT(EPOCH FROM now() - min(a.disputed_at))::bigint
                                  FROM swap_agreements a
                                 WHERE a.state = 'disputed'), 0),
        'stuckSwaps', (SELECT count(*) FROM swap_agreements a
                        WHERE a.state = 'accepted'
                          AND a.decided_at < now() - interval '7 days')
    );
END $$;

-- ------------------------------------------------------------ grants -------
-- Reads are RLS-governed; every write flows through the definers above.
GRANT SELECT ON swap_listings, swap_agreements, swap_bonds, swap_events
    TO presence_app;
GRANT EXECUTE ON FUNCTION swap_category_covers(text, text) TO presence_app;
GRANT EXECUTE ON FUNCTION swap_compatible(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION swap_candidates() TO presence_app;
GRANT EXECUTE ON FUNCTION create_swap_listing(text, text[], bigint, text) TO presence_app;
GRANT EXECUTE ON FUNCTION delist_swap_listing(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION propose_swap(uuid, uuid, bigint, boolean) TO presence_app;
GRANT EXECUTE ON FUNCTION stake_swap_bond(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION respond_swap(uuid, boolean) TO presence_app;
GRANT EXECUTE ON FUNCTION cancel_swap(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION confirm_swap_exchange(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION dispute_swap(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION resolve_swap(uuid, text, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION expire_stale_swaps() TO presence_app;

-- Internal composition primitives are never callable by the app role.
REVOKE ALL ON FUNCTION swap_unwind(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION swap_post_hold(uuid, uuid, uuid) FROM PUBLIC;

COMMIT;
