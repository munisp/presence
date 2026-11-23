#!/usr/bin/env python3
"""FR-59/TR-20 acceptance criteria for the taxonomy CMS.

Pins: the release state machine (draft → in_review → approved → published →
rolled_back), the second-person review rule, the monotonic version sequence,
the snapshot as rollback basis, latest-published-only rollback, the closure
rebuild matching the seed formula (TR-18), embeddings as derived state
(TR-22), the write-guard triggers that keep live taxonomy SELECT-only to
the app role outside the CMS (FR-59), no node-deletion operation, TR-17
safety by construction (path-extension only), console-only RLS, audit rows
on publish and rollback (FR-60), and the deploy wiring.

Behavioural coverage of the ops lib lives in services/edge/test/taxonomy.test.ts;
route/contract coverage is enforced globally by test_openapi_contract.py.

Run: python3 -m pytest tests/test_taxonomy_cms.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0012_taxonomy_cms.sql").read_text()
LIB = (ROOT / "services/edge/src/taxonomy.ts").read_text()
ROUTE = (ROOT / "services/edge/src/routes/taxonomy.ts").read_text()
AUTH = (ROOT / "services/edge/src/auth.ts").read_text()
APP = (ROOT / "services/edge/src/app.ts").read_text()
OPENAPI = (ROOT / "docs/api/openapi.yaml").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
TAXONOMY_SEED = (ROOT / "db/seed/taxonomy.sql").read_text()


def sql(text: str) -> str:
    return re.sub(r"--[^\n]*", "", text)


# ------------------------------------------------------------ FR-59 --------

def test_fr59_release_state_machine() -> None:
    m = re.search(r"CHECK \(status IN \(([^)]+)\)\)", MIGRATION)
    assert m is not None
    assert re.findall(r"'(\w+)'", m.group(1)) == ["draft", "in_review", "approved", "published", "rolled_back"]


def test_fr59_every_console_route_is_gated() -> None:
    routes = re.findall(r'app\.(get|post)\(\s*"(/v1/taxonomy/[^"]+)"', ROUTE)
    assert len(routes) == 7, f"expected 7 console routes, found {routes}"
    assert ROUTE.count("preHandler: requireTaxonomist") == 7


def test_fr59_second_person_review() -> None:
    approve = ROUTE.split('"/v1/taxonomy/releases/:releaseId/approve"')[1].split("app.post(")[0]
    assert "author <> $2" in approve, "the author can never approve their own release"
    assert "review requires a second person" in approve


def test_fr59_no_node_deletion_operation() -> None:
    assert "delete_node" not in LIB, "history is deprecated, never destroyed"
    op_types = re.findall(r'\| \{ type: "(\w+)"', LIB)
    assert set(op_types) == {"add_node", "edit_label", "set_sensitive", "deprecate", "add_link", "remove_link"}


def test_fr59_rollback_is_latest_published_only() -> None:
    rollback = ROUTE.split('"/v1/taxonomy/releases/:releaseId/rollback"')[1]
    assert "max(version)" in rollback
    assert "status = 'published'" in rollback
    assert "only the latest published release can be rolled back" in rollback


def test_fr59_rollback_never_touches_referenced_rows() -> None:
    rollback = ROUTE.split('"/v1/taxonomy/releases/:releaseId/rollback"')[1]
    assert "taxonomy_rollback_reference_count" in rollback
    assert "rollback blocked" in rollback
    # Delta restore: only nodes the release added are deleted.
    assert re.search(r"DELETE FROM taxonomy_nodes WHERE node_id = ANY", rollback)
    assert "DELETE FROM taxonomy_nodes;" not in rollback, "no blanket node wipe"
    assert "DELETE FROM taxonomy_links;" not in rollback


def test_fr59_write_guard_keeps_live_tables_select_only() -> None:
    guard = MIGRATION.split("FUNCTION taxonomy_write_guard()")[1].split("END $$;")[0]
    assert "current_user = 'presence_app'" in guard
    assert "current_setting('app.taxonomist', true) IS DISTINCT FROM 'on'" in guard
    for table in ("taxonomy_nodes", "taxonomy_links", "taxonomy_closure", "taxonomy_node_embeddings"):
        assert f"BEFORE INSERT OR UPDATE OR DELETE ON {table}" in MIGRATION, table


def test_fr59_tr17_safety_by_construction() -> None:
    add = LIB.split('case "add_node": {')[1].split("return { type:")[0]
    assert "nodeId.startsWith(`${parentId}.`)" in add, "new ids must extend the parent path"
    assert 'includes(".")' in add, "exactly one segment deeper"
    apply_block = LIB.split("export function applyOps")[1]
    assert "depth > TAXONOMY_DEPTH_MAX" in apply_block
    assert "parentId" not in re.findall(r"case \"edit_label\".*?break;", apply_block, re.S)[0], "re-parenting is not an operation"


def test_fr59_publish_and_rollback_are_audited() -> None:
    assert "'taxonomy.release.published'" in ROUTE
    assert "'taxonomy.release.rolled_back'" in ROUTE


def test_fr59_console_tables_are_rls_locked() -> None:
    plain = sql(MIGRATION)
    assert "CREATE POLICY taxonomy_releases_console ON taxonomy_releases" in plain
    assert "CREATE POLICY taxonomy_release_ops_console ON taxonomy_release_ops" in plain
    assert "app_taxonomist()" in plain


# ------------------------------------------------------------ TR-20 --------

def test_tr20_monotonic_version_from_sequence() -> None:
    assert "CREATE SEQUENCE taxonomy_release_version" in MIGRATION
    assert "version = nextval('taxonomy_release_version')" in ROUTE
    assert "GRANT USAGE ON SEQUENCE taxonomy_release_version TO presence_app" in MIGRATION
    assert re.search(r"version\s+bigint UNIQUE", MIGRATION), "version assigned at publish only"


def test_tr20_provenance_and_diff_summary() -> None:
    for col in ("author", "reviewer", "message", "summary", "snapshot", "published_by", "rolled_back_by"):
        assert re.search(rf"\b{col}\b", MIGRATION), col
    assert "diffSummary(ops)" in ROUTE
    publish = ROUTE.split('"/v1/taxonomy/releases/:releaseId/publish"')[1].split("app.post(")[0]
    assert "snapshot" in publish, "the pre-publish state is the rollback basis"


def test_tr18_closure_rebuild_matches_seed_formula() -> None:
    fn = MIGRATION.split("FUNCTION rebuild_taxonomy_closure()")[1].split("END $$;")[0]
    assert "0.55::double precision ^ hops" in fn
    assert "w.hops < 4" in fn, "ancestors up to four hops (TR-04)"
    # Seed formula check: decay values in the governed seed are 0.55^hops
    # stored as Postgres real (float4).
    import math
    import struct
    rows = [
        m for line in TAXONOMY_SEED.splitlines() if "taxonomy_closure" in line
        for m in re.findall(r"VALUES \('([^']+)', '([^']+)', (\d), ([0-9.]+)\)", line)
    ]
    assert rows, "seed closure rows expected"
    for _nid, _anc, hops, decay in rows[:200]:
        expected = struct.unpack("f", struct.pack("f", math.pow(0.55, int(hops))))[0]
        assert abs(float(decay) - expected) < 1e-6


def test_tr22_embeddings_are_derived_state() -> None:
    resync = ROUTE.split("async function resyncEmbeddings")[1].split("export function")[0]
    assert "DELETE FROM taxonomy_node_embeddings" in resync
    assert "node.sensitive || node.redirectTo !== null" in resync, (
        "sensitive and redirected nodes never hold a vector (TR-22)"
    )
    assert "EMBEDDER_ID" in resync


def test_rebuild_reference_count_is_security_definer() -> None:
    fn = MIGRATION.split("FUNCTION taxonomy_rollback_reference_count")[1].split("END $$;")[0]
    assert "SECURITY DEFINER" in fn, "profile interests are RLS-hidden from the console (FR-13 discipline)"
    assert "profile_interests" in fn and "group_table_interests" in fn


# ------------------------------------------------------------ wiring -------

def test_taxonomy_routes_registered_and_auth_helpers_exist() -> None:
    assert 'import { registerTaxonomyRoutes } from "./routes/taxonomy.js";' in APP
    assert "registerTaxonomyRoutes(authed, ctx);" in APP
    assert "export async function requireTaxonomist" in AUTH
    assert "export async function withTaxonomist" in AUTH
    assert 'requireWorkforceRole(req, reply, "taxonomist")' in AUTH
    assert "set_config('app.taxonomist'" in AUTH or "withGuc(pool, \"app.taxonomist\"" in AUTH


def test_openapi_documents_taxonomy_cms() -> None:
    for path in (
        "/v1/taxonomy/releases:",
        "/v1/taxonomy/releases/{releaseId}:",
        "/v1/taxonomy/releases/{releaseId}/submit:",
        "/v1/taxonomy/releases/{releaseId}/approve:",
        "/v1/taxonomy/releases/{releaseId}/publish:",
        "/v1/taxonomy/releases/{releaseId}/rollback:",
    ):
        assert path in OPENAPI, path


def test_deploy_mounts_cms_migration() -> None:
    assert "14_taxonomy_cms.sql" in COMPOSE and "0012_taxonomy_cms.sql" in COMPOSE
    assert "14_taxonomy_cms.sql=db/migrations/0012_taxonomy_cms.sql" in K8S_README
