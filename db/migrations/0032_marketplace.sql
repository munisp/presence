-- presence — migration 0032: marketplace listing primitive (batch 57, SRS
-- Addendum 001 AMD-MKT-01..05).
--
-- AMD-MKT-01  listing object: a listing is a structured record and nothing
--             else — kind (item | service), a taxonomy category, a price in
--             minor units, the launch currency, a market — with a guarded
--             state machine (draft → listed → held → sold; draft/listed →
--             removed; held → listed on refund). Terms are immutable once
--             created: a price change is remove-and-recreate, so a listing
--             can never be repriced under a buyer mid-escrow. There is no
--             description, no photo, no free text — by construction
--             (FR-87/FR-96/SEC-37 unchanged).
-- AMD-MKT-02  append-only events: every listing and order transition lands
--             in marketplace_events, which raises on UPDATE or DELETE for
--             every application path — the FR-29/AMD-PAY-07 ledger
--             discipline applied to commerce.
-- AMD-MKT-03  purchase composition: buying a listing creates a single-
--             milestone AMD-INN-03 escrow (payee = seller, amount = price)
--             inside the same transaction and moves the listing to held.
--             The buyer confirms receipt (the escrow's milestone releases,
--             the listing sells); either party disputes; moderation alone
--             resolves — refund relists the listing, release completes the
--             sale. No new value machinery: every movement is the b56
--             escrow definers inside the AMD-PAY-15 settlement gate.
-- AMD-MKT-04  eligibility and caps: seller and buyer must be KYC-verified
--             (AMD-KYC-01); the category must be a non-sensitive taxonomy
--             node (TR-22); the market must be a configured market
--             (market_config); the price is capped at 5,000,000 minor units
--             (the AMD-PAY-05 per-transfer ceiling); at most 12 live
--             listings per seller — a storefront is bounded because an
--             unbounded catalogue is an aggregation surface.
-- AMD-MKT-05  moderation: a moderator removes a draft or listed listing
--             with a governed reason code, audited in the admin audit log.
--             A held listing is never removed out from under an escrow —
--             the dispute is resolved first, then the relisted listing can
--             be removed. FR-30 is unchanged: browse projects no seller
--             identity; the buyer learns the counterparty through their own
--             order row, exactly like an AMD-PAY transfer.
--
-- Every value-moving definer requires app.transfer_settlement='on',
-- exactly like AMD-PAY-15. Terms are immutable; guards are pinned.
--
-- Forward-only migration; run after 0031_dating.sql.

BEGIN;

-- ============================================================ AMD-MKT-01 ==

CREATE TABLE marketplace_listings (
    listing_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller     uuid NOT NULL REFERENCES users (user_id),
    kind       text NOT NULL CHECK (kind IN ('item', 'service')),
    category   text NOT NULL REFERENCES taxonomy_nodes (node_id),
    price_minor bigint NOT NULL
               CHECK (price_minor > 0 AND price_minor <= 5000000),
    currency   text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
    market     text NOT NULL REFERENCES market_config (market_id),
    state      text NOT NULL DEFAULT 'draft'
               CHECK (state IN ('draft', 'listed', 'held', 'sold', 'removed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    listed_at  timestamptz,
    closed_at  timestamptz
);
CREATE INDEX marketplace_listings_browse
    ON marketplace_listings (market, category, state)
    WHERE state IN ('listed', 'held');
CREATE INDEX marketplace_listings_seller ON marketplace_listings (seller);

CREATE TABLE marketplace_orders (
    order_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id uuid NOT NULL REFERENCES marketplace_listings (listing_id),
    buyer      uuid NOT NULL REFERENCES users (user_id),
    seller     uuid NOT NULL REFERENCES users (user_id),
    escrow_id  uuid NOT NULL REFERENCES escrow_agreements (escrow_id),
    state      text NOT NULL DEFAULT 'active'
               CHECK (state IN ('active', 'completed', 'refunded', 'disputed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CHECK (buyer <> seller)
);
CREATE UNIQUE INDEX marketplace_orders_escrow ON marketplace_orders (escrow_id);
-- One open order per listing: the listing's held state and the order's
-- active/disputed state are the same fact seen from two sides.
CREATE UNIQUE INDEX marketplace_orders_one_open
    ON marketplace_orders (listing_id) WHERE state IN ('active', 'disputed');
CREATE INDEX marketplace_orders_buyer ON marketplace_orders (buyer);

-- ============================================================ AMD-MKT-02 ==

CREATE TABLE marketplace_events (
    seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    listing_id uuid NOT NULL REFERENCES marketplace_listings (listing_id),
    order_id   uuid REFERENCES marketplace_orders (order_id),
    actor      uuid,                  -- NULL = system
    from_state text,                  -- NULL on the first row of a stream
    to_state   text NOT NULL,
    at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketplace_events_listing ON marketplace_events (listing_id);

-- ------------------------------------------------------------ guards ------

CREATE OR REPLACE FUNCTION marketplace_listings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'marketplace_listings is append-only (AMD-MKT-01)';
    END IF;
    IF NEW.seller <> OLD.seller OR NEW.kind <> OLD.kind
       OR NEW.category <> OLD.category OR NEW.price_minor <> OLD.price_minor
       OR NEW.currency <> OLD.currency OR NEW.market <> OLD.market
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'listing terms are immutable (AMD-MKT-01)';
    END IF;
    IF NOT ((OLD.state = 'draft'  AND NEW.state IN ('listed', 'removed'))
         OR (OLD.state = 'listed' AND NEW.state IN ('held', 'removed'))
         OR (OLD.state = 'held'   AND NEW.state IN ('sold', 'listed'))) THEN
        RAISE EXCEPTION 'illegal listing transition % -> % (AMD-MKT-01)',
            OLD.state, NEW.state;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER marketplace_listings_guard
    BEFORE UPDATE OR DELETE ON marketplace_listings
    FOR EACH ROW EXECUTE FUNCTION marketplace_listings_guard();

CREATE OR REPLACE FUNCTION marketplace_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'marketplace_orders is append-only (AMD-MKT-03)';
    END IF;
    IF NEW.listing_id <> OLD.listing_id OR NEW.buyer <> OLD.buyer
       OR NEW.seller <> OLD.seller OR NEW.escrow_id <> OLD.escrow_id
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'order terms are immutable (AMD-MKT-03)';
    END IF;
    -- The order state mirrors its escrow exactly (AMD-MKT-03).
    IF NOT ((OLD.state = 'active'   AND NEW.state IN ('completed', 'disputed'))
         OR (OLD.state = 'disputed' AND NEW.state IN ('completed', 'refunded'))) THEN
        RAISE EXCEPTION 'illegal order transition % -> % (AMD-MKT-03)',
            OLD.state, NEW.state;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER marketplace_orders_guard
    BEFORE UPDATE OR DELETE ON marketplace_orders
    FOR EACH ROW EXECUTE FUNCTION marketplace_orders_guard();

CREATE OR REPLACE FUNCTION marketplace_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'marketplace_events is append-only (AMD-MKT-02)';
END $$;
CREATE TRIGGER marketplace_events_guard
    BEFORE UPDATE OR DELETE ON marketplace_events
    FOR EACH ROW EXECUTE FUNCTION marketplace_events_guard();

-- ----------------------------------------------------------------- RLS ----

ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_events ENABLE ROW LEVEL SECURITY;

-- Browse: live listings are readable by any KYC-verified caller (the
-- route projects no seller identity); the seller reads their own in any
-- state; moderation reads everything.
CREATE POLICY marketplace_listings_read ON marketplace_listings
    FOR SELECT USING (
        seller = app_user()
        OR app_moderator()
        OR (state IN ('listed', 'held') AND EXISTS (
               SELECT 1 FROM users u
                WHERE u.user_id = app_user() AND u.kyc_state = 'verified')));

CREATE POLICY marketplace_orders_party_read ON marketplace_orders
    FOR SELECT USING (app_user() IN (buyer, seller) OR app_moderator());

CREATE POLICY marketplace_events_party_read ON marketplace_events
    FOR SELECT USING (
        app_moderator()
        OR EXISTS (SELECT 1 FROM marketplace_listings l
                    WHERE l.listing_id = marketplace_events.listing_id
                      AND l.seller = app_user())
        OR EXISTS (SELECT 1 FROM marketplace_orders o
                    WHERE o.listing_id = marketplace_events.listing_id
                      AND app_user() IN (o.buyer, o.seller)));

-- ------------------------------------------------------- AMD-MKT-01/04 ----

-- Create a draft listing. Gates: KYC-verified seller; governed category
-- (exists, not sensitive — TR-22); configured market; price inside the
-- AMD-PAY-05 ceiling; at most 12 live (draft | listed | held) listings
-- per seller.
-- Outcomes: 'created' | 'forbidden' | 'kyc_required' | 'invalid_kind'
-- | 'unknown_category' | 'sensitive_category' | 'invalid_price'
-- | 'unknown_market' | 'too_many'.
CREATE OR REPLACE FUNCTION create_listing(
    p_kind text, p_category text, p_price_minor bigint, p_market text)
RETURNS TABLE(outcome text, listing_id uuid)
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
    IF p_kind NOT IN ('item', 'service') THEN
        RETURN QUERY SELECT 'invalid_kind', NULL::uuid;
        RETURN;
    END IF;
    IF p_category IS NULL
       OR NOT EXISTS (SELECT 1 FROM taxonomy_nodes n
                       WHERE n.node_id = p_category) THEN
        RETURN QUERY SELECT 'unknown_category', NULL::uuid;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM taxonomy_nodes n
                WHERE n.node_id = p_category AND n.sensitive) THEN
        RETURN QUERY SELECT 'sensitive_category', NULL::uuid;
        RETURN;
    END IF;
    IF p_price_minor IS NULL OR p_price_minor <= 0 OR p_price_minor > 5000000 THEN
        RETURN QUERY SELECT 'invalid_price', NULL::uuid;
        RETURN;
    END IF;
    IF p_market IS NULL
       OR NOT EXISTS (SELECT 1 FROM market_config m WHERE m.market_id = p_market) THEN
        RETURN QUERY SELECT 'unknown_market', NULL::uuid;
        RETURN;
    END IF;
    IF (SELECT count(*) FROM marketplace_listings l
         WHERE l.seller = v_user AND l.state IN ('draft', 'listed', 'held')) >= 12 THEN
        RETURN QUERY SELECT 'too_many', NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO marketplace_listings (seller, kind, category, price_minor, market)
    VALUES (v_user, p_kind, p_category, p_price_minor, p_market)
    RETURNING marketplace_listings.listing_id INTO v_id;
    INSERT INTO marketplace_events (listing_id, actor, from_state, to_state)
    VALUES (v_id, v_user, NULL, 'draft');
    RETURN QUERY SELECT 'created', v_id;
END $$;

-- Publish a draft. Seller only; the guard pins draft -> listed.
-- Outcomes: 'listed' | 'forbidden' | 'unknown_listing' | 'illegal_state'.
CREATE OR REPLACE FUNCTION list_listing(p_listing uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user    uuid := app_user();
    v_listing marketplace_listings%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_listing FROM marketplace_listings l
     WHERE l.listing_id = p_listing FOR UPDATE;
    IF NOT FOUND OR v_listing.seller <> v_user THEN
        RETURN 'unknown_listing';
    END IF;
    IF v_listing.state <> 'draft' THEN
        RETURN 'illegal_state';
    END IF;
    UPDATE marketplace_listings
       SET state = 'listed', listed_at = now()
     WHERE listing_id = p_listing;
    INSERT INTO marketplace_events (listing_id, actor, from_state, to_state)
    VALUES (p_listing, v_user, 'draft', 'listed');
    RETURN 'listed';
END $$;

-- Seller takedown of a draft or listed listing. A held listing cannot be
-- removed out from under an escrow — the order resolves first.
-- Outcomes: 'removed' | 'forbidden' | 'unknown_listing' | 'illegal_state'.
CREATE OR REPLACE FUNCTION delist_listing(p_listing uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user    uuid := app_user();
    v_listing marketplace_listings%ROWTYPE;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_listing FROM marketplace_listings l
     WHERE l.listing_id = p_listing FOR UPDATE;
    IF NOT FOUND OR v_listing.seller <> v_user THEN
        RETURN 'unknown_listing';
    END IF;
    IF v_listing.state NOT IN ('draft', 'listed') THEN
        RETURN 'illegal_state';
    END IF;
    UPDATE marketplace_listings
       SET state = 'removed', closed_at = now()
     WHERE listing_id = p_listing;
    INSERT INTO marketplace_events (listing_id, actor, from_state, to_state)
    VALUES (p_listing, v_user, v_listing.state, 'removed');
    RETURN 'removed';
END $$;

-- ============================================================ AMD-MKT-05 ==
-- Moderation takedown with a governed reason code, audited. The actor is
-- passed explicitly (the record_kyc_decision discipline): moderation
-- console transactions carry app.moderator, not a consumer context.
-- Outcomes: 'removed' | 'forbidden' | 'unknown_listing' | 'reason_required'
-- | 'illegal_state'.
CREATE OR REPLACE FUNCTION moderate_listing(
    p_listing uuid, p_reason_code text, p_actor text)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_listing marketplace_listings%ROWTYPE;
BEGIN
    IF NOT app_moderator() THEN
        RETURN 'forbidden';
    END IF;
    IF p_reason_code IS NULL OR char_length(p_reason_code) NOT BETWEEN 1 AND 64 THEN
        RETURN 'reason_required';
    END IF;
    SELECT * INTO v_listing FROM marketplace_listings l
     WHERE l.listing_id = p_listing FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown_listing';
    END IF;
    IF v_listing.state NOT IN ('draft', 'listed') THEN
        RETURN 'illegal_state';
    END IF;
    UPDATE marketplace_listings
       SET state = 'removed', closed_at = now()
     WHERE listing_id = p_listing;
    INSERT INTO marketplace_events (listing_id, actor, from_state, to_state)
    VALUES (p_listing, NULL, v_listing.state, 'removed');
    PERFORM admin_audit_log(
        NULL,
        'marketplace.listing.removed',
        p_reason_code,
        'marketplace_listing', p_listing::text,
        jsonb_build_object('state', v_listing.state, 'seller', v_listing.seller),
        jsonb_build_object('state', 'removed', 'actor', p_actor)
    );
    RETURN 'removed';
END $$;

-- ============================================================ AMD-MKT-03 ==

-- Buy a listed listing: one transaction creates the single-milestone
-- AMD-INN-03 escrow (payee = seller, amount = price), the order row naming
-- it, and the listing's move to held. The escrow definer re-proves KYC,
-- wallets and funds and places the AMD-PAY-12 hold — any refusal aborts
-- the purchase with the escrow's own outcome.
-- Outcomes: 'purchased' | 'forbidden' | 'kyc_required' | 'unknown_listing'
-- | 'unavailable' | 'self' | 'wallet_unavailable' | 'insufficient_funds'
-- | 'invalid_amounts'.
CREATE OR REPLACE FUNCTION purchase_listing(p_listing uuid)
RETURNS TABLE(outcome text, order_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user    uuid := app_user();
    v_listing marketplace_listings%ROWTYPE;
    v_escrow  uuid;
    v_escrow_outcome text;
    v_order   uuid;
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
    SELECT * INTO v_listing FROM marketplace_listings l
     WHERE l.listing_id = p_listing FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_listing', NULL::uuid;
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
    SELECT e.outcome, e.escrow_id INTO v_escrow_outcome, v_escrow
      FROM create_escrow(v_listing.seller, ARRAY[v_listing.price_minor]) e;
    IF v_escrow_outcome <> 'created' THEN
        RETURN QUERY SELECT v_escrow_outcome, NULL::uuid;
        RETURN;
    END IF;
    INSERT INTO marketplace_orders (listing_id, buyer, seller, escrow_id)
    VALUES (p_listing, v_user, v_listing.seller, v_escrow)
    RETURNING marketplace_orders.order_id INTO v_order;
    UPDATE marketplace_listings
       SET state = 'held'
     WHERE listing_id = p_listing;
    INSERT INTO marketplace_events (listing_id, order_id, actor, from_state, to_state)
    VALUES (p_listing, v_order, v_user, 'listed', 'held'),
           (p_listing, v_order, v_user, NULL, 'active');
    RETURN QUERY SELECT 'purchased', v_order;
END $$;

-- The buyer confirms receipt: the escrow's single milestone releases to
-- the seller, the escrow completes, the order completes, the listing
-- sells — one transaction, so value and state can never diverge. A
-- verified-met receipt (AMD-INN-02) MAY back the handover as dispute
-- evidence; confirmation itself stays the buyer's call.
-- Outcomes: 'completed' | 'forbidden' | 'unknown_order' | 'escrow_error'.
CREATE OR REPLACE FUNCTION confirm_purchase(p_order uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user  uuid := app_user();
    v_order marketplace_orders%ROWTYPE;
    v_out   text;
BEGIN
    IF v_user IS NULL
       OR current_setting('app.transfer_settlement', true) IS DISTINCT FROM 'on' THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_order FROM marketplace_orders o
     WHERE o.order_id = p_order AND o.state = 'active' FOR UPDATE;
    IF NOT FOUND OR v_order.buyer <> v_user THEN
        RETURN 'unknown_order';
    END IF;
    v_out := release_escrow_milestone(v_order.escrow_id, 1::smallint);
    IF v_out <> 'completed' THEN
        RETURN 'escrow_error';
    END IF;
    UPDATE marketplace_orders
       SET state = 'completed', resolved_at = now()
     WHERE order_id = p_order;
    UPDATE marketplace_listings
       SET state = 'sold', closed_at = now()
     WHERE listing_id = v_order.listing_id;
    INSERT INTO marketplace_events (listing_id, order_id, actor, from_state, to_state)
    VALUES (v_order.listing_id, p_order, v_user, 'active', 'completed'),
           (v_order.listing_id, p_order, v_user, 'held', 'sold');
    RETURN 'completed';
END $$;

-- Either party disputes; the value stays held exactly as AMD-INN-03 pins.
-- Outcomes: 'disputed' | 'forbidden' | 'unknown_order'.
CREATE OR REPLACE FUNCTION dispute_purchase(p_order uuid)
RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_user  uuid := app_user();
    v_order marketplace_orders%ROWTYPE;
    v_out   text;
BEGIN
    IF v_user IS NULL THEN
        RETURN 'forbidden';
    END IF;
    SELECT * INTO v_order FROM marketplace_orders o
     WHERE o.order_id = p_order AND o.state = 'active' FOR UPDATE;
    IF NOT FOUND OR v_user NOT IN (v_order.buyer, v_order.seller) THEN
        RETURN 'unknown_order';
    END IF;
    v_out := dispute_escrow(v_order.escrow_id);
    IF v_out <> 'disputed' THEN
        RETURN 'unknown_order';
    END IF;
    UPDATE marketplace_orders
       SET state = 'disputed'
     WHERE order_id = p_order;
    INSERT INTO marketplace_events (listing_id, order_id, actor, from_state, to_state)
    VALUES (v_order.listing_id, p_order, v_user, 'active', 'disputed');
    RETURN 'disputed';
END $$;

-- Moderation resolves a disputed order through the escrow: 'refund' pays
-- the buyer back and relists the listing; 'release' pays the seller and
-- completes the sale. Audited by resolve_escrow itself.
-- Outcomes: 'resolved' | 'forbidden' | 'unknown_order' | 'invalid_decision'
-- | 'escrow_error'.
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
    IF v_out <> 'resolved' THEN
        RETURN 'escrow_error';
    END IF;
    IF p_decision = 'refund' THEN
        UPDATE marketplace_orders
           SET state = 'refunded', resolved_at = now()
         WHERE order_id = p_order;
        UPDATE marketplace_listings
           SET state = 'listed', listed_at = now()
         WHERE listing_id = v_order.listing_id;
        INSERT INTO marketplace_events (listing_id, order_id, actor, from_state, to_state)
        VALUES (v_order.listing_id, p_order, v_user, 'disputed', 'refunded'),
               (v_order.listing_id, p_order, NULL, 'held', 'listed');
    ELSE
        UPDATE marketplace_orders
           SET state = 'completed', resolved_at = now()
         WHERE order_id = p_order;
        UPDATE marketplace_listings
           SET state = 'sold', closed_at = now()
         WHERE listing_id = v_order.listing_id;
        INSERT INTO marketplace_events (listing_id, order_id, actor, from_state, to_state)
        VALUES (v_order.listing_id, p_order, v_user, 'disputed', 'completed'),
               (v_order.listing_id, p_order, NULL, 'held', 'sold');
    END IF;
    RETURN 'resolved';
END $$;

-- ------------------------------------------------------------ grants ------
-- Reads are RLS-governed; every write flows through the definers above.
GRANT SELECT ON marketplace_listings, marketplace_orders, marketplace_events
    TO presence_app;
GRANT EXECUTE ON FUNCTION create_listing(text, text, bigint, text) TO presence_app;
GRANT EXECUTE ON FUNCTION list_listing(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION delist_listing(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION moderate_listing(uuid, text, text) TO presence_app;
GRANT EXECUTE ON FUNCTION purchase_listing(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION confirm_purchase(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION dispute_purchase(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION resolve_purchase(uuid, text) TO presence_app;

COMMIT;
