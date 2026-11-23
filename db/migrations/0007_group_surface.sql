-- Presence — group surface and post-match links
-- (PRS-SRS-001 §4 group features; PRS-ARC-002 §5 P0 data plane)
--
-- Requirement anchors:
--   FR-66   group tables, <=6 participants, member-only visibility
--   SEC-33  the participant cap is a data-layer guarantee, not edge code:
--           a trigger locks the table row and rejects the seventh member
--   FR-69   exactly one designated host per table; co-member display is
--           name+role only, inside the table scope (scoped FR-30 carve-out)
--   FR-67   conversation cards derive from the join-time interest snapshot
--           (group_table_interests); joining is the act that shares
--   FR-68   bookable 1:1 slots; the booking row IS the consent act
--           (actor + timestamp, no separate express step); the primary key
--           makes double-booking impossible in the data layer
--   FR-74   host remove/close actions are audit-logged (FR-60 writer)
--   FR-75   no enumeration: every table-scoped read is membership-scoped,
--           non-members cannot distinguish closed tables from nonexistent
--   FR-65   one allowlisted external link per pair member, post-OPEN only
--   SEC-34  links are https-only at the data layer; the allowlist and the
--           no-server-fetch rule are edge/contract concerns (links.ts)
--
-- Forward-only migration; run after 0006_profile_safety.sql.

BEGIN;

-- ------------------------------------------------------------ FR-66 --------
CREATE TABLE group_tables (
    table_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id   uuid NOT NULL REFERENCES venues (venue_id),
    event_id   uuid REFERENCES events (event_id),
    name       varchar(80) NOT NULL,
    state      text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
    created_by uuid NOT NULL REFERENCES users (user_id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE group_table_members (
    table_id  uuid NOT NULL REFERENCES group_tables (table_id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users (user_id),
    role      text NOT NULL DEFAULT 'member' CHECK (role IN ('host','member')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (table_id, user_id)
);
CREATE INDEX group_table_members_user_idx ON group_table_members (user_id);

-- SEC-33: participant cap in the data layer. The table row is locked so two
-- concurrent joins cannot both pass the count check.
CREATE OR REPLACE FUNCTION group_table_member_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    n integer;
BEGIN
    PERFORM 1 FROM group_tables WHERE table_id = NEW.table_id FOR UPDATE;
    SELECT count(*) INTO n FROM group_table_members
     WHERE table_id = NEW.table_id;
    IF n >= 6 THEN
        RAISE EXCEPTION 'group table is full (SEC-33: max 6 participants)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER group_table_member_cap
    BEFORE INSERT ON group_table_members
    FOR EACH ROW EXECUTE FUNCTION group_table_member_cap();

-- FR-69: exactly one designated host per table. (A host departure with
-- members remaining is rejected by the edge — 409 — not here; this trigger
-- only bars a second host.)
CREATE OR REPLACE FUNCTION group_table_single_host() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.role = 'host' AND EXISTS (
        SELECT 1 FROM group_table_members
         WHERE table_id = NEW.table_id
           AND role = 'host'
           AND user_id <> NEW.user_id
    ) THEN
        RAISE EXCEPTION 'group table already has a host (FR-69)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER group_table_single_host
    BEFORE INSERT OR UPDATE ON group_table_members
    FOR EACH ROW EXECUTE FUNCTION group_table_single_host();

-- ------------------------------------------------------------ FR-67 --------
-- Join-time snapshot of the member's declared non-sensitive interests.
-- Joining is the act that shares; leaving deletes the snapshot. Visible to
-- table members only — this is the consent-clean basis for conversation
-- cards, never a searchable surface.
CREATE TABLE group_table_interests (
    table_id uuid NOT NULL REFERENCES group_tables (table_id) ON DELETE CASCADE,
    user_id  uuid NOT NULL REFERENCES users (user_id),
    node_id  text NOT NULL REFERENCES taxonomy_nodes (node_id),
    weight   real NOT NULL DEFAULT 1.0 CHECK (weight > 0 AND weight <= 1),
    PRIMARY KEY (table_id, user_id, node_id)
);

-- ------------------------------------------------------------ FR-68 --------
CREATE TABLE table_slots (
    slot_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id         uuid NOT NULL REFERENCES group_tables (table_id) ON DELETE CASCADE,
    offerer          uuid NOT NULL REFERENCES users (user_id),
    starts_at        timestamptz NOT NULL,
    duration_minutes smallint NOT NULL DEFAULT 15
        CHECK (duration_minutes BETWEEN 5 AND 60),
    state            text NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','booked','cancelled')),
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX table_slots_table_idx ON table_slots (table_id, starts_at);

-- The booking row is the consent act (FR-68): actor and timestamp, recorded
-- once. The primary key caps bookings at one per slot in the data layer.
CREATE TABLE slot_bookings (
    slot_id      uuid PRIMARY KEY REFERENCES table_slots (slot_id) ON DELETE CASCADE,
    booker       uuid NOT NULL REFERENCES users (user_id),
    booked_at    timestamptz NOT NULL DEFAULT now(),
    cancelled_at timestamptz
);

-- ------------------------------------------------------------ FR-65 --------
-- One allowlisted external link per pair member. The pair must be OPEN for
-- any read or write (policy below mirrors messages_open_members). The
-- allowlist itself lives in the edge (SEC-34); the data layer guarantees
-- https-only and bounded length.
CREATE TABLE pair_links (
    pair_id    uuid NOT NULL REFERENCES matches (pair_id),
    owner      uuid NOT NULL REFERENCES users (user_id),
    url        text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 300),
    shared_at  timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pair_id, owner)
);

-- --------------------------------------------- security-definer helpers ---
-- RLS policies on membership tables cannot query the membership table
-- itself (infinite recursion), and the creator cannot see their own table
-- row until they are a member. These owner-run helpers break both cycles;
-- they return booleans/directories only, never raw rows.

CREATE OR REPLACE FUNCTION is_group_member(p_table_id uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM group_table_members
         WHERE table_id = p_table_id AND user_id = p_user
    )
$$;

CREATE OR REPLACE FUNCTION is_group_host(p_table_id uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM group_table_members
         WHERE table_id = p_table_id AND user_id = p_user AND role = 'host'
    )
$$;

CREATE OR REPLACE FUNCTION is_group_creator(p_table_id uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM group_tables
         WHERE table_id = p_table_id AND created_by = p_user
    )
$$;

-- FR-75: the only non-member read of a table. Returns non-identifying join
-- affordance (venue, member count) and only while the table is open, so
-- closed tables are indistinguishable from nonexistent ones.
CREATE OR REPLACE FUNCTION group_join_info(p_table_id uuid)
RETURNS TABLE (venue_id uuid, member_count integer)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public AS $$
BEGIN
    RETURN QUERY
      SELECT gt.venue_id,
             (SELECT count(*)::integer FROM group_table_members gm
               WHERE gm.table_id = gt.table_id)
        FROM group_tables gt
       WHERE gt.table_id = p_table_id
         AND gt.state = 'open';
END $$;

-- FR-69/FR-74: the co-member directory — display name + role, only for
-- callers who are themselves members of the table. This is the scoped
-- FR-30 carve-out for the group surface: identity inside a joined table,
-- nowhere else. Empty result for non-members.
CREATE OR REPLACE FUNCTION group_member_directory(p_table_id uuid)
RETURNS TABLE (user_id uuid, handle text, role text, joined_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public AS $$
DECLARE
    v_caller uuid := app_user();
BEGIN
    IF v_caller IS NULL OR NOT is_group_member(p_table_id, v_caller) THEN
        RETURN;
    END IF;
    RETURN QUERY
      SELECT gm.user_id, ui.handle, gm.role, gm.joined_at
        FROM group_table_members gm
        LEFT JOIN user_identities ui ON ui.user_id = gm.user_id
       WHERE gm.table_id = p_table_id
       ORDER BY gm.joined_at;
END $$;

REVOKE ALL ON FUNCTION is_group_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION is_group_host(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION is_group_creator(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION group_join_info(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION group_member_directory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_group_member(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION is_group_host(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION is_group_creator(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION group_join_info(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION group_member_directory(uuid) TO presence_app;

-- ------------------------------------------------- row-level security -----
ALTER TABLE group_tables          ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_table_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_table_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_slots           ENABLE ROW LEVEL SECURITY;
ALTER TABLE slot_bookings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pair_links            ENABLE ROW LEVEL SECURITY;

-- FR-66/FR-75: a table is visible to its members only. Creation is open to
-- any authenticated account (the edge gates on live venue presence).
CREATE POLICY group_tables_member ON group_tables
    FOR SELECT USING (is_group_member(table_id, app_user()));
CREATE POLICY group_tables_create ON group_tables
    FOR INSERT WITH CHECK (created_by = app_user());
-- Host closes the table; only the state column is grantable (below).
CREATE POLICY group_tables_host_update ON group_tables
    FOR UPDATE USING (is_group_host(table_id, app_user()))
    WITH CHECK (is_group_host(table_id, app_user()));

-- Members see the membership of their own tables only (FR-75).
CREATE POLICY group_members_select ON group_table_members
    FOR SELECT USING (is_group_member(table_id, app_user()));
-- Join self as member, or create self as host of a table you created.
CREATE POLICY group_members_insert ON group_table_members
    FOR INSERT WITH CHECK (
        user_id = app_user()
        AND (role = 'member'
             OR (role = 'host' AND is_group_creator(table_id, app_user())))
    );
-- Leave yourself; the host removes others (audited by the edge, FR-74).
CREATE POLICY group_members_delete ON group_table_members
    FOR DELETE USING (
        user_id = app_user() OR is_group_host(table_id, app_user())
    );

-- FR-67: the interest snapshot is visible inside the table only, writable
-- and erasable by its owner alone.
CREATE POLICY interests_member ON group_table_interests
    FOR SELECT USING (is_group_member(table_id, app_user()));
CREATE POLICY interests_insert_own ON group_table_interests
    FOR INSERT WITH CHECK (
        user_id = app_user() AND is_group_member(table_id, app_user())
    );
CREATE POLICY interests_delete_own ON group_table_interests
    FOR DELETE USING (user_id = app_user());

-- FR-68: slots are a member-only surface. Booking flips state to 'booked'
-- via a conditional update; cancelling flips it back. Only the state
-- column is grantable — offerer, time and duration are immutable.
CREATE POLICY slots_member ON table_slots
    FOR SELECT USING (is_group_member(table_id, app_user()));
CREATE POLICY slots_insert_own ON table_slots
    FOR INSERT WITH CHECK (
        offerer = app_user() AND is_group_member(table_id, app_user())
    );
CREATE POLICY slots_member_update ON table_slots
    FOR UPDATE USING (is_group_member(table_id, app_user()))
    WITH CHECK (is_group_member(table_id, app_user()));

-- Bookings: visible inside the table; book as yourself, never your own
-- slot; cancellation by the booker or the offerer only.
CREATE POLICY bookings_member ON slot_bookings
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM table_slots ts
         WHERE ts.slot_id = slot_bookings.slot_id
           AND is_group_member(ts.table_id, app_user())));
CREATE POLICY bookings_insert_own ON slot_bookings
    FOR INSERT WITH CHECK (
        booker = app_user()
        AND EXISTS (SELECT 1 FROM table_slots ts
                     WHERE ts.slot_id = slot_bookings.slot_id
                       AND ts.offerer <> app_user()
                       AND is_group_member(ts.table_id, app_user()))
    );
CREATE POLICY bookings_cancel ON slot_bookings
    FOR UPDATE USING (
        booker = app_user()
        OR EXISTS (SELECT 1 FROM table_slots ts
                    WHERE ts.slot_id = slot_bookings.slot_id
                      AND ts.offerer = app_user())
    ) WITH CHECK (
        booker = app_user()
        OR EXISTS (SELECT 1 FROM table_slots ts
                    WHERE ts.slot_id = slot_bookings.slot_id
                      AND ts.offerer = app_user())
    );

-- FR-65: mirrors messages_open_members — the pair must be OPEN and the
-- caller must be in it. Each member manages their own single link.
CREATE POLICY pair_links_open_members ON pair_links
    USING (EXISTS (SELECT 1 FROM matches m
                    WHERE m.pair_id = pair_links.pair_id
                      AND m.state = 'OPEN'
                      AND app_user() IN (m.user_lo, m.user_hi)))
    WITH CHECK (owner = app_user() AND EXISTS (
                    SELECT 1 FROM matches m
                     WHERE m.pair_id = pair_links.pair_id
                       AND m.state = 'OPEN'
                       AND app_user() IN (m.user_lo, m.user_hi)));

-- ------------------------------------------------------------- grants -----
GRANT SELECT, INSERT ON group_tables TO presence_app;
GRANT UPDATE (state) ON group_tables TO presence_app;
GRANT SELECT, INSERT, DELETE ON group_table_members TO presence_app;
GRANT SELECT, INSERT, DELETE ON group_table_interests TO presence_app;
GRANT SELECT, INSERT ON table_slots TO presence_app;
GRANT UPDATE (state) ON table_slots TO presence_app;
GRANT SELECT, INSERT ON slot_bookings TO presence_app;
GRANT UPDATE (cancelled_at) ON slot_bookings TO presence_app;
GRANT SELECT, INSERT ON pair_links TO presence_app;
GRANT UPDATE (url, updated_at) ON pair_links TO presence_app;

COMMIT;
