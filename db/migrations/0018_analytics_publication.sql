-- 0018_analytics_publication.sql
--
-- TR-38 / FR-90: venue polygon attribution is computed in the lakehouse as a
-- spatial join (analytics/attribution.py) and published to the operational
-- store as a cell -> venue/floor map, so presence publishing and matching
-- scope by venue geometry with a primary-key lookup — never a per-request
-- spatial query.
--
-- FR-90 versioning: venues.geofence and venue_floors.geofence are versioned
-- with their records. A trigger bumps geofence_version on every geometry
-- change (the only write path is publish_geofence_draft, migration 0017).
-- Attribution rows carry the geometry version they were computed from; the
-- edge honours attribution only while the versions match, so a stale map can
-- never mis-scope presence after a polygon revision — it silently falls back
-- to cell scope until the lakehouse republishes.
--
-- Python never writes to this database (ARC-002 §4.3 ownership boundary):
-- the lakehouse emits a signed-in-git publication bundle (SQL text) and an
-- operator or automation applies it through this function, which validates,
-- enforces version monotonicity and audits.

-- ---------------------------------------------------------------------------
-- FR-90: geometry versioning on the canonical polygon records
-- ---------------------------------------------------------------------------

ALTER TABLE venues ADD COLUMN geofence_version integer NOT NULL DEFAULT 0;
ALTER TABLE venue_floors ADD COLUMN geofence_version integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION geofence_version_bump() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.geofence IS DISTINCT FROM OLD.geofence THEN
    NEW.geofence_version := OLD.geofence_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER venues_geofence_version
  BEFORE UPDATE OF geofence ON venues
  FOR EACH ROW EXECUTE FUNCTION geofence_version_bump();

CREATE TRIGGER venue_floors_geofence_version
  BEFORE UPDATE OF geofence ON venue_floors
  FOR EACH ROW EXECUTE FUNCTION geofence_version_bump();

-- ---------------------------------------------------------------------------
-- TR-38: the published attribution map
-- ---------------------------------------------------------------------------

CREATE TABLE cell_attribution (
  -- H3 cell at the governed attribution resolution (9), 15 lowercase hex chars.
  cell text PRIMARY KEY CHECK (cell ~ '^[0-9a-f]{15}$'),
  venue_id uuid NOT NULL REFERENCES venues (venue_id) ON DELETE CASCADE,
  floor_id text,
  -- Geometry version the attribution was computed from; freshness is checked
  -- against venues.geofence_version at read time.
  geometry_version integer NOT NULL,
  -- Lakehouse run that produced the row (UTC timestamp + content digest).
  run_id text NOT NULL,
  attributed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (venue_id, floor_id) REFERENCES venue_floors (venue_id, floor_id)
);

ALTER TABLE cell_attribution ENABLE ROW LEVEL SECURITY;

-- Matching and presence publishing read the map; it carries venue geometry
-- scope, nothing personal — same read-all discipline as venue_floors (TR-42).
CREATE POLICY cell_attribution_read_all ON cell_attribution
  FOR SELECT USING (true);

-- No write policy: the only write path is publish_cell_attribution below.
GRANT SELECT ON cell_attribution TO presence_app;

-- ---------------------------------------------------------------------------
-- TR-38: the single governed write path
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION publish_cell_attribution(p_rows jsonb, p_run_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r jsonb;
  n integer := 0;
BEGIN
  -- Venue geometry is owned by the venue-ops workflow (TR-41); publishing the
  -- map derived from it carries the same gate.
  IF current_setting('app.venue_ops', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'cell attribution publication requires the venue-ops role';
  END IF;
  IF p_run_id IS NULL OR length(p_run_id) < 8 OR length(p_run_id) > 128 THEN
    RAISE EXCEPTION 'run_id must be 8..128 characters';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a jsonb array';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    IF (r ->> 'cell') !~ '^[0-9a-f]{15}$' THEN
      RAISE EXCEPTION 'invalid cell: %', r ->> 'cell';
    END IF;
    -- Version monotonicity: a stale run can never roll a cell back to an
    -- older geometry version.
    INSERT INTO cell_attribution (cell, venue_id, floor_id, geometry_version, run_id)
    VALUES (
      r ->> 'cell',
      (r ->> 'venue_id')::uuid,
      r ->> 'floor_id',
      (r ->> 'geometry_version')::integer,
      p_run_id
    )
    ON CONFLICT (cell) DO UPDATE
      SET venue_id = EXCLUDED.venue_id,
          floor_id = EXCLUDED.floor_id,
          geometry_version = EXCLUDED.geometry_version,
          run_id = EXCLUDED.run_id,
          attributed_at = now()
      WHERE EXCLUDED.geometry_version >= cell_attribution.geometry_version;
    n := n + 1;
  END LOOP;

  PERFORM admin_audit_log(
    current_setting('app.actor', true)::uuid,
    'venue.attribution.publish',
    'other_policy',
    'venue',
    NULL,
    jsonb_build_object('runId', p_run_id),
    jsonb_build_object('rows', n)
  );
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION publish_cell_attribution(jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publish_cell_attribution(jsonb, text) TO presence_app;
