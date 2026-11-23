-- Presence — geofence authoring workflow (GeoLibre console)
-- (PRS-SRS-001 §3.4; PRS-ARC-002 §5; ADR-0008)
--
-- Requirement anchors:
--   TR-41   geofence polygons are authored through the GeoLibre editor in
--           the ops console, reviewed by a SECOND person, and density-
--           verified before they may publish
--   TR-42   the published geometry lands on the canonical records — PostGIS
--           geography(Polygon,4326) on venues / venue_floors
--
-- A geofence never goes live from one person's hands. The draft state
-- machine is draft -> in_review -> approved -> published (or rejected at
-- review); approval requires reviewer <> author, and publishing is only
-- possible through publish_geofence_draft(), which re-verifies the
-- reviewer, the state, and the polygon's density in one transaction.
--
-- Density verification (TR-41): a geofence is only as good as its
-- vertices. Four corners around a city block claim a straight-edge square;
-- the real outline curves. The gate: the polygon must be valid, carry at
-- least four vertices, cover between 10 m² and 1 km², and add no points
-- when segmentized at 25 m — i.e. every edge is already at most 25 m, so
-- chord error stays well under one presence cell.
--
-- Forward-only migration; run after 0016_age_assurance.sql.

BEGIN;

-- ------------------------------------------------------------ drafts -------
CREATE TABLE geofence_drafts (
    draft_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type text NOT NULL CHECK (target_type IN ('venue', 'floor')),
    venue_id    uuid NOT NULL REFERENCES venues (venue_id),
    floor_id    text,                              -- NULL for venue targets
    polygon     geography(Polygon, 4326) NOT NULL,
    author      uuid NOT NULL,                     -- workforce subject (no FK —
    reviewer    uuid,                              -- the workforce lives in the
    status      text NOT NULL DEFAULT 'draft'      -- IdP, not this schema)
        CHECK (status IN ('draft', 'in_review', 'approved', 'published', 'rejected')),
    message     text,                              -- review note (reject reason)
    created_at  timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    published_at timestamptz,
    -- A floor draft targets a floor row; a venue draft targets the venue.
    FOREIGN KEY (venue_id, floor_id) REFERENCES venue_floors (venue_id, floor_id),
    CHECK (target_type = 'venue' OR floor_id IS NOT NULL),
    CHECK (target_type = 'floor' OR floor_id IS NULL)
);
CREATE INDEX geofence_drafts_status_idx ON geofence_drafts (status, created_at);

-- ------------------------------------------------------ density gate -------
-- Returns NULL when the polygon passes, else the first failing check. The
-- edge mirrors this in TypeScript for early authoring feedback; the DB is
-- the final authority and re-runs it inside publish_geofence_draft().
CREATE OR REPLACE FUNCTION geofence_density_check(p geography)
RETURNS text
    LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    n_points integer;
    n_dense  integer;
    area_m2  double precision;
BEGIN
    IF NOT ST_IsValid(p::geometry) THEN
        RETURN 'polygon is not valid';
    END IF;
    n_points := ST_NPoints(p::geometry);
    IF n_points < 4 THEN
        RETURN 'polygon needs at least 4 vertices';
    END IF;
    area_m2 := ST_Area(p);
    IF area_m2 < 10 OR area_m2 > 1000000 THEN
        RETURN 'polygon area must be between 10 m² and 1 km²';
    END IF;
    -- No edge longer than 25 m: segmentizing adds nothing to a dense
    -- polygon, so equality with the unsegmentized point count is the check.
    n_dense := ST_NPoints(ST_Segmentize(p, 25)::geometry);
    IF n_dense <> n_points THEN
        RETURN 'polygon edges must be at most 25 m (densify the outline)';
    END IF;
    RETURN NULL;
END $$;

-- ------------------------------------------------------------- console -----
CREATE OR REPLACE FUNCTION app_venue_ops() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.venue_ops', true) = 'on' $$;

ALTER TABLE geofence_drafts ENABLE ROW LEVEL SECURITY;

-- The workflow is console-only; the app role reaches it under the GUC.
CREATE POLICY geofence_drafts_console ON geofence_drafts
    FOR ALL USING (app_venue_ops()) WITH CHECK (app_venue_ops());

-- ------------------------------------------------------------ publish ------
-- The only path from approved to published. Verifies, in one transaction:
-- the draft is approved, the caller IS the second person (the recorded
-- reviewer, who cannot be the author), and the polygon still passes the
-- density gate; then writes the canonical geometry (TR-42) and audits.
CREATE OR REPLACE FUNCTION publish_geofence_draft(p_draft_id uuid, p_reviewer uuid)
RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    d geofence_drafts%ROWTYPE;
    v_density text;
BEGIN
    SELECT * INTO d FROM geofence_drafts WHERE draft_id = p_draft_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'geofence draft not found';
    END IF;
    IF d.status <> 'approved' THEN
        RAISE EXCEPTION 'geofence draft is not approved';
    END IF;
    -- TR-41 four-eyes: the publisher is the second person, and the second
    -- person is never the author.
    IF d.reviewer IS DISTINCT FROM p_reviewer OR d.reviewer = d.author THEN
        RAISE EXCEPTION 'publish requires the reviewing second person';
    END IF;
    v_density := geofence_density_check(d.polygon);
    IF v_density IS NOT NULL THEN
        RAISE EXCEPTION 'density verification failed: %', v_density;
    END IF;
    IF d.target_type = 'venue' THEN
        UPDATE venues SET geofence = d.polygon WHERE venue_id = d.venue_id;
    ELSE
        UPDATE venue_floors SET geofence = d.polygon
         WHERE venue_id = d.venue_id AND floor_id = d.floor_id;
    END IF;
    UPDATE geofence_drafts
       SET status = 'published', published_at = now()
     WHERE draft_id = p_draft_id;
    PERFORM admin_audit_log(
        p_reviewer,
        'geofence.draft.publish',
        'other_policy',
        'venue', d.venue_id::text,
        jsonb_build_object('draftId', p_draft_id, 'targetType', d.target_type,
                           'floorId', d.floor_id),
        jsonb_build_object('author', d.author::text)
    );
END $$;

-- ------------------------------------------------------------- grants ------
GRANT SELECT, INSERT ON geofence_drafts TO presence_app;
GRANT UPDATE (status, reviewer, reviewed_at, message, published_at) ON geofence_drafts TO presence_app;

REVOKE ALL ON FUNCTION publish_geofence_draft(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publish_geofence_draft(uuid, uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION geofence_density_check(geography) TO presence_app;

COMMIT;
