#!/usr/bin/env python3
"""FR-09/TECH-09 acceptance criteria for free-text entity linking.

Pins: the pgvector extension and HNSW cosine index; the search function's
sensitive/redirect exclusions (TR-22) at query time as well as seed time;
the per-row embedder identity; the route's no-write contract (per-node
confirmation goes through FR-08, never through linking); the declared-node
exclusion read under the owner GUC (FR-13 discipline); the TECH-09 boundary
— nothing in the match path may touch the linking stack; the Python/TS
embedder equivalence against the golden probes; and the deploy wiring
(postgres image builds pgvector, migration + seed mounted in both topologies).

Behavioural coverage of the lib lives in services/edge/test/linking.test.ts;
route/contract coverage is enforced globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_linking.py
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0011_linking.sql").read_text()
SEED = (ROOT / "db/seed/taxonomy_embeddings.sql").read_text()
TAXONOMY = (ROOT / "db/seed/taxonomy.sql").read_text()
LIB = (ROOT / "services/edge/src/linking.ts").read_text()
ROUTE = (ROOT / "services/edge/src/routes/linking.ts").read_text()
APP = (ROOT / "services/edge/src/app.ts").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_PG = (ROOT / "deploy/k8s/postgres.yaml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
DOCKERFILE = (ROOT / "deploy/postgres/Dockerfile").read_text()
GOLDEN = json.loads((ROOT / "services/edge/test/golden_embeddings.json").read_text())

MATCH_SRC = "\n".join(p.read_text() for p in (ROOT / "services/match/src").glob("**/*.ts"))
SCAN = (ROOT / "services/edge/src/routes/scan.ts").read_text()
PRESENCE_PY = "\n".join(p.read_text() for p in (ROOT / "presence").glob("*.py"))


def _embedder():
    spec = importlib.util.spec_from_file_location(
        "taxonomy_embedder", ROOT / "scripts/taxonomy_embedder.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ------------------------------------------------------------ TECH-09 ------

def test_tech09_pgvector_extension_and_table() -> None:
    assert "CREATE EXTENSION IF NOT EXISTS vector" in MIGRATION
    assert "CREATE TABLE taxonomy_node_embeddings" in MIGRATION
    assert "vector(384)" in MIGRATION


def test_tech09_cosine_hnsw_index() -> None:
    assert re.search(
        r"USING hnsw \(embedding vector_cosine_ops\)", MIGRATION
    ), "cosine ANN index keeps the query shape stable"


def test_tech09_never_in_the_match_path() -> None:
    for name, text in (("match service", MATCH_SRC), ("scan route", SCAN), ("presence model", PRESENCE_PY)):
        assert "link_taxonomy_nodes" not in text, name
        assert "taxonomy_node_embeddings" not in text, name
        assert "pgvector" not in text.lower(), name
    assert "linking" not in MATCH_SRC, "match service must not import the linking stack"


def test_tech09_app_role_is_read_only_on_the_search_space() -> None:
    grants = re.findall(r"GRANT (\w+(?:, \w+)*) ON taxonomy_node_embeddings TO presence_app", MIGRATION)
    assert grants == ["SELECT"], f"reference data is read-only to the app role: {grants}"


def test_tech09_postgres_image_builds_pgvector() -> None:
    assert "postgis/postgis:17-3.5-alpine" in DOCKERFILE
    assert "github.com/pgvector/pgvector.git" in DOCKERFILE
    assert re.search(r"PGVECTOR_VERSION=v\d+\.\d+\.\d+", DOCKERFILE), "pinned upstream tag"
    assert "build: ./postgres" in COMPOSE
    assert "presence/postgres:p0" in K8S_PG


# ------------------------------------------------------------ FR-09 --------

def test_fr09_query_excludes_sensitive_and_redirected_nodes() -> None:
    fn = MIGRATION.split("FUNCTION link_taxonomy_nodes")[1].split("$$;")[0]
    assert "NOT tn.sensitive" in fn, "TR-22: sensitive nodes never surface"
    assert "tn.redirect_to IS NULL" in fn, "deprecated aliases never surface"


def test_fr09_seed_excludes_sensitive_and_redirected_nodes() -> None:
    seeded = set(re.findall(r"VALUES \('([^']+)', '\[", SEED))
    rows = re.findall(
        r"INSERT INTO taxonomy_nodes \(node_id, label, parent_id, kind, sensitive, redirect_to, depth\) VALUES \('([^']+)', '[^']*', [^,]+, '[^']+', (true|false), (NULL|'[^']*')",
        TAXONOMY,
    )
    blocked = {nid for nid, sensitive, redirect in rows if sensitive == "true" or redirect != "NULL"}
    assert seeded, "seed must embed at least one node"
    assert not (seeded & blocked), f"blocked nodes in the search space: {seeded & blocked}"


def test_fr09_embedder_identity_is_versioned_per_row() -> None:
    assert "embedder  text NOT NULL" in MIGRATION
    assert 'EMBEDDER_ID = "ngram-hash-384.v1"' in LIB
    assert "'ngram-hash-384.v1'" in SEED


def test_fr09_route_never_writes_interests() -> None:
    assert "INSERT" not in ROUTE and "UPDATE profile_interests" not in ROUTE, (
        "per-node confirmation goes through the governed FR-08 endpoint; "
        "linking only proposes"
    )


def test_fr09_declared_nodes_excluded_under_owner_guc() -> None:
    assert "withRls(ctx.pg, req.userId" in ROUTE
    assert "SELECT node_id FROM profile_interests WHERE user_id = $1" in ROUTE, (
        "owner-RLS'd reads must run inside the user GUC (FR-13 discipline)"
    )
    assert "declaredIds.has(r.node_id)" in ROUTE


def test_fr09_candidate_policy() -> None:
    assert re.search(r"LINK_MAX_CANDIDATES = 5", LIB)
    assert re.search(r"LINK_MIN_SIMILARITY = 0\.15", LIB)
    assert "LINK_TEXT_MAX_LEN" in ROUTE


def test_fr09_embedder_equivalence_python_vs_golden() -> None:
    mod = _embedder()
    assert GOLDEN["embedder"] == mod.EMBEDDER_ID
    assert GOLDEN["dims"] == mod.DIMS
    for probe, expected in GOLDEN["probes"].items():
        actual = mod.embed(probe)
        assert len(actual) == len(expected)
        for a, b in zip(actual, expected):
            assert abs(a - b) <= 1e-12, f"probe drift: {probe}"


def test_fr09_seed_row_count_matches_taxonomy() -> None:
    rows = re.findall(
        r"INSERT INTO taxonomy_nodes \(node_id, label, parent_id, kind, sensitive, redirect_to, depth\) VALUES \('([^']+)', '[^']*', [^,]+, '[^']+', (true|false), (NULL|'[^']*')",
        TAXONOMY,
    )
    expected = {nid for nid, sensitive, redirect in rows if sensitive == "false" and redirect == "NULL"}
    seeded = set(re.findall(r"VALUES \('([^']+)', '\[", SEED))
    assert seeded == expected, "every linkable node has exactly one embedding"


# ------------------------------------------------------------ wiring -------

def test_linking_route_registered() -> None:
    assert 'import { registerLinkingRoutes } from "./routes/linking.js";' in APP
    assert "registerLinkingRoutes(authed, ctx);" in APP


def test_openapi_documents_linking() -> None:
    assert "/v1/profile/interests/link:" in OPENAPI
    block = OPENAPI.split("/v1/profile/interests/link:")[1].split("/v1/venues/{venueId}/checkin-tokens:")[0]
    assert "FR-09" in block and "TECH-09" in block


def test_deploy_mounts_migration_and_seed() -> None:
    assert "12_linking.sql" in COMPOSE and "0011_linking.sql" in COMPOSE
    assert "13_taxonomy_embeddings.sql" in COMPOSE and "db/seed/taxonomy_embeddings.sql" in COMPOSE
    assert "12_linking.sql=db/migrations/0011_linking.sql" in K8S_README
    assert "13_taxonomy_embeddings.sql=db/seed/taxonomy_embeddings.sql" in K8S_README
