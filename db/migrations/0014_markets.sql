-- Presence — per-market resolution calibration in configuration
-- (PRS-SRS-001 §3; PRS-ARC-002 §5 P0 data plane)
--
-- Requirement anchors:
--   TR-37    the storage-resolution ladder is per-market configuration, not
--            code constants — each market calibrates independently and
--            changes propagate without a deploy (edge caches for 60 s)
--   TR-16    h3-pg native column type (TECH-04): market centres are stored
--            as h3index and market resolution runs h3_cell_to_parent in the
--            database
--   BR-01    P0 is single-metro — at most one active market, enforced by
--            the partial unique index
--
-- Forward-only migration; run after 0013_telemetry.sql. Requires h3-pg —
-- the deploy postgres image builds it in (deploy/postgres).

BEGIN;

CREATE EXTENSION IF NOT EXISTS h3;

CREATE TABLE market_config (
    market_id    text PRIMARY KEY,              -- e.g. 'lagos'
    label        text NOT NULL,
    center_cell  h3index NOT NULL,              -- TR-16: native H3 column
    res_default  smallint NOT NULL CHECK (res_default BETWEEN 7 AND 11),
    res_busy     smallint NOT NULL CHECK (res_busy BETWEEN 7 AND 11),
    res_crowd    smallint NOT NULL CHECK (res_crowd BETWEEN 7 AND 11),
    busy_min_presences  integer NOT NULL CHECK (busy_min_presences > 0),
    crowd_min_presences integer NOT NULL CHECK (crowd_min_presences > busy_min_presences),
    active       boolean NOT NULL DEFAULT true,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (res_default <= res_busy AND res_busy <= res_crowd)
);
-- BR-01: single-metro P0 — at most one active market until multi-market.
CREATE UNIQUE INDEX market_config_single_active
    ON market_config ((active)) WHERE active;

-- Lagos launch market; the ladder matches the governed TR-12/14 defaults,
-- so existing behaviour is unchanged on day one.
INSERT INTO market_config
    (market_id, label, center_cell, res_default, res_busy, res_crowd,
     busy_min_presences, crowd_min_presences)
VALUES
    ('lagos', 'Lagos', '825887fffffffff'::h3index, 9, 10, 11, 2000, 10000);

-- TR-37: resolve the market covering a presence cell. Comparison runs at
-- the market centre's own resolution through the native h3-pg operators —
-- a Lagos res-2 centre covers every cell whose res-2 parent it is.
CREATE OR REPLACE FUNCTION market_for_cell(p_cell h3index) RETURNS text
    LANGUAGE sql STABLE AS $$
    SELECT market_id
      FROM market_config
     WHERE active
       AND h3_cell_to_parent(p_cell, h3_get_resolution(center_cell)) = center_cell
     LIMIT 1
$$;

GRANT SELECT ON market_config TO presence_app;

REVOKE ALL ON FUNCTION market_for_cell(h3index) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION market_for_cell(h3index) TO presence_app;

COMMIT;
