-- Presence — geofence QA workflow (GeoLibre console)
-- (PRS-SRS-001 §9 TECH-24; ADR-0008)
--
-- Requirement anchors:
--   TECH-24 the MapLibre + GeoLibre + PostGIS stack ships with a QA
--           workflow, not just an editor: polygons are quality-gated at
--           publish time and the live estate is auditable afterwards
--   TR-41   authoring + four-eyes + density verification (0017) — this
--           migration strengthens the publish gate and adds the audit side
--   FR-90   attribution joins presence cells against venue polygons;
--           overlapping polygons would make that join ambiguous
--
-- TR-41 built the authoring half: drafts, second-person review, density
-- verification, and a single DB-final publish path. What it did not do is
-- stop two venues claiming the same ground, or give the console a way to
-- audit the estate after publish. This migration closes both gaps:
--
--   1. geofence_overlap_check() — candidate polygon vs every OTHER
--      venue's live geofence; intersections over 10 m² are conflicts
--      (below that it is survey noise or a shared property line). Floor
--      polygons are exempt: floors legitimately nest inside their venue.
--   2. publish_geofence_draft() re-verified with the overlap gate — a
--      venue-target draft cannot publish over another venue's ground.
--   3. geofence_qa_report() — the post-publish estate audit behind the
--      console QA dashboard: coverage, density re-verification, overlap
--      conflicts, geometry version, drafts in flight.
--
-- Forward-only migration; run after 0022_jit_elevation.sql.

BEGIN;

-- ------------------------------------------------------ overlap check ------
CREATE OR REPLACE FUNCTION geofence_overlap_check(p_polygon geography, p_venue_id uuid)
RETURNS TABLE(venue_id uuid, intersection_m2 double precision)
    LANGUAGE sql STABLE AS $$
    SELECT v.venue_id, ST_Area(ST_Intersection(v.geofence, p_polygon))
      FROM venues v
     WHERE v.geofence IS NOT NULL
       AND v.venue_id <> p_venue_id
       AND ST_Intersects(v.geofence, p_polygon)
       AND ST_Area(ST_Intersection(v.geofence, p_polygon)) > 10
     ORDER BY 2 DESC
$$;

-- ------------------------------------------------------------- publish -----
-- Same contract as 0017 — row lock, state check, four-eyes, density gate,
-- canonical write, audit — plus the overlap gate for venue targets.
CREATE OR REPLACE FUNCTION publish_geofence_draft(p_draft_id uuid, p_reviewer uuid)
RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    d geofence_drafts%ROWTYPE;
    v_density text;
    v_conflict uuid;
    v_conflict_m2 double precision;
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
    -- TECH-24 QA: a venue polygon may not claim ground another venue
    -- already owns — overlapping geofences make presence attribution
    -- ambiguous (FR-90). Floors are exempt: they nest inside their venue.
    IF d.target_type = 'venue' THEN
        SELECT o.venue_id, o.intersection_m2 INTO v_conflict, v_conflict_m2
          FROM geofence_overlap_check(d.polygon, d.venue_id) o
         LIMIT 1;
        IF v_conflict IS NOT NULL THEN
            RAISE EXCEPTION 'geofence overlaps venue % by % m2',
                v_conflict, round(v_conflict_m2::numeric, 1);
        END IF;
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

-- ------------------------------------------------------------ QA report ----
-- The estate audit behind the console QA dashboard. Definer so it can
-- read across venues and drafts; gated on the venue-ops GUC like the
-- console routes that call it.
CREATE OR REPLACE FUNCTION geofence_qa_report()
RETURNS TABLE(
    venue_id uuid,
    has_geofence boolean,
    density_error text,
    overlap_conflicts integer,
    geofence_version integer,
    open_drafts integer
)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_venue_ops() THEN
        RAISE EXCEPTION 'geofence QA report requires the venue-ops role';
    END IF;
    RETURN QUERY
    SELECT v.venue_id,
           (v.geofence IS NOT NULL),
           CASE WHEN v.geofence IS NULL THEN NULL::text
                ELSE geofence_density_check(v.geofence) END,
           (SELECT count(*)::integer
              FROM geofence_overlap_check(v.geofence, v.venue_id) o),
           v.geofence_version,
           (SELECT count(*)::integer
              FROM geofence_drafts d
             WHERE d.venue_id = v.venue_id
               AND d.status IN ('draft', 'in_review', 'approved'))
      FROM venues v
     ORDER BY v.venue_id;
END $$;

-- ------------------------------------------------------------- grants ------
REVOKE ALL ON FUNCTION geofence_overlap_check(geography, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geofence_overlap_check(geography, uuid) TO presence_app;
REVOKE ALL ON FUNCTION geofence_qa_report() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geofence_qa_report() TO presence_app;

COMMIT;
