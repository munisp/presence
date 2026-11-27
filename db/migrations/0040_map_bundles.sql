-- Presence — next-gen maps: the static-tile bundle registry and the
-- venues-near-cell read model (SRS Addendum 001: AMD-MAP-02/05)
--
-- Requirement anchors:
--   TR-44     static-tile serving: tiles are STATIC files rendered offline
--             by scripts/build_tiles.py (AMD-MAP-01) and served by nginx
--             (AMD-MAP-06); no runtime tile server exists. This migration
--             is the governance half — the registry that decides WHICH
--             rendered bundle the platform serves, so a basemap change is
--             a governed publication, never a file copy
--   AMD-MAP-02  map_tile_bundles is the versioned registry: a bundle is
--             registered draft (manifest hash pinned at registration),
--             published by venue-ops (exactly one published bundle —
--             partial unique index — and publication is version-monotonic,
--             so a stale render can never displace a newer one), and a
--             superseded bundle goes archived with its serving record
--             intact. Every transition appends to map_tile_bundle_events
--             (append-only)
--   AMD-MAP-05  venues_near_cell is the member map's read model: the
--             member's own r9 presence cell (TR-29 — the cell they already
--             publish, never coordinates) resolves to the partner venues
--             whose published geofence intersects the cell's k=1 disk.
--             The projection carries venue identity and geofence geometry
--             (already member-visible through check-in), never another
--             member's presence
--
-- Forward-only migration; run after 0039_whatsapp.sql.

BEGIN;

-- ------------------------------------------------------------ AMD-MAP-02 --

CREATE TABLE map_tile_bundles (
    bundle_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Semver-ish, dots and digits only — lexicographic-safe per segment in
    -- the definer's numeric comparison.
    version         text NOT NULL UNIQUE
                    CHECK (version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'),
    label           text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
    -- Serving footprint: tiles outside this bbox do not exist.
    bbox            geography(Polygon, 4326) NOT NULL,
    min_zoom        integer NOT NULL CHECK (min_zoom BETWEEN 0 AND 22),
    max_zoom        integer NOT NULL CHECK (max_zoom BETWEEN 0 AND 22),
    tile_count      integer NOT NULL CHECK (tile_count > 0),
    -- sha256 over the sorted (path, sha256) tile index, emitted by the
    -- builder; pinning it here means publication attests to exact bytes.
    tiles_sha256    text NOT NULL CHECK (tiles_sha256 ~ '^[0-9a-f]{64}$'),
    attribution     text NOT NULL CHECK (char_length(attribution) BETWEEN 1 AND 240),
    state           text NOT NULL DEFAULT 'draft'
                    CHECK (state IN ('draft', 'published', 'archived')),
    registered_by   uuid NOT NULL REFERENCES users (user_id),
    published_by    uuid REFERENCES users (user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    archived_at     timestamptz,
    CHECK (min_zoom <= max_zoom),
    CHECK (state <> 'published' OR (published_by IS NOT NULL AND published_at IS NOT NULL))
);

-- TR-44: exactly one serving bundle at a time.
CREATE UNIQUE INDEX map_tile_bundles_one_published
    ON map_tile_bundles ((state)) WHERE state = 'published';

CREATE TABLE map_tile_bundle_events (
    event_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bundle_id   uuid NOT NULL REFERENCES map_tile_bundles (bundle_id),
    event       text NOT NULL
                CHECK (event IN ('registered', 'published', 'archived', 'superseded')),
    actor       uuid NOT NULL REFERENCES users (user_id),
    detail      jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The registry is definer-only: members never read rows directly; they get
-- the active manifest through active_tile_manifest() (AMD-MAP-05). Console
-- reads go through the same definer under the venue-ops gate.
ALTER TABLE map_tile_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_tile_bundle_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON map_tile_bundles FROM PUBLIC;
REVOKE ALL ON map_tile_bundle_events FROM PUBLIC;

-- Register a rendered bundle as a draft. The venue-ops gate is the batch-63
-- NULL-safe form; the draft carries the builder's manifest hash verbatim.
CREATE OR REPLACE FUNCTION register_tile_bundle(
    p_version text, p_label text, p_bbox geometry,
    p_min_zoom integer, p_max_zoom integer, p_tile_count integer,
    p_tiles_sha256 text, p_attribution text
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_actor uuid := current_setting('app.user_id', true)::uuid;
    v_id uuid;
BEGIN
    IF current_setting('app.venue_ops', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'venue-ops gate required' USING ERRCODE = '42501';
    END IF;
    INSERT INTO map_tile_bundles
        (version, label, bbox, min_zoom, max_zoom, tile_count,
         tiles_sha256, attribution, registered_by)
    VALUES
        (p_version, p_label, p_bbox::geography, p_min_zoom, p_max_zoom,
         p_tile_count, p_tiles_sha256, p_attribution, v_actor)
    RETURNING bundle_id INTO v_id;
    INSERT INTO map_tile_bundle_events (bundle_id, event, actor, detail)
    VALUES (v_id, 'registered', v_actor,
            jsonb_build_object('version', p_version));
    RETURN v_id;
END;
$$;

-- Publish a draft: version-monotonic against the serving bundle, one
-- published row by the partial unique index, the superseded bundle is
-- archived in the same transaction with its own event pair.
CREATE OR REPLACE FUNCTION publish_tile_bundle(p_bundle_id uuid)
    RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_actor uuid := current_setting('app.user_id', true)::uuid;
    v_bundle map_tile_bundles%ROWTYPE;
    v_current map_tile_bundles%ROWTYPE;
    v_parts int[];
    v_cparts int[];
BEGIN
    IF current_setting('app.venue_ops', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'venue-ops gate required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_bundle FROM map_tile_bundles
     WHERE bundle_id = p_bundle_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'unknown';
    END IF;
    IF v_bundle.state <> 'draft' THEN
        RETURN 'not_draft';
    END IF;
    SELECT * INTO v_current FROM map_tile_bundles
     WHERE state = 'published' FOR UPDATE;
    IF FOUND THEN
        v_parts := ARRAY(SELECT unnest(string_to_array(v_bundle.version, '.'))::int);
        v_cparts := ARRAY(SELECT unnest(string_to_array(v_current.version, '.'))::int);
        -- Version-monotonic: publication can only move the map forward.
        IF (v_parts[1], v_parts[2], v_parts[3])
           <= (v_cparts[1], v_cparts[2], v_cparts[3]) THEN
            RETURN 'version_not_monotonic';
        END IF;
        UPDATE map_tile_bundles
           SET state = 'archived', archived_at = now()
         WHERE bundle_id = v_current.bundle_id;
        INSERT INTO map_tile_bundle_events (bundle_id, event, actor, detail)
        VALUES (v_current.bundle_id, 'superseded', v_actor,
                jsonb_build_object('by_version', v_bundle.version));
    END IF;
    UPDATE map_tile_bundles
       SET state = 'published', published_by = v_actor, published_at = now()
     WHERE bundle_id = p_bundle_id;
    INSERT INTO map_tile_bundle_events (bundle_id, event, actor, detail)
    VALUES (p_bundle_id, 'published', v_actor,
            jsonb_build_object('version', v_bundle.version,
                               'supersedes', v_current.version));
    RETURN 'published';
END;
$$;

-- The member-facing read: the serving bundle's manifest, or NULL when no
-- bundle is published (clients stay on their last cached manifest — the
-- AMD-MAP-03 cache contract — and a fresh install shows the geometry-only
-- surface, never a broken one).
CREATE OR REPLACE FUNCTION active_tile_manifest()
    RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
    SELECT jsonb_build_object(
        'bundleId', b.bundle_id,
        'version', b.version,
        'label', b.label,
        'bbox', ST_AsGeoJSON(b.bbox::geometry)::jsonb,
        'minZoom', b.min_zoom,
        'maxZoom', b.max_zoom,
        'tileCount', b.tile_count,
        'tilesSha256', b.tiles_sha256,
        'attribution', b.attribution,
        'urlTemplate', '/tiles/{z}/{x}/{y}.png',
        'vectorsUrl', '/tiles/vectors.json',
        'publishedAt', b.published_at)
      FROM map_tile_bundles b
     WHERE b.state = 'published';
$$;

-- The console-facing registry read (venue-ops gated): every bundle with its
-- event count, newest first.
CREATE OR REPLACE FUNCTION list_tile_bundles()
    RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
BEGIN
    IF current_setting('app.venue_ops', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'venue-ops gate required' USING ERRCODE = '42501';
    END IF;
    RETURN (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'bundleId', b.bundle_id,
                   'version', b.version,
                   'label', b.label,
                   'state', b.state,
                   'minZoom', b.min_zoom,
                   'maxZoom', b.max_zoom,
                   'tileCount', b.tile_count,
                   'tilesSha256', b.tiles_sha256,
                   'attribution', b.attribution,
                   'publishedAt', b.published_at,
                   'bbox', ST_AsGeoJSON(b.bbox::geometry)::jsonb)
                   ORDER BY b.created_at DESC), '[]'::jsonb)
          FROM map_tile_bundles b);
END;
$$;

-- ------------------------------------------------------------ AMD-MAP-04 --

-- The console estate map's read model: every published venue geofence as
-- GeoJSON, venue-ops gated. Geometries are operational, not personal —
-- but the read still rides the gate so the estate view is a workforce
-- surface by construction.
CREATE OR REPLACE FUNCTION estate_geofence_geojson()
    RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
BEGIN
    IF current_setting('app.venue_ops', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'venue-ops gate required' USING ERRCODE = '42501';
    END IF;
    RETURN (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'venueId', v.venue_id,
                   'label', v.name,
                   'geofence', ST_AsGeoJSON(v.geofence::geometry)::jsonb)
                   ORDER BY v.name), '[]'::jsonb)
          FROM venues v
         WHERE v.active AND v.geofence IS NOT NULL);
END;
$$;

-- ------------------------------------------------------------ AMD-MAP-05 --

-- Venues near a presence cell: the member sends the r9 cell they already
-- publish (TR-29); the definer resolves the k=1 disk and returns partner
-- venues whose published geofence intersects it, capped at 40, nearest
-- first. h3-pg is canonical (TR-16); the rehearsal stub provides the same
-- signatures.
CREATE OR REPLACE FUNCTION venues_near_cell(p_cell h3index, p_limit integer DEFAULT 40)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
DECLARE
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 40), 1), 40);
BEGIN
    IF p_cell IS NULL OR NOT h3_is_valid_cell(p_cell) THEN
        RETURN '[]'::jsonb;
    END IF;
    RETURN (
        SELECT COALESCE(jsonb_agg(row_payload ORDER BY distance_m), '[]'::jsonb)
          FROM (
            SELECT jsonb_build_object(
                       'venueId', v.venue_id,
                       'label', v.name,
                       'geofence', ST_AsGeoJSON(v.geofence::geometry)::jsonb,
                       'floors', floor_map.floor_ids) AS row_payload,
                   ST_Distance(v.geofence,
                               h3_cell_to_latlng(p_cell)::geography) AS distance_m
              FROM venues v
              LEFT JOIN LATERAL (
                     SELECT jsonb_agg(vf.floor_id ORDER BY vf.floor_id) AS floor_ids
                       FROM venue_floors vf
                      WHERE vf.venue_id = v.venue_id) floor_map ON true
             WHERE v.active
               AND v.geofence IS NOT NULL
               AND EXISTS (
                     SELECT 1
                       FROM h3_grid_disk(p_cell, 1) AS disk(cell)
                      WHERE h3_latlng_to_cell(
                                ST_Centroid(v.geofence::geometry), 9)
                            = disk.cell)
             ORDER BY distance_m
             LIMIT v_limit) AS near);
END;
$$;

REVOKE ALL ON FUNCTION register_tile_bundle(text, text, geometry, integer,
    integer, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION publish_tile_bundle(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION active_tile_manifest() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_tile_bundles() FROM PUBLIC;
REVOKE ALL ON FUNCTION estate_geofence_geojson() FROM PUBLIC;
REVOKE ALL ON FUNCTION venues_near_cell(h3index, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_tile_bundle(text, text, geometry, integer,
    integer, integer, text, text) TO presence_app;
GRANT EXECUTE ON FUNCTION publish_tile_bundle(uuid) TO presence_app;
GRANT EXECUTE ON FUNCTION active_tile_manifest() TO presence_app;
GRANT EXECUTE ON FUNCTION list_tile_bundles() TO presence_app;
GRANT EXECUTE ON FUNCTION estate_geofence_geojson() TO presence_app;
GRANT EXECUTE ON FUNCTION venues_near_cell(h3index, integer) TO presence_app;

COMMIT;
