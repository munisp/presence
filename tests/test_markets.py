#!/usr/bin/env python3
"""TR-37/TR-16 acceptance criteria for per-market resolution calibration.

Pins: the h3-pg extension and the native h3index column (TR-16); the
per-market ladder in market_config with ordering and bound CHECKs (TR-37);
the single-active-market index (BR-01); the Lagos seed equal to the
governed fallback so day-one behaviour is unchanged; market resolution via
native h3_cell_to_parent in the database; the presence route reading the
ladder from configuration with a one-minute cache instead of code
constants; the deploy image building h3-pg from a pinned tag; and the
mounts in both topologies.

Behavioural coverage of the ladder lives in services/edge/test (markets and
edge suites); no new endpoints exist, so the global contract suite is
unaffected.

Run: python3 -m pytest tests/test_markets.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = (ROOT / "db/migrations/0014_markets.sql").read_text()
LIB = (ROOT / "services/edge/src/markets.ts").read_text()
PRESENCE = (ROOT / "services/edge/src/routes/presence.ts").read_text()
DOCKERFILE = (ROOT / "deploy/postgres/Dockerfile").read_text()
COMPOSE = (ROOT / "deploy/docker-compose.yml").read_text()
K8S_README = (ROOT / "deploy/k8s/README.md").read_text()
K8S_PG = (ROOT / "deploy/k8s/postgres.yaml").read_text()


# ------------------------------------------------------------ TR-16 --------

def test_tr16_h3_extension_and_native_column() -> None:
    assert "CREATE EXTENSION IF NOT EXISTS h3" in MIGRATION
    assert re.search(r"center_cell\s+h3index NOT NULL", MIGRATION), "native h3index column (TR-16)"


def test_tr16_market_resolution_uses_native_h3_ops() -> None:
    fn = MIGRATION.split("FUNCTION market_for_cell")[1].split("$$;")[0]
    assert "h3_cell_to_parent(p_cell, h3_get_resolution(center_cell)) = center_cell" in fn
    assert "p_cell h3index" in MIGRATION.split("market_for_cell")[1].split("RETURNS")[0]


def test_tr16_deploy_image_builds_h3_pg() -> None:
    assert "github.com/uber/h3-pg.git" in DOCKERFILE
    assert re.search(r"H3PG_VERSION=v\d+\.\d+\.\d+", DOCKERFILE), "pinned upstream tag"
    assert "cmake" in DOCKERFILE, "h3-pg builds with cmake"
    assert "--recurse-submodules" in DOCKERFILE, "h3 core is vendored as a submodule"


def test_tr16_grants_are_select_only() -> None:
    grants = re.findall(r"GRANT (\w+(?:, \w+)*) ON market_config TO presence_app", MIGRATION)
    assert grants == ["SELECT"]
    assert "GRANT EXECUTE ON FUNCTION market_for_cell(h3index) TO presence_app" in MIGRATION


# ------------------------------------------------------------ TR-37 --------

def test_tr37_ladder_columns_are_calibrated_per_market() -> None:
    for col in ("res_default", "res_busy", "res_crowd", "busy_min_presences", "crowd_min_presences"):
        assert re.search(rf"\b{col}\b", MIGRATION), col
    assert "CHECK (res_default <= res_busy AND res_busy <= res_crowd)" in MIGRATION
    assert "crowd_min_presences > busy_min_presences" in MIGRATION


def test_tr37_single_active_market_enforced() -> None:
    assert re.search(
        r"CREATE UNIQUE INDEX market_config_single_active\s+ON market_config \(\(active\)\) WHERE active",
        MIGRATION,
    ), "BR-01 single-metro P0"


def test_tr37_lagos_seed_matches_governed_fallback() -> None:
    seed = MIGRATION.split("('lagos', 'Lagos'")[1].split(");")[0]
    for value in ("9", "10", "11", "2000", "10000"):
        assert re.search(rf"\b{value}\b", seed), f"seed ladder value {value}"
    fallback = LIB.split("export const FALLBACK_LADDER")[1].split("};")[0]
    for pair in ("resDefault: 9", "resBusy: 10", "resCrowd: 11", "busyMinPresences: 2_000", "crowdMinPresences: 10_000"):
        assert pair in fallback, pair
    assert "'825887fffffffff'::h3index" in MIGRATION, "Lagos res-2 centre cell"


def test_tr37_presence_route_reads_ladder_from_configuration() -> None:
    assert 'import { ladderForCell, resolutionFor } from "../markets.js";' in PRESENCE
    assert "resolutionFor(live, ladder)" in PRESENCE
    assert "ladderForCell(ctx, cell)" in PRESENCE
    # No hard-coded ladder thresholds remain in the route's own resolution pick.
    route_body = PRESENCE.split("ladderForCell(ctx, cell)")[0]
    assert "10_000" not in route_body and "2_000" not in route_body


def test_tr37_config_changes_propagate_via_short_cache() -> None:
    assert re.search(r"MARKET_CACHE_TTL_S = 60", LIB)
    assert '"EX", MARKET_CACHE_TTL_S' in LIB
    assert "SELECT market_for_cell($1::h3index)" in LIB
    assert "FROM market_config WHERE market_id = $1 AND active" in LIB
    assert "return FALLBACK_LADDER" in LIB, "uncovered cells get the governed fallback"


def test_tr37_resolution_function_is_ladder_driven() -> None:
    fn = LIB.split("export function resolutionFor")[1].split("const LADDER_CACHE")[0]
    assert "ladder.crowdMinPresences" in fn
    assert "ladder.busyMinPresences" in fn
    assert "ladder.resCrowd" in fn and "ladder.resDefault" in fn


# ------------------------------------------------------------ wiring -------

def test_deploy_mounts_markets_migration() -> None:
    assert "16_markets.sql" in COMPOSE and "0014_markets.sql" in COMPOSE
    assert "16_markets.sql=db/migrations/0014_markets.sql" in K8S_README
    assert "presence/postgres:p0" in K8S_PG
