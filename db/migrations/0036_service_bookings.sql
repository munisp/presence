-- 0036_service_bookings.sql — SRS Addendum 001, AMD-SVC-01..05 (batch 61)
--
-- The services vertical: bookable local services and errands on top of the
-- marketplace's service listings (AMD-MKT kind='service'). A booking
-- composes a milestone escrow exactly like a purchase, but the listing is
-- REPEATABLE — a booking never holds the listing, the provider serves many
-- customers from one offer.
--
-- AMD-SVC-01  the 'services' vertical joins the catalogue (KYC-gated,
--             default-on, sort 45 — commerce, between marketplace and
--             payments). service_bookings pins listing/customer/provider,
--             the agreed total (1..5,000,000 minor NGN, mirroring the
--             AMD-PAY-05 cap), the milestone count (1..12, AMD-INN-03) and
--             the backing escrow; terms immutable, transitions
--             DB-enforced. service_events is append-only.
-- AMD-SVC-02  the booking lifecycle runs through definers only:
--             book_service composes create_escrow (the customer's hold IS
--             the booking — value is committed up-front, the provider is
--             guaranteed), start_service marks work begun,
--             confirm_service_milestone releases one milestone at a time
--             (the last release completes the booking), dispute_service is
--             available from either party at any pre-terminal state with
--             NO settlement gate (safety surfaces never depend on the
--             rail).
-- AMD-SVC-03  moderated resolution delegates to resolve_escrow, so the
--             AMD-ESC-01 four-eyes gate above 1,000,000 minor applies to
--             service bookings unchanged; resolve_escrow is redefined here
--             to propagate resolution to service_bookings on EVERY path,
--             mirroring the marketplace block — the approved path can never
--             leave a booking dangling.
-- AMD-SVC-04  lifecycle clocks: an accepted booking whose provider never
--             starts auto-refunds at 168 h (the ghosting clock — the
--             customer is never left holding a dead commitment); an
--             in_progress booking with no completion for 30 days escalates
--             to disputed so a stalled engagement is seen, never silently
--             stuck (the AMD-ESC-02 visibility discipline). The expirer
--             moves value on the refund path, so it refuses to run with
--             the settlement rail off.
-- AMD-SVC-05  the services surface joins the DSAR export ('services' key,
--             bookings with role/counterparty — financial records that
--             survive account deletion tied to the tombstone, AMD-PAY-09/14
--             discipline) and wallet_reconciliation gains
--             openServiceDisputes, oldestServiceDisputeSeconds and
--             stuckServices.
--
-- v1 scope note: there is deliberately no customer cancel and no provider
-- decline definer. A booking the provider does not want is answered by
-- inaction — the 168 h clock refunds the customer automatically — or by
-- an immediate dispute, which moderation resolves. Fewer surfaces, no
-- ambiguous states.

BEGIN;

-- ------------------------------------------------------------ AMD-SVC-01 --

INSERT INTO vertical_catalogue
    (vertical, label, summary, locked, requires_kyc, requires_adult,
     default_enabled, sort_order)
VALUES
    ('services', 'Services',
     'Local services and errands: book a vetted provider with milestone '
     || 'escrow — value is committed up-front and released as work '
     || 'completes.',
     false, true, false, true, 45);

CREATE TABLE service_bookings (
    booking_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id   uuid NOT NULL REFERENCES marketplace_listings (listing_id),
    customer     uuid NOT NULL REFERENCES users (user_id),
    provider     uuid NOT NULL REFERENCES users (user_id),
    agreed_minor bigint NOT NULL
                 CHECK (agreed_minor > 0 AND agreed_minor <= 5000000),
    currency     text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
    milestones   smallint NOT NULL CHECK (milestones BETWEEN 1 AND 12),
    escrow_id    uuid NOT NULL UNIQUE REFERENCES escrow_agreements (escrow_id),
    state        text NOT NULL DEFAULT 'accepted'
                 CHECK (state IN ('accepted', 'in_progress', 'completed',
                                  'cancelled', 'disputed')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz,
    completed_at timestamptz,
    cancelled_at timestamptz,
    disputed_at  timestamptz,
    CHECK (customer <> provider)
);
CREATE INDEX service_bookings_customer_idx ON service_bookings (customer);
CREATE INDEX service_bookings_provider_idx ON service_bookings (provider);
CREATE INDEX service_bookings_state_idx ON service_bookings (state)
    WHERE state IN ('accepted', 'in_progress', 'disputed');

CREATE TABLE service_events (
    event_id   bigserial PRIMARY KEY,
    booking_id uuid NOT NULL REFERENCES service_bookings (booking_id),
    actor      uuid,
    from_state text,
    to_state   text NOT NULL,
    at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_events_booking_idx ON service_events (booking_id, at);

-- ------------------------------------------------------------- guards ----

CREATE OR REPLACE FUNCTION service_bookings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'service_bookings is append-only (AMD-SVC-01)';
    END IF;
    IF NEW.listing_id <> OLD.listing_id OR NEW.customer <> OLD.customer
       OR NEW.provider <> OLD.provider OR NEW.agreed_minor <> OLD.agreed_minor
       OR NEW.currency <> OLD.currency OR NEW.milestones <> OLD.milestones
       OR NEW.escrow_id <> OLD.escrow_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'booking terms are immutable (AMD-SVC-01)';
    END IF;
    IF NEW.state = OLD.state THEN
        -- A same-state update may only be a no-op; every stamp moves with
        -- its transition.
        IF NEW.started_at IS DISTINCT FROM OLD.started_at
           OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
           OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
           OR NEW.disputed_at IS DISTINCT FROM OLD.disputed_at THEN
            RAISE EXCEPTION 'illegal service booking update (AMD-SVC-01)';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT ((OLD.state = 'accepted'
             AND NEW.state IN ('in_progress', 'cancelled', 'disputed'))
         OR (OLD.state = 'in_progress'
             AND NEW.state IN ('completed', 'disputed'))
         OR (OLD.state = 'disputed'
             AND NEW.state IN ('completed', 'cancelled'))) THEN
        RAISE EXCEPTION 'illegal service booking transition % -> % (AMD-SVC-01)',
            OLD.state, NEW.state;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER service_bookings_guard
    BEFORE UPDATE OR DELETE ON service_bookings
    FOR EACH ROW EXECUTE FUNCTION service_bookings_guard();

CREATE OR REPLACE FUNCTION service_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'service_events is append-only (AMD-SVC-05)';
END $$;
CREATE TRIGGER service_events_guard
    BEFORE UPDATE OR DELETE ON service_events
    FOR EACH ROW EXECUTE FUNCTION service_events_guard();

-- ----------------------------------------------------------------- RLS ----

ALTER TABLE service_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_events ENABLE ROW LEVEL SECURITY;

-- Parties read their own bookings; moderation reads all. No write
-- policies — every write flows through the definers.
CREATE POLICY service_bookings_party_read ON service_bookings
    FOR SELECT USING (app_user() IN (customer, provider) OR app_moderator());
CREATE POLICY service_events_party_read ON service_events
    FOR SELECT USING (app_moderator() OR EXISTS (
        SELECT 1 FROM service_bookings b
         WHERE b.booking_id = service_events.booking_id
           AND app_user() IN (b.customer, b.provider)));

-- ------------------------------------------------------------ AMD-SVC-02 --

-- Book a service listing: the customer's escrow hold IS the booking.
-- Composes create_escrow (AMD-INN-03) exactly like purchase_listing does,
-- except the listing stays listed — a service offer is repeatable.
-- Outcomes: 'booked' | 'forbidden' | 'kyc_required' | 'unknown_listing'
-- | 'not_a_service' | 'self' | 'unavailable' | 'invalid_amount'
-- | 'invalid_milestones' | 'blocked' | the create_escrow outcome verbatim.
CREATE OR REPLACE FUNCTION book_service(
    p_listing uuid, p_amount_minor bigint, p_milestones smallint)
RETURNS TABLE(outcome text, booking_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user     uuid := app_user();
    v_listing  marketplace_listings%ROWTYPE;
    v_amounts  bigint[] := ARRAY[]::bigint[];
    v_base     bigint;
    v_i        integer;
    v_escrow   uuid;
    v_escrow_outcome text;
    v_id       uuid;
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
    IF p_amount_minor IS NULL OR p_amount_minor <= 0
       OR p_amount_minor > 5000000 THEN
        RETURN QUERY SELECT 'invalid_amount', NULL::uuid;
        RETURN;
    END IF;
    IF p_milestones IS NULL OR p_milestones < 1 OR p_milestones > 12 THEN
        RETURN QUERY SELECT 'invalid_milestones', NULL::uuid;
        RETURN;
    END IF;
    SELECT * INTO v_listing FROM marketplace_listings l
     WHERE l.listing_id = p_listing FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_listing', NULL::uuid;
        RETURN;
    END IF;
    IF v_listing.kind <> 'service' THEN
        RETURN QUERY SELECT 'not_a_service', NULL::uuid;
        RETURN;
    END IF;
    IF v_listing.seller = v_user THEN
        RETURN QUERY SELECT 'self', NULL::uuid;
        RETURN;
    END IF;
    IF v_listing.state <> 'listed' THEN
        RETURN QUERY SELECT 'unavailable', NULL::uuid;
        RETURN;
    END IF;
    -- The provider must still be KYC-verified — states can move after a
    -- listing was created (the AMD-DATE-05 re-proof shape).
    IF NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.user_id = v_listing.seller
                      AND u.kyc_state = 'verified') THEN
        RETURN QUERY SELECT 'kyc_required', NULL::uuid;
        RETURN;
    END IF;
    -- A block in either direction is an absolute refusal.
    IF EXISTS (SELECT 1 FROM blocks b
                WHERE (b.blocker = LEAST(v_user, v_listing.seller)
                       AND b.blocked = GREATEST(v_user, v_listing.seller))
                   OR (b.blocked = LEAST(v_user, v_listing.seller)
                       AND b.blocker = GREATEST(v_user, v_listing.seller))) THEN
        RETURN QUERY SELECT 'blocked', NULL::uuid;
        RETURN;
    END IF;
    -- Even split; the final milestone absorbs the remainder so the parts
    -- always sum to the agreed total.
    v_base := p_amount_minor / p_milestones;
    FOR v_i IN 1..p_milestones LOOP
        v_amounts := v_amounts
            || (v_base + CASE WHEN v_i = p_milestones
                              THEN p_amount_minor - v_base * p_milestones
                              ELSE 0 END);
    END LOOP;
    SELECT e.outcome, e.escrow_id INTO v_escrow_outcome, v_escrow
      FROM create_escrow(v_listing.seller, v_amounts) e;
    IF v_escrow_outcome <> 'created' THEN
        RETURN QUERY SELECT v_escrow_outcome, NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO service_bookings (listing_id, customer, provider,
                                  agreed_minor, milestones, escrow_id)
    VALUES (p_listing, v_user, v_listing.seller,
            p_amount_minor, p_milestones, v_escrow)
    RETURNING service_bookings.booking_id INTO v_id;
    INSERT INTO service_events (booking_id, actor, from_state, to_state)
    VALUES (v_id, v_user, NULL, 'accepted');
    RETURN QUERY SELECT 'booked', v_id;
END $$;

-- The provider marks work begun. No value moves, so no settlement gate —
-- a provider can always start (starting is what stops the 168 h ghosting
-- clock).
-- Outcomes: 'started' | 'forbidden' | 'unknown_booking' | 'illegal_state'.
CREATE OR REPLACE FUNCTION start_service(p_booking uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_bk   service_bookings%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_bk FROM service_bookings b
     WHERE b.booking_id = p_booking FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_booking';
    END IF;
    IF v_user <> v_bk.provider THEN
        RETURN 'forbidden';
    END IF;
    IF v_bk.state <> 'accepted' THEN
        RETURN 'illegal_state';
    END IF;
    UPDATE service_bookings
       SET state = 'in_progress', started_at = now()
     WHERE booking_id = p_booking;
    INSERT INTO service_events (booking_id, actor, from_state, to_state)
    VALUES (p_booking, v_user, 'accepted', 'in_progress');
    RETURN 'started';
END $$;

-- The customer releases one milestone as work completes. Delegates to
-- release_escrow_milestone (payer-only, settlement-gated there); the last
-- release completes the escrow and the booking together.
-- Outcomes: 'confirmed' | 'completed' | 'forbidden' | 'unknown_booking'
-- | 'illegal_state' | the release_escrow_milestone outcome verbatim.
CREATE OR REPLACE FUNCTION confirm_service_milestone(
    p_booking uuid, p_milestone smallint)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_bk   service_bookings%ROWTYPE;
    v_out  text;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_bk FROM service_bookings b
     WHERE b.booking_id = p_booking FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_booking';
    END IF;
    IF v_user <> v_bk.customer THEN
        RETURN 'forbidden';
    END IF;
    IF v_bk.state <> 'in_progress' THEN
        RETURN 'illegal_state';
    END IF;
    v_out := release_escrow_milestone(v_bk.escrow_id, p_milestone);
    IF v_out = 'released' THEN
        INSERT INTO service_events (booking_id, actor, from_state, to_state)
        VALUES (p_booking, v_user, 'in_progress', 'milestone_confirmed');
        RETURN 'confirmed';
    END IF;
    IF v_out = 'completed' THEN
        UPDATE service_bookings
           SET state = 'completed', completed_at = now()
         WHERE booking_id = p_booking;
        INSERT INTO service_events (booking_id, actor, from_state, to_state)
        VALUES (p_booking, v_user, 'in_progress', 'completed');
        RETURN 'completed';
    END IF;
    RETURN v_out;
END $$;

-- Either party disputes a live booking; the escrow freezes until
-- moderation resolves. No value moves here, so no settlement gate — a
-- dispute must always be available.
-- Outcomes: 'disputed' | 'forbidden' | 'unknown_booking' | 'illegal_state'.
CREATE OR REPLACE FUNCTION dispute_service(p_booking uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_bk   service_bookings%ROWTYPE;
    v_out  text;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_bk FROM service_bookings b
     WHERE b.booking_id = p_booking FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_booking';
    END IF;
    IF v_user NOT IN (v_bk.customer, v_bk.provider) THEN
        RETURN 'forbidden';
    END IF;
    IF v_bk.state NOT IN ('accepted', 'in_progress') THEN
        RETURN 'illegal_state';
    END IF;
    v_out := dispute_escrow(v_bk.escrow_id);
    IF v_out <> 'disputed' THEN
        RETURN v_out;
    END IF;
    UPDATE service_bookings
       SET state = 'disputed', disputed_at = now()
     WHERE booking_id = p_booking;
    INSERT INTO service_events (booking_id, actor, from_state, to_state)
    VALUES (p_booking, v_user, v_bk.state, 'disputed');
    RETURN 'disputed';
END $$;

-- ------------------------------------------------------------ AMD-SVC-03 --

-- Moderation resolves a disputed booking by delegating to resolve_escrow —
-- the four-eyes gate (AMD-ESC-01) applies unchanged above 1,000,000 minor
-- of remaining value, and 'approval_required' passes through verbatim. The
-- booking row itself is updated inside resolve_escrow's service
-- propagation block, so direct and approved paths resolve identically.
-- Outcomes: 'resolved' | 'approval_required' | 'forbidden'
-- | 'invalid_decision' | 'unknown_booking' | 'illegal_state'
-- | the resolve_escrow outcome verbatim.
CREATE OR REPLACE FUNCTION resolve_service(p_booking uuid, p_decision text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user uuid := app_user();
    v_bk   service_bookings%ROWTYPE;
    v_out  text;
BEGIN
    IF v_user IS NULL OR NOT app_moderator()
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    IF p_decision NOT IN ('refund', 'release') THEN
        RETURN 'invalid_decision';
    END IF;
    SELECT * INTO v_bk FROM service_bookings b
     WHERE b.booking_id = p_booking FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_booking';
    END IF;
    IF v_bk.state <> 'disputed' THEN
        RETURN 'illegal_state';
    END IF;
    v_out := resolve_escrow(v_bk.escrow_id, p_decision);
    RETURN v_out;
END $$;

-- Redefined from 0033 with one addition: the AMD-SVC-03 service
-- propagation block, so the four-eyes approval path resolves service
-- bookings identically to the direct path (the b58 marketplace lesson).
CREATE OR REPLACE FUNCTION resolve_escrow(p_escrow uuid, p_decision text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user   uuid := app_user();
    v_escrow escrow_agreements%ROWTYPE;
    v_ms     escrow_milestones%ROWTYPE;
    v_order  marketplace_orders%ROWTYPE;
    v_booking service_bookings%ROWTYPE;
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
    -- AMD-SVC-03: service composition. An escrow backing a service booking
    -- resolves the booking with it on EVERY path that reaches resolution —
    -- the direct moderator path and the four-eyes approval path both land
    -- here. A refund cancels the engagement, a release completes it; the
    -- listing stays listed either way (a service offer is repeatable).
    UPDATE service_bookings b
       SET state = CASE WHEN p_decision = 'refund' THEN 'cancelled'
                        ELSE 'completed' END,
           cancelled_at = CASE WHEN p_decision = 'refund' THEN now()
                               ELSE b.cancelled_at END,
           completed_at = CASE WHEN p_decision = 'release' THEN now()
                               ELSE b.completed_at END
     WHERE b.escrow_id = p_escrow AND b.state = 'disputed'
    RETURNING * INTO v_booking;
    IF FOUND THEN
        INSERT INTO service_events (booking_id, actor, from_state, to_state)
        VALUES (v_booking.booking_id, v_user, 'disputed',
                CASE WHEN p_decision = 'refund' THEN 'cancelled'
                     ELSE 'completed' END);
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


-- ------------------------------------------------------------ AMD-SVC-04 --

-- The lifecycle clocks: an accepted booking whose provider never started
-- auto-refunds at 168 h (escrow walks active -> disputed -> refunded inside
-- the one call — the guard's legal path); an in_progress booking with no
-- completion for 30 days escalates to disputed for visibility. Value moves
-- on the refund path, so the expirer refuses to run with the settlement
-- rail off. Returns the number of bookings moved.
CREATE OR REPLACE FUNCTION expire_stale_services()
RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    r record;
    n integer := 0;
BEGIN
    IF current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'settlement gate required (AMD-SVC-04)';
    END IF;
    FOR r IN
        SELECT b.booking_id, b.escrow_id FROM service_bookings b
         WHERE b.state = 'accepted'
           AND b.created_at < now() - interval '168 hours'
    LOOP
        -- The escrow never left 'active'; walk it through the guard's
        -- legal path to refund the untouched hold.
        UPDATE escrow_agreements
           SET state = 'disputed', disputed_at = now()
         WHERE escrow_id = r.escrow_id;
        PERFORM void_wallet_hold(
            (SELECT a.hold_id FROM escrow_agreements a
              WHERE a.escrow_id = r.escrow_id));
        UPDATE escrow_milestones
           SET state = 'refunded', resolved_at = now()
         WHERE escrow_id = r.escrow_id AND state = 'pending';
        UPDATE escrow_agreements
           SET state = 'refunded', resolved_at = now(), resolved_by = NULL
         WHERE escrow_id = r.escrow_id;
        UPDATE service_bookings
           SET state = 'cancelled', cancelled_at = now()
         WHERE booking_id = r.booking_id;
        INSERT INTO service_events (booking_id, actor, from_state, to_state)
        VALUES (r.booking_id, NULL, 'accepted', 'cancelled');
        n := n + 1;
    END LOOP;
    FOR r IN
        SELECT b.booking_id, b.escrow_id FROM service_bookings b
         WHERE b.state = 'in_progress'
           AND b.started_at < now() - interval '30 days'
    LOOP
        -- The escrow escalates with the booking: a disputed booking whose
        -- escrow stayed active could never be resolved (the resolver
        -- selects on state = 'disputed') — the funds would freeze forever.
        UPDATE escrow_agreements
           SET state = 'disputed', disputed_at = now()
         WHERE escrow_id = r.escrow_id AND state = 'active';
        UPDATE service_bookings
           SET state = 'disputed', disputed_at = now()
         WHERE booking_id = r.booking_id;
        INSERT INTO service_events (booking_id, actor, from_state, to_state)
        VALUES (r.booking_id, NULL, 'in_progress', 'disputed');
        n := n + 1;
    END LOOP;
    RETURN n;
END $$;

-- ------------------------------------------------------------ AMD-SVC-05 --
-- The services surface joins the export. Booking rows are financial
-- records — they survive account deletion tied to the tombstone, exactly
-- like transfers, orders and swaps (AMD-PAY-09/14).
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
                       WHERE uid IN (b.customer, b.provider)), '[]'::jsonb)
    )
$$;


-- AMD-SVC-05: the service dispute queue joins reconciliation — open count,
-- oldest age and the pre-start stall count beside the escrow and swap
-- queues (the AMD-ESC-02 visibility discipline).
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
        ,
        'openServiceDisputes', (SELECT count(*) FROM service_bookings b
                                 WHERE b.state = 'disputed'),
        'oldestServiceDisputeSeconds', COALESCE((SELECT EXTRACT(EPOCH FROM now() - min(b.disputed_at))::bigint
                                  FROM service_bookings b
                                 WHERE b.state = 'disputed'), 0),
        'stuckServices', (SELECT count(*) FROM service_bookings b
                           WHERE b.state = 'accepted'
                             AND b.created_at < now() - interval '7 days')
    );
END $$;

-- ------------------------------------------------------------ grants -------
-- Reads are RLS-governed; every write flows through the definers above.
GRANT SELECT ON service_bookings, service_events TO presence_app;
GRANT EXECUTE ON FUNCTION book_service(uuid, bigint, smallint) TO presence_app;
GRANT EXECUTE ON FUNCTION start_service(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION confirm_service_milestone(uuid, smallint) TO presence_app;
GRANT EXECUTE ON FUNCTION dispute_service(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION resolve_service(uuid, text) TO presence_app;
GRANT EXECUTE ON FUNCTION expire_stale_services() TO presence_app;

COMMIT;
