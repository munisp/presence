-- Presence — free-text entity linking search space
-- (PRS-SRS-001 §4 profile; PRS-ARC-002 §5 P0 data plane)
--
-- Requirement anchors:
--   FR-09    free-text interest entry links phrases to taxonomy nodes and
--            proposes them for per-node confirmation — nothing is written
--            without the user confirming each node through the governed
--            interests endpoint (FR-08)
--   TECH-09  pgvector powers this linking search ONLY; it is never in the
--            match path (test-pinned: match service and scan import nothing
--            from the linking stack)
--
-- The search space is taxonomy_node_embeddings: one vector per governed,
-- non-sensitive, non-redirected node, produced by the deterministic
-- ngram-hash-384.v1 embedder (scripts/taxonomy_embedder.py). The embedder
-- id is stored per row so a future learned model is a re-seed under a new
-- id, not a schema change.
--
-- Forward-only migration; run after 0010_devices.sql. Requires the pgvector
-- extension — the deploy postgres image builds it in (deploy/postgres).

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE taxonomy_node_embeddings (
    node_id   text PRIMARY KEY REFERENCES taxonomy_nodes (node_id),
    embedding vector(384) NOT NULL,
    embedder  text NOT NULL,                 -- e.g. ngram-hash-384.v1
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- Cosine ANN over the search space; exact search would do at ~100 nodes,
-- the index keeps the query shape stable as the taxonomy grows.
CREATE INDEX taxonomy_node_embeddings_hnsw
    ON taxonomy_node_embeddings USING hnsw (embedding vector_cosine_ops);

-- FR-09: nearest linkable nodes for a query embedding. Sensitive nodes are
-- excluded again here (TR-22) even though the seed already skips them, and
-- redirect aliases never surface — the query must be safe even against a
-- hand-loaded row.
CREATE OR REPLACE FUNCTION link_taxonomy_nodes(p_embedding vector(384), p_k integer)
RETURNS TABLE (node_id text, label text, similarity real)
    LANGUAGE sql STABLE AS $$
    SELECT tn.node_id,
           tn.label,
           (1 - (tne.embedding <=> p_embedding))::real AS similarity
      FROM taxonomy_node_embeddings tne
      JOIN taxonomy_nodes tn ON tn.node_id = tne.node_id
     WHERE NOT tn.sensitive
       AND tn.redirect_to IS NULL
     ORDER BY tne.embedding <=> p_embedding
     LIMIT p_k
$$;

-- Reference data: no user rows, so no RLS — but read-only to the app role;
-- reseeds run as the migration role.
GRANT SELECT ON taxonomy_node_embeddings TO presence_app;

REVOKE ALL ON FUNCTION link_taxonomy_nodes(vector, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION link_taxonomy_nodes(vector, integer) TO presence_app;

COMMIT;
