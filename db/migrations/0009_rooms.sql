-- Presence — crowd-mode interest rooms
-- (PRS-SRS-001 §5 discovery surfaces; PRS-ARC-002 §5 P0 data plane)
--
-- Requirement anchors:
--   FR-44   crowd-mode transition: once a venue crosses the crowd density
--           band, discovery shifts from individual surfacing to interest
--           rooms formed from live members' declared interests
--   FR-45   room content rules: a topic (taxonomy node), a k-suppressed
--           member count, and notes from opted-in members only
--   FR-46   room posting discipline (edge-enforced): 1 note per 5 minutes
--           per member per room, first note screened (SEC-21)
--
-- Rooms are ephemeral by construction: every room artefact lives in Valkey
-- with a presence-aligned TTL — nothing about a room persists in Postgres.
-- What lives here are the two aggregate reads, both SECURITY DEFINER so the
-- edge can aggregate across members without ever reading another user's
-- profile rows through the app role.
--
-- Forward-only migration; run after 0008_moderation.sql.

BEGIN;

-- FR-44: derive the room topics of a live venue population. Exact declared
-- nodes only, sensitive nodes excluded (TR-22), groups of one dropped — a
-- room is a shared context, never a spotlight on an individual. Runs as
-- owner: the caller hands over the live member ids and gets back counts,
-- never rows.
CREATE OR REPLACE FUNCTION room_topics(p_members uuid[])
RETURNS TABLE (node_id text, members bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT pi.node_id, count(DISTINCT pi.user_id) AS members
      FROM profile_interests pi
      JOIN taxonomy_nodes tn ON tn.node_id = pi.node_id
     WHERE pi.user_id = ANY(p_members)
       AND NOT tn.sensitive
     GROUP BY pi.node_id
    HAVING count(DISTINCT pi.user_id) >= 2
     ORDER BY members DESC, pi.node_id
$$;

-- FR-13 fix: the popularity endpoint aggregated profile_interests through
-- the app role, where the profile_owner RLS policy hides every row except
-- the caller's own — the count was always zero. Same aggregate, same
-- closure semantics (no self-hop in taxonomy_closure, hence the OR), now
-- running as owner like every other cross-user aggregate.
CREATE OR REPLACE FUNCTION interest_popularity(p_node text, p_members uuid[])
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT count(DISTINCT pi.user_id)
      FROM profile_interests pi
      LEFT JOIN taxonomy_closure tc ON tc.node_id = pi.node_id
     WHERE (pi.node_id = p_node OR tc.ancestor_id = p_node)
       AND pi.user_id = ANY(p_members)
$$;

REVOKE ALL ON FUNCTION room_topics(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION interest_popularity(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION room_topics(uuid[]) TO presence_app;
GRANT EXECUTE ON FUNCTION interest_popularity(text, uuid[]) TO presence_app;

COMMIT;
