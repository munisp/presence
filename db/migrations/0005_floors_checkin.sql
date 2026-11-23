-- Presence — venue floors, connected floors, check-in token secrets
-- (PRS-SRS-001 §3.4/§4.3; PRS-ARC-002 §5)
--
-- Requirement anchors:
--   FR-99   per-floor check-in: floors carry their own code (floor_id),
--           polygon and connected-floor declaration; presence is attributed
--           to a floor when the client presents one
--   FR-100  check-in tokens are signed and short-lived (edge mints/verifies;
--           the secret below is the key material)
--   TR-42   floor identity and connected floors live on the venue's
--           geometry records — PostGIS is canonical
--
-- Forward-only migration; run after 0004_discovery_safety.sql.

BEGIN;

-- ------------------------------------------------------------- floors ------
-- A floor is declared by the venue operator. The polygon is optional at P0
-- (client-side floor pickers are not in the reference client yet), but the
-- row — and its connected_to declaration — is the system of record the edge
-- consults when it scopes same-venue matches by floor.

CREATE TABLE venue_floors (
    venue_id     uuid NOT NULL REFERENCES venues (venue_id) ON DELETE CASCADE,
    floor_id     text NOT NULL CHECK (floor_id ~ '^[A-Za-z0-9_-]{1,32}$'),
    label        text NOT NULL DEFAULT '',
    geofence     geography(Polygon, 4326),          -- FR-99 per-floor polygon
    connected_to text[] NOT NULL DEFAULT '{}',      -- floor ids on this venue
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (venue_id, floor_id),
    CHECK (NOT (floor_id = ANY (connected_to)))     -- not its own neighbour
);

-- The edge reads the whole table: any user near a venue may need the
-- connected-floor map to scope a scan. Writes are operational (seed data /
-- admin), never client traffic, so no write grant is given to the app role.
ALTER TABLE venue_floors ENABLE ROW LEVEL SECURITY;
CREATE POLICY venue_floors_read_all ON venue_floors FOR SELECT USING (true);

GRANT SELECT ON venue_floors TO presence_app;

-- -------------------------------------------------- check-in secret (FR-100)
-- Per-venue HMAC key for minting and verifying short-lived check-in tokens.
-- Server-side only: it is never returned by any endpoint. The edge role can
-- read it because the edge IS the verifier; clients only ever see tokens.

ALTER TABLE venues
    ADD COLUMN checkin_secret text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex');

COMMIT;
