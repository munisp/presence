-- Presence — Postgres 17 schema (PRS-SRS-001 §5, §7; PRS-ARC-002 P0 data plane)
--
-- Requirement anchors:
--   TR-17/18  taxonomy depth + materialized closure
--   TR-07     semantic links (rivalry / neighbour / co-occurrence)
--   TR-11     per-venue threshold configuration
--   TR-12/15  H3 res-9 presence cells; raw coordinates rejected server-side
--   FR-29     consent state machine DETECTED→NUDGED→EXPRESSED→MUTUAL→OPEN
--   FR-30     no identity before OPEN — enforced here by row-level security
--   FR-35     append-only consent ledger
--   ARC       PostGIS is canonical for venue polygons (GeoLibre edits, we store)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS postgis;    -- venue geofences (ARC: PostGIS canonical)

-- ------------------------------------------------------------- taxonomy ---
-- The interest taxonomy is a forest, depth <= 5 from domain root (TR-17).

CREATE TABLE taxonomy_nodes (
    node_id     text PRIMARY KEY,                 -- e.g. sports.football.premier-league.arsenal
    label       text NOT NULL,                    -- human label used in reason text (TR-09)
    parent_id   text REFERENCES taxonomy_nodes (node_id) DEFERRABLE INITIALLY DEFERRED,
    kind        text NOT NULL,   -- domain/category/topic/leaf in the governed
                                 -- taxonomy; the eval graph uses richer kinds
                                 -- (sport/league/club, genre, region/city, ...)
    sensitive   boolean NOT NULL DEFAULT false,   -- TR-22: never enters vectors or reasons
    redirect_to text REFERENCES taxonomy_nodes (node_id),  -- deprecated alias target
    depth       smallint NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 5)
);

-- TR-18: closure materialized at import time; the match service never walks
-- parents at query time. hops 0 = self, decay = 0.55^hops (TR-04).
CREATE TABLE taxonomy_closure (
    node_id     text NOT NULL REFERENCES taxonomy_nodes (node_id),
    ancestor_id text NOT NULL REFERENCES taxonomy_nodes (node_id),
    hops        smallint NOT NULL CHECK (hops BETWEEN 0 AND 4),
    decay       real   NOT NULL,
    PRIMARY KEY (node_id, ancestor_id)
);
CREATE INDEX taxonomy_closure_ancestor_idx ON taxonomy_closure (ancestor_id);

-- TR-07: authored semantic links — one hop in scoring, excluded from df.
CREATE TABLE taxonomy_links (
    a_id   text NOT NULL REFERENCES taxonomy_nodes (node_id),
    b_id   text NOT NULL REFERENCES taxonomy_nodes (node_id),
    kind   text NOT NULL CHECK (kind IN ('rivalry','neighbour','co_occurs')),
    weight real NOT NULL CHECK (weight > 0 AND weight <= 1),
    PRIMARY KEY (a_id, b_id, kind)
);

-- ---------------------------------------------------------------- users ---
-- Identity is deliberately minimal. Anything that could identify a person
-- off-platform lives behind the RLS boundary further down (FR-30).

CREATE TABLE users (
    user_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Display identity — readable by the owner, and by a counterpart ONLY after
-- the pair reaches OPEN (policy below, FR-30).
CREATE TABLE user_identities (
    user_id     uuid PRIMARY KEY REFERENCES users (user_id),
    handle      text NOT NULL,
    photo_url   text,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profile_interests (
    user_id uuid NOT NULL REFERENCES users (user_id),
    node_id text NOT NULL REFERENCES taxonomy_nodes (node_id),
    weight  real NOT NULL DEFAULT 1.0 CHECK (weight > 0 AND weight <= 1),
    PRIMARY KEY (user_id, node_id)
);

-- ---------------------------------------------------------------- venues ---

CREATE TABLE venues (
    venue_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL,
    geofence        geography(Polygon, 4326),       -- PostGIS canonical (ARC)
    h3_res          smallint NOT NULL DEFAULT 9     -- TR-12; server descends to
        CHECK (h3_res BETWEEN 9 AND 11),            -- 10/11 past density triggers
    base_threshold  real NOT NULL DEFAULT 0.12      -- TR-11 / FR-21 floor
        CHECK (base_threshold >= 0 AND base_threshold <= 1),
    max_scan_results smallint NOT NULL DEFAULT 3    -- FR-20
        CHECK (max_scan_results BETWEEN 1 AND 3),
    active          boolean NOT NULL DEFAULT true
);

CREATE TABLE events (
    event_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id   uuid NOT NULL REFERENCES venues (venue_id),
    name       text NOT NULL,
    starts_at  timestamptz NOT NULL,
    ends_at    timestamptz NOT NULL,
    CHECK (ends_at > starts_at)
);

-- Time-boxed venue offers surfaced alongside scan results.
CREATE TABLE offers (
    offer_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id   uuid NOT NULL REFERENCES venues (venue_id),
    title      text NOT NULL,
    terms      text NOT NULL,
    starts_at  timestamptz NOT NULL,
    ends_at    timestamptz NOT NULL,
    CHECK (ends_at > starts_at)
);

-- Announcements: venue-scoped or global; edge serves only rows inside the
-- publish window.
CREATE TABLE announcements (
    announcement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id        uuid REFERENCES venues (venue_id),  -- NULL = global
    body            text NOT NULL,
    publish_at      timestamptz NOT NULL,
    expire_at       timestamptz NOT NULL,
    CHECK (expire_at > publish_at)
);

-- ----------------------------------------------------------- consent ------
-- FR-29: the only legal forward path. DETECTED is recorded by the system when
-- a pair first clears threshold; the rest are driven by user action.

CREATE TYPE consent_state AS ENUM ('DETECTED','NUDGED','EXPRESSED','MUTUAL','OPEN');

-- A pair is canonical: user_lo < user_hi, so (A,B) and (B,A) are one row.
CREATE TABLE matches (
    pair_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_lo    uuid NOT NULL REFERENCES users (user_id),
    user_hi    uuid NOT NULL REFERENCES users (user_id),
    state      consent_state NOT NULL DEFAULT 'DETECTED',
    opened_at  timestamptz,
    CHECK (user_lo < user_hi),
    UNIQUE (user_lo, user_hi)
);

-- FR-35: append-only ledger. Every transition, including system DETECTED, is
-- a row. UPDATE and DELETE are blocked twice — revoked privileges and a
-- trigger — so a compromised app role still cannot rewrite history.
CREATE TABLE consent_ledger (
    seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pair_id    uuid NOT NULL REFERENCES matches (pair_id),
    actor      uuid REFERENCES users (user_id),   -- NULL = system
    from_state consent_state,                     -- NULL for the first row
    to_state   consent_state NOT NULL,
    at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_ledger_pair_idx ON consent_ledger (pair_id, seq);

CREATE OR REPLACE FUNCTION consent_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'consent_ledger is append-only (FR-35)';
END $$;

CREATE TRIGGER consent_ledger_no_update
    BEFORE UPDATE OR DELETE ON consent_ledger
    FOR EACH ROW EXECUTE FUNCTION consent_ledger_append_only();

-- FR-29: legal transitions only, enforced at write time.
CREATE OR REPLACE FUNCTION consent_transition_ok(from_state consent_state,
                                                 to_state consent_state)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE from_state
        WHEN NULL        THEN to_state = 'DETECTED'
        WHEN 'DETECTED'  THEN to_state IN ('NUDGED','EXPRESSED')
        WHEN 'NUDGED'    THEN to_state = 'EXPRESSED'
        WHEN 'EXPRESSED' THEN to_state = 'MUTUAL'   -- both sides expressed
        WHEN 'MUTUAL'    THEN to_state = 'OPEN'
        ELSE false
    END
$$;

CREATE OR REPLACE FUNCTION consent_ledger_check_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT consent_transition_ok(NEW.from_state, NEW.to_state) THEN
        RAISE EXCEPTION 'illegal consent transition % -> % (FR-29)',
            NEW.from_state, NEW.to_state;
    END IF;
    UPDATE matches
       SET state = NEW.to_state,
           opened_at = CASE WHEN NEW.to_state = 'OPEN' THEN now() ELSE opened_at END
     WHERE pair_id = NEW.pair_id;
    RETURN NEW;
END $$;

CREATE TRIGGER consent_ledger_transition
    BEFORE INSERT ON consent_ledger
    FOR EACH ROW EXECUTE FUNCTION consent_ledger_check_transition();

-- ---------------------------------------------------------------- reports ---

CREATE TABLE reports (
    report_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter    uuid NOT NULL REFERENCES users (user_id),
    reported    uuid NOT NULL REFERENCES users (user_id),
    venue_id    uuid REFERENCES venues (venue_id),
    reason      text NOT NULL,
    details     text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','closed'))
);

-- ------------------------------------------------------------- messaging ---
-- FR-36: messages are MLS-encrypted on the client; the server relays and
-- stores opaque envelopes only, gated to pair members after OPEN.

CREATE TABLE messages (
    message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_id    uuid NOT NULL REFERENCES matches (pair_id),
    sender     uuid NOT NULL REFERENCES users (user_id),
    envelope   bytea NOT NULL,          -- MLS ciphertext; never plaintext
    sent_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_pair_idx ON messages (pair_id, sent_at);

-- ------------------------------------------------- row-level security -----
-- Two application roles. The edge connects as `presence_app` (RLS-enforced)
-- and sets `app.user_id` per request (SET LOCAL). The match service connects
-- as `presence_match` (BYPASSRLS) — it must read every present user's
-- profile to score pairs; it never serves client traffic, so nothing crosses
-- the FR-30 boundary. The dev passwords below are compose defaults, rotated
-- via secrets in any real deployment.

CREATE ROLE presence_app LOGIN PASSWORD 'presence-dev';
CREATE ROLE presence_match LOGIN PASSWORD 'presence-dev' BYPASSRLS;

ALTER TABLE matches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_ledger    ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identities   ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports           ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages          ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_user() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- You can see a pair only if you are in it.
CREATE POLICY matches_member ON matches
    USING (app_user() IN (user_lo, user_hi));

-- You can read the ledger of your own pairs only.
CREATE POLICY ledger_member ON consent_ledger
    USING (EXISTS (SELECT 1 FROM matches m
                    WHERE m.pair_id = consent_ledger.pair_id
                      AND app_user() IN (m.user_lo, m.user_hi)));

-- FR-30: identity rows are visible to their owner, and to a pair member only
-- after OPEN. Before OPEN the edge serves traits/reasons, never identity.
CREATE POLICY identity_owner ON user_identities
    USING (user_id = app_user());
CREATE POLICY identity_after_open ON user_identities
    USING (EXISTS (SELECT 1 FROM matches m
                    WHERE m.state = 'OPEN'
                      AND app_user() IN (m.user_lo, m.user_hi)
                      AND user_identities.user_id IN (m.user_lo, m.user_hi)));

-- Profiles: owner read/write only for the edge role. (The match service's
-- BYPASSRLS role reads everyone — that is its job; it emits scores and
-- reason paths, never raw profiles.)
CREATE POLICY profile_owner ON profile_interests
    USING (user_id = app_user())
    WITH CHECK (user_id = app_user());

-- Reports: file as yourself, read nothing back through the app role.
CREATE POLICY report_file_own ON reports
    FOR INSERT WITH CHECK (reporter = app_user());

-- FR-36/FR-30: messages are readable and writable only by pair members, and
-- only once the pair is OPEN.
CREATE POLICY messages_open_members ON messages
    USING (EXISTS (SELECT 1 FROM matches m
                    WHERE m.pair_id = messages.pair_id
                      AND m.state = 'OPEN'
                      AND app_user() IN (m.user_lo, m.user_hi)))
    WITH CHECK (sender = app_user() AND EXISTS (
                    SELECT 1 FROM matches m
                     WHERE m.pair_id = messages.pair_id
                       AND m.state = 'OPEN'
                       AND app_user() IN (m.user_lo, m.user_hi)));

GRANT SELECT ON taxonomy_nodes, taxonomy_closure, taxonomy_links,
                venues, events, offers, announcements TO presence_app;
GRANT SELECT, INSERT, UPDATE ON profile_interests TO presence_app;
GRANT SELECT ON users TO presence_app;
GRANT SELECT, INSERT, UPDATE ON user_identities TO presence_app;
GRANT SELECT, INSERT ON matches TO presence_app;
GRANT SELECT, INSERT ON consent_ledger TO presence_app;   -- no UPDATE/DELETE (FR-35)
GRANT INSERT ON reports TO presence_app;
GRANT SELECT, INSERT ON messages TO presence_app;

-- match service backend role (RLS-bypassing; internal only)
GRANT SELECT ON taxonomy_nodes, taxonomy_closure, taxonomy_links,
                profile_interests TO presence_match;

-- the ledger trigger updates matches.state; the function runs as the caller,
-- so the app role needs that one column
GRANT UPDATE (state, opened_at) ON matches TO presence_app;

COMMIT;
