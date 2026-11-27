"""Batch 70 invariants — next-gen maps (AMD-MAP-01..06; TR-44):

  the map surfaces arrive, and with them static-tile serving: a governed
  in-repo Lagos basemap rendered by a deterministic offline builder into
  a static XYZ pyramid, a version-monotonic one-published bundle
  registry, one cross-mirrored Web Mercator engine behind all three
  surfaces, the manifest + venues-near-cell member routes, and nginx
  static serving — NO runtime tile server, ever (the TR-44 clause is
  the architecture).

These pins are static mirrors: the live behaviour is proven by
client/test/mapSurface.test.ts (node --test, with the console/PWA
cross-mirror pins), the builder's own --check, and the rehearsal's
phase 8i. What pytest guards is the batch's own contract:

  * the spec addendum carries all six AMD-MAP entries and the footer
    records the batch;
  * migration 0040 pins the registry tables, the one-published partial
    unique index, the version-monotonic publish definer, the NULL-safe
    venue-ops gates, and the venues_near_cell read model;
  * the edge contract + routes pin the discovery surface (manifest,
    venues in both cell modes, the ops registry) and the bootstrap
    config's maps block;
  * the builder + basemap pin the deterministic static-tile pipeline;
  * deploy wiring: the tiles service (compose + k8s + APISIX host),
    same-origin /tiles/ proxies, network policies, and the cost-model
    lever realized;
  * TR-44 is implemented in the ledger — phase-gated is zero.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDENDUM = (ROOT / "docs/spec/srs-addendum-001.md").read_text()
MIGRATION = (ROOT / "db/migrations/0040_map_bundles.sql").read_text()
EDGE = ROOT / "services/edge"
MAPS_TS = (EDGE / "src/maps.ts").read_text()
ROUTES_TS = (EDGE / "src/routes/maps.ts").read_text()
BUILDER = (ROOT / "scripts/build_tiles.py").read_text()
BASEMAP = json.loads((ROOT / "maps/basemap/lagos.json").read_text())
TRACE_PY = (ROOT / "scripts/build_traceability.py").read_text()
TRACE_JSON = json.loads((ROOT / "docs/traceability.json").read_text())


def test_addendum_records_batch_70() -> None:
    for req in (
        "AMD-MAP-01", "AMD-MAP-02", "AMD-MAP-03",
        "AMD-MAP-04", "AMD-MAP-05", "AMD-MAP-06",
    ):
        assert req in ADDENDUM, req
    assert "Batch 70" in ADDENDUM
    assert "tests/test_batch70.py" in ADDENDUM
    assert "mapSurface.test.ts" in ADDENDUM


def test_tr44_is_implemented_and_phase_gated_is_zero() -> None:
    row = re.search(r'"TR-44": \("([^"]+)"', TRACE_PY)
    assert row and row.group(1) == "implemented"
    assert "no runtime tile server" in TRACE_PY.split('"TR-44"')[1]
    assert TRACE_JSON["requirements"]["TR-44"]["status"] == "implemented"
    counts = TRACE_JSON["status_counts"]
    assert counts["phase-gated"] == 0
    assert counts["implemented"] == 235
    assert TRACE_JSON["total"] == 306


def test_migration_registry_shape() -> None:
    assert "CREATE TABLE map_tile_bundles" in MIGRATION
    assert "CREATE TABLE map_tile_bundle_events" in MIGRATION
    for table in ("map_tile_bundles", "map_tile_bundle_events"):
        assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in MIGRATION
        assert f"REVOKE ALL ON {table} FROM PUBLIC" in MIGRATION
    # Exactly one serving bundle — the partial unique index.
    assert "CREATE UNIQUE INDEX map_tile_bundles_one_published" in MIGRATION
    assert "WHERE state = 'published'" in MIGRATION
    # The state vocabulary and the event vocabulary.
    assert "'draft', 'published', 'archived'" in MIGRATION
    assert "'registered', 'published', 'archived', 'superseded'" in MIGRATION
    # Version shape pinned with RE_DUP_MAX-safe bounds (the batch-69 lesson).
    assert "'^[0-9]{1,5}\\.[0-9]{1,5}\\.[0-9]{1,5}$'" in MIGRATION
    assert "'^[0-9a-f]{64}$'" in MIGRATION


def test_migration_publish_is_version_monotonic() -> None:
    assert "CREATE OR REPLACE FUNCTION publish_tile_bundle" in MIGRATION
    assert "version_not_monotonic" in MIGRATION
    assert "not_draft" in MIGRATION
    # Supersession is atomic with publication.
    assert "'superseded'" in MIGRATION
    # The append-only events fire on both rows.
    assert MIGRATION.count("INSERT INTO map_tile_bundle_events") >= 3


def test_migration_gates_are_null_safe() -> None:
    # The batch-63 hardening on every venue-ops gate in the batch.
    gates = re.findall(
        r"current_setting\('app\.venue_ops', true\) IS DISTINCT FROM 'on'",
        MIGRATION,
    )
    assert len(gates) >= 3  # register, publish, list
    assert "current_setting('app.venue_ops', true) = 'on'" not in MIGRATION


def test_migration_venues_read_model() -> None:
    assert "CREATE OR REPLACE FUNCTION venues_near_cell" in MIGRATION
    assert "h3_grid_disk(p_cell, 1)" in MIGRATION
    assert "h3_is_valid_cell" in MIGRATION
    # The member's cell resolves venues; cap enforced in the definer.
    assert "LEAST(GREATEST(COALESCE(p_limit, 40), 1), 40)" in MIGRATION
    # The projection is venue identity + geofence — never member data.
    assert "'venueId'" in MIGRATION and "'geofence'" in MIGRATION
    assert "ST_AsGeoJSON" in MIGRATION
    # The manifest definer exists for discovery.
    assert "CREATE OR REPLACE FUNCTION active_tile_manifest" in MIGRATION
    assert "CREATE OR REPLACE FUNCTION list_tile_bundles" in MIGRATION
    # Executables revoked from PUBLIC, granted to the app role.
    assert MIGRATION.count("REVOKE ALL ON FUNCTION") >= 5
    assert MIGRATION.count("GRANT EXECUTE ON FUNCTION") >= 5


def test_edge_contract_module() -> None:
    assert "MAP_CELL_RESOLUTION = 9" in MAPS_TS
    assert "MAP_VENUES_LIMIT_MAX = 40" in MAPS_TS
    assert "SHA256_RE" in MAPS_TS
    assert "BUNDLE_VERSION_RE" in MAPS_TS
    assert "normalizeManifest" in MAPS_TS
    assert "normalizeVenues" in MAPS_TS
    assert "parseBundleRegistration" in MAPS_TS
    # A malformed registry row collapses to unavailable, never a crash.
    assert '{ available: false }' in MAPS_TS


def test_edge_routes_and_registration() -> None:
    for path in (
        "/v1/maps/manifest",
        "/v1/maps/venues",
        "/v1/ops/maps/bundles",
        "/v1/ops/maps/bundles/:bundleId/publish",
    ):
        assert path in ROUTES_TS, path
    # Both cell modes: presented (RN) and server-resolved live (PWA).
    assert "presence:user:" in ROUTES_TS
    assert '"presented" | "live" | "absent"' in ROUTES_TS
    # The ops surface sits behind the venue-ops role everywhere.
    assert ROUTES_TS.count("requireVenueOps") >= 3
    # Registered in the app.
    app_ts = (EDGE / "src/app.ts").read_text()
    assert "registerMapRoutes" in app_ts
    assert "registerMapOpsRoutes" in app_ts
    # Metrics count the discovery surface.
    metrics_ts = (EDGE / "src/metrics.ts").read_text()
    assert "presence_map_queries_total" in metrics_ts


def test_bootstrap_config_carries_maps_block() -> None:
    cfg = (EDGE / "src/clientConfig.ts").read_text()
    assert "maps: { tilesBaseUrl: string }" in cfg
    assert "MAPS_TILES_BASE_URL" in cfg
    # Fail-closed empty default, like realtime.
    assert '(env.MAPS_TILES_BASE_URL ?? "").trim()' in cfg


def test_builder_is_deterministic_and_static() -> None:
    assert "presence-basemap/1" in BUILDER
    assert "presence-tile-manifest/1" in BUILDER
    assert "--check" in BUILDER
    assert "CHECK OK" in BUILDER
    # Tiles are PNG files on disk — no server is created anywhere.
    assert "http.server" not in BUILDER
    assert "socket" not in BUILDER
    # Text-free tiles: labels ride the vector bundle (font independence).
    assert "vectors.json" in BUILDER
    assert "text-free" in BUILDER.lower() or "Text-free" in BUILDER


def test_basemap_source_is_governed_and_lagos() -> None:
    assert BASEMAP["schema"] == "presence-basemap/1"
    assert BASEMAP["id"] == "lagos"
    assert BASEMAP["zoom"] == {"min": 10, "max": 14}
    bbox = BASEMAP["bbox"]
    assert bbox["west"] < bbox["east"] and bbox["south"] < bbox["north"]
    # The Lagos launch market: Unilag is the pilot landmark.
    names = [m["name"] for m in BASEMAP["layers"]["landmarks"]]
    assert "University of Lagos" in names
    # Lagos geography sanity: bbox contains the seeded market cell centre
    # region (mainland Lagos around 3.4E, 6.5N).
    assert bbox["west"] <= 3.4 <= bbox["east"]
    assert bbox["south"] <= 6.5 <= bbox["north"]
    for layer in ("water", "districts", "roads", "landmarks"):
        assert len(BASEMAP["layers"][layer]) >= 3, layer


def test_deploy_wiring_static_serving() -> None:
    compose = (ROOT / "deploy/docker-compose.yml").read_text()
    assert "tiles:" in compose
    assert "tiles/Dockerfile" in compose
    # The migration mounts in the initdb sequence after 41_whatsapp.
    assert "0040_map_bundles.sql:/docker-entrypoint-initdb.d/42_map_bundles.sql" in compose
    # Both PWAs depend on the tiles tier for their /tiles/ proxies.
    assert compose.count("- tiles") >= 2
    apisix = (ROOT / "deploy/apisix/apisix.yaml").read_text()
    assert "tiles.presence.example" in apisix
    k8s_apisix = (ROOT / "deploy/k8s/apisix.yaml").read_text()
    assert "tiles.presence.example" in k8s_apisix
    assert "tiles.presence.svc.cluster.local" in k8s_apisix
    k8s_tiles = (ROOT / "deploy/k8s/tiles.yaml").read_text()
    assert "presence/tiles:1.0.0" in k8s_tiles
    assert "/current/manifest.json" in k8s_tiles
    kustom = (ROOT / "deploy/k8s/kustomization.yaml").read_text()
    assert "tiles.yaml" in kustom
    # The bootstrap env wire exists in both deploy shapes.
    assert "MAPS_TILES_BASE_URL" in compose
    edge_k8s = (ROOT / "deploy/k8s/edge.yaml").read_text()
    assert "MAPS_TILES_BASE_URL" in edge_k8s


def test_tiles_service_config() -> None:
    nginx = (ROOT / "tiles/nginx.conf").read_text()
    # Immutable caching on versioned tiles; revalidate on manifest.
    assert "max-age=31536000, immutable" in nginx
    assert "no-cache, must-revalidate" in nginx
    # Tile access logging is OFF (location-revealing in aggregate).
    assert "access_log off" in nginx
    dockerfile = (ROOT / "tiles/Dockerfile").read_text()
    # The builder runs at image build time, WITH its hash check.
    assert "build_tiles.py --out build/tiles" in dockerfile
    assert "--check" in dockerfile
    assert "Pillow" in dockerfile
    # The PWAs proxy /tiles/ same-origin and honour upstream caching.
    for conf in ("pwa/nginx.conf", "console/nginx.conf"):
        text = (ROOT / conf).read_text()
        assert "location /tiles/" in text, conf
        assert "http://tiles:8080/current/" in text, conf


def test_network_policies_pin_the_tiles_tier() -> None:
    np = (ROOT / "deploy/k8s/networkpolicy.yaml").read_text()
    assert "tiles-from-gateways" in np
    assert "pwa-egress-tiles" in np
    assert "console-egress-tiles" in np
    # The tiles pod has NO egress — a map tile never calls home.
    block = np.split("tiles-from-gateways")[1]
    assert "egress: []" in block


def test_openapi_and_docs() -> None:
    openapi = (ROOT / "docs/api/openapi.yaml").read_text()
    for path in (
        "/v1/maps/manifest:",
        "/v1/maps/venues:",
        "/v1/ops/maps/bundles:",
        "/v1/ops/maps/bundles/{bundleId}/publish:",
    ):
        assert path in openapi, path
    ux = (ROOT / "docs/ux/maps.md").read_text()
    for req in ("AMD-MAP-01", "AMD-MAP-03", "AMD-MAP-05", "AMD-MAP-06", "TR-44"):
        assert req in ux, req
    # The cost model's TR-44 lever is marked realized.
    cost = (ROOT / "docs/ops/cost-model.md").read_text()
    assert "TR-44" in cost


def test_no_runtime_tile_server_anywhere() -> None:
    # TR-44's clause is load-bearing: grep the serving surface for any
    # dynamic tile rendering. The builder (offline, Pillow) and nginx
    # (static) are the whole pipeline.
    tiles_nginx = (ROOT / "tiles/nginx.conf").read_text()
    assert "proxy_pass" not in tiles_nginx  # tiles serve files, not upstreams
    assert "fastcgi" not in tiles_nginx
    assert "uwsgi" not in tiles_nginx
