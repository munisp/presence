-- Presence — taxonomy CMS: governed releases with draft/review/publish and
-- one-action rollback (PRS-SRS-001 §4 taxonomy; PRS-ARC-002 §5 P0 data plane)
--
-- Requirement anchors:
--   FR-59    taxonomy changes ship only through the CMS: draft → review
--            (second person) → publish → one-action rollback
--   TR-20    every published release carries a monotonic version, full
--            provenance and a diff summary
--   TR-17    the hierarchy stays acyclic and ≤5 levels — by construction:
--            new nodes may only extend an existing path, and re-parenting
--            is not an operation
--   TR-18    the closure is rebuilt on every publish/rollback
--   TR-22    embeddings (FR-09/TECH-09) are derived state — re-synced from
--            taxonomy_nodes on every release mutation; sensitive and
--            redirected nodes never hold a vector
--
-- Live taxonomy tables stay SELECT-only to the app role outside the CMS:
-- a write-guard trigger refuses any presence_app write unless the
-- app.taxonomist GUC is set inside the CMS transaction.
--
-- Forward-only migration; run after 0011_linking.sql.

BEGIN;

-- ------------------------------------------------------------ TR-20 --------
CREATE SEQUENCE taxonomy_release_version;

CREATE TABLE taxonomy_releases (
    release_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version      bigint UNIQUE,              -- assigned at publish only
    status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','in_review','approved','published','rolled_back')),
    author       uuid NOT NULL,              -- workforce subject
    reviewer     uuid,                       -- must differ from author (edge-enforced)
    message      text NOT NULL,
    summary      jsonb,                      -- TR-20 diff summary, set at publish
    snapshot     jsonb,                      -- full pre-publish state (rollback basis)
    published_by uuid,
    rolled_back_by uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    submitted_at timestamptz,
    reviewed_at  timestamptz,
    published_at timestamptz,
    rolled_back_at timestamptz
);

CREATE TABLE taxonomy_release_ops (
    release_id uuid NOT NULL REFERENCES taxonomy_releases (release_id) ON DELETE CASCADE,
    op_seq     integer NOT NULL,
    op         jsonb NOT NULL,
    PRIMARY KEY (release_id, op_seq)
);

-- Workforce console only: no consumer path touches these tables.
CREATE OR REPLACE FUNCTION app_taxonomist() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.taxonomist', true) = 'on' $$;

ALTER TABLE taxonomy_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE taxonomy_release_ops ENABLE ROW LEVEL SECURITY;

CREATE POLICY taxonomy_releases_console ON taxonomy_releases
    FOR ALL USING (app_taxonomist()) WITH CHECK (app_taxonomist());
CREATE POLICY taxonomy_release_ops_console ON taxonomy_release_ops
    FOR ALL USING (app_taxonomist()) WITH CHECK (app_taxonomist());

-- --------------------------------------------------- write guard (FR-59) ---
-- The app role holds write grants so the CMS can publish, but every write
-- outside a CMS transaction is refused. Seeds and migrations run as the
-- owner role and are unaffected.
CREATE OR REPLACE FUNCTION taxonomy_write_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF current_user = 'presence_app'
       AND current_setting('app.taxonomist', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'taxonomy writes require the taxonomy CMS (FR-59)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER taxonomy_nodes_write_guard
    BEFORE INSERT OR UPDATE OR DELETE ON taxonomy_nodes
    FOR EACH ROW EXECUTE FUNCTION taxonomy_write_guard();
CREATE TRIGGER taxonomy_links_write_guard
    BEFORE INSERT OR UPDATE OR DELETE ON taxonomy_links
    FOR EACH ROW EXECUTE FUNCTION taxonomy_write_guard();
CREATE TRIGGER taxonomy_closure_write_guard
    BEFORE INSERT OR UPDATE OR DELETE ON taxonomy_closure
    FOR EACH ROW EXECUTE FUNCTION taxonomy_write_guard();
CREATE TRIGGER taxonomy_embeddings_write_guard
    BEFORE INSERT OR UPDATE OR DELETE ON taxonomy_node_embeddings
    FOR EACH ROW EXECUTE FUNCTION taxonomy_write_guard();

-- ------------------------------------------------------------ TR-18 --------
-- Rebuild the materialised closure exactly as the seed pipeline does:
-- ancestors only, hops 1..4, decay = 0.55^hops (TR-04).
CREATE OR REPLACE FUNCTION rebuild_taxonomy_closure() RETURNS void
    LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM taxonomy_closure;
    INSERT INTO taxonomy_closure (node_id, ancestor_id, hops, decay)
    WITH RECURSIVE walk (node_id, ancestor_id, hops) AS (
        SELECT n.node_id, n.parent_id, 1
          FROM taxonomy_nodes n
         WHERE n.parent_id IS NOT NULL
        UNION
        SELECT w.node_id, p.parent_id, w.hops + 1
          FROM walk w
          JOIN taxonomy_nodes p ON p.node_id = w.ancestor_id
         WHERE p.parent_id IS NOT NULL AND w.hops < 4
    )
    SELECT node_id, ancestor_id, hops, (0.55::double precision ^ hops)::real
      FROM walk;
END $$;

-- ------------------------------------------------- rollback safety ---------
-- One-action rollback deletes the nodes the rolled-back release added. That
-- is only legal while nothing user-facing references them; this count runs
-- as owner because profile_interests and group_table_interests are RLS'd
-- away from the console GUC (FR-13 discipline).
CREATE OR REPLACE FUNCTION taxonomy_rollback_reference_count(p_node_ids text[])
RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    n bigint;
BEGIN
    SELECT (
        SELECT count(*) FROM profile_interests WHERE node_id = ANY (p_node_ids)
    ) + (
        SELECT count(*) FROM group_table_interests WHERE node_id = ANY (p_node_ids)
    ) INTO n;
    RETURN n;
END $$;

-- ------------------------------------------------------------ grants -------
GRANT SELECT, INSERT, UPDATE ON taxonomy_releases TO presence_app;
GRANT SELECT, INSERT, DELETE ON taxonomy_release_ops TO presence_app;
GRANT USAGE ON SEQUENCE taxonomy_release_version TO presence_app;

-- CMS write path; every statement is additionally guarded by the trigger.
GRANT INSERT, UPDATE, DELETE ON taxonomy_nodes TO presence_app;
GRANT INSERT, UPDATE, DELETE ON taxonomy_links TO presence_app;
GRANT INSERT, DELETE ON taxonomy_closure TO presence_app;
GRANT INSERT, DELETE ON taxonomy_node_embeddings TO presence_app;

REVOKE ALL ON FUNCTION rebuild_taxonomy_closure() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rebuild_taxonomy_closure() TO presence_app;
REVOKE ALL ON FUNCTION taxonomy_rollback_reference_count(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION taxonomy_rollback_reference_count(text[]) TO presence_app;

COMMIT;
