/**
 * Batch 70 — AMD-MAP-03: the map surface engine.
 *
 * Pins the Web Mercator projection (round-trip, tile cover, zoom clamp,
 * footprint gate), the fetch discipline (LINK_SURFACE_MAP made concrete:
 * online fetches, degraded is cache-only without nagging, offline is
 * cache-only with the pinned notice, a never-cached tile is a styled
 * placeholder), the bounded LRU (capacity eviction, recency touch, and
 * the wholesale wipe on bundle-version change), the overlay projections
 * (geofence ring and the presence halo cell boundary), and the zero
 * prefetch budget — plus cross-mirror pins on the console and member
 * PWA engines and the spec/deploy wiring.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BundleFootprint,
  MAP_OFFLINE_NOTICE,
  MAP_OUTSIDE_NOTICE,
  TILE_CACHE_CAPACITY,
  TILE_SIZE,
  TileCache,
  clampLatitude,
  clampZoom,
  insideFootprint,
  lonLatToWorld,
  prefetchZoomRadius,
  planTileFetch,
  projectCellBoundary,
  projectPolygon,
  tileCover,
  tileUrl,
  worldToLonLat,
} from "../src/presence/mapSurface.js";

const LAGOS: BundleFootprint = {
  bbox: { west: 3.2, south: 6.38, east: 3.7, north: 6.66 },
  minZoom: 10,
  maxZoom: 14,
};

// ------------------------------------------------------------ projection --

test("AMD-MAP-03: mercator round-trip is exact within fp tolerance", () => {
  const points = [
    { lng: 3.3992, lat: 6.518 }, // Unilag
    { lng: 3.2, lat: 6.38 },
    { lng: 3.7, lat: 6.66 },
    { lng: 0, lat: 0 },
    { lng: -73.98, lat: 40.75 },
  ];
  for (const z of [10, 12, 14]) {
    for (const p of points) {
      const back = worldToLonLat(lonLatToWorld(p, z), z);
      assert.ok(Math.abs(back.lng - p.lng) < 1e-9, `${JSON.stringify(p)} @z${z}`);
      assert.ok(Math.abs(back.lat - p.lat) < 1e-9, `${JSON.stringify(p)} @z${z}`);
    }
  }
});

test("AMD-MAP-03: latitude clamps at the mercator limit", () => {
  assert.equal(clampLatitude(90), 85.05112878);
  assert.equal(clampLatitude(-90), -85.05112878);
  assert.equal(clampLatitude(6.5), 6.5);
});

test("AMD-MAP-03: zoom clamps into the bundle's declared range", () => {
  assert.equal(clampZoom(LAGOS, 7), 10);
  assert.equal(clampZoom(LAGOS, 18), 14);
  assert.equal(clampZoom(LAGOS, 12), 12);
  assert.equal(clampZoom(LAGOS, 12.6), 13); // rounds
});

test("AMD-MAP-03: the footprint gate is the bbox, inclusive", () => {
  assert.equal(insideFootprint(LAGOS, { lng: 3.4, lat: 6.5 }), true);
  assert.equal(insideFootprint(LAGOS, { lng: 3.2, lat: 6.38 }), true);
  assert.equal(insideFootprint(LAGOS, { lng: 3.1, lat: 6.5 }), false);
  assert.equal(insideFootprint(LAGOS, { lng: 3.4, lat: 6.7 }), false);
  assert.equal(insideFootprint(LAGOS, { lng: 6.9, lat: 3.4 }), false); // swapped
});

test("AMD-MAP-03: tile cover spans the viewport, clamped to the world", () => {
  const cover = tileCover(LAGOS, {
    center: { lng: 3.4, lat: 6.5 },
    zoom: 12,
    width: 640,
    height: 420,
  });
  // 640px wide at 256px tiles covers at most 4 columns, 420px 3 rows.
  assert.ok(cover.length >= 6 && cover.length <= 12, String(cover.length));
  const xs = new Set(cover.map((t) => t.x));
  const ys = new Set(cover.map((t) => t.y));
  for (const x of xs) assert.ok(x >= 0 && x < 2 ** 12);
  for (const y of ys) assert.ok(y >= 0 && y < 2 ** 12);
  assert.ok(Math.max(...xs) - Math.min(...xs) <= 3);
  assert.ok(Math.max(...ys) - Math.min(...ys) <= 2);
  // Every tile carries the clamped zoom.
  for (const t of cover) assert.equal(t.z, 12);
  // Covering with an out-of-range zoom uses the clamp, not the request.
  const clamped = tileCover(LAGOS, {
    center: { lng: 3.4, lat: 6.5 },
    zoom: 99,
    width: 640,
    height: 420,
  });
  for (const t of clamped) assert.equal(t.z, 14);
});

test("AMD-MAP-03: tile URLs fill the manifest template", () => {
  assert.equal(
    tileUrl("/tiles/{z}/{x}/{y}.png", { z: 12, x: 2087, y: 1973 }),
    "/tiles/12/2087/1973.png",
  );
});

// ------------------------------------------------------ fetch discipline --

test("AMD-MAP-03: online always fetches, with no notice", () => {
  for (const cached of [true, false]) {
    const plan = planTileFetch("online", cached);
    assert.equal(plan.action, "fetch");
    assert.equal(plan.notice, null);
  }
});

test("AMD-MAP-03: degraded is cache-only and never nags", () => {
  assert.deepEqual(planTileFetch("degraded", true), {
    action: "cache-only",
    notice: null,
  });
  assert.deepEqual(planTileFetch("degraded", false), {
    action: "placeholder",
    notice: null,
  });
});

test("AMD-MAP-03: offline carries the pinned notice either way", () => {
  assert.deepEqual(planTileFetch("offline", true), {
    action: "cache-only",
    notice: MAP_OFFLINE_NOTICE,
  });
  assert.deepEqual(planTileFetch("offline", false), {
    action: "placeholder",
    notice: MAP_OFFLINE_NOTICE,
  });
});

test("AMD-MAP-03: the prefetch budget is pinned at zero on every link", () => {
  for (const link of ["online", "degraded", "offline"] as const) {
    assert.equal(prefetchZoomRadius(link), 0);
  }
});

test("AMD-MAP-03: pinned copy", () => {
  assert.equal(
    MAP_OFFLINE_NOTICE,
    "Map is offline — showing what's already on this device.",
  );
  assert.equal(
    MAP_OUTSIDE_NOTICE,
    "Map coverage for your city's launch market is on the way.",
  );
});

// ------------------------------------------------------------ tile cache --

test("AMD-MAP-03: the cache evicts the coldest entry past capacity", () => {
  const cache = new TileCache<string>(3);
  const t = (i: number) => ({ z: 12, x: i, y: 0 });
  cache.put(t(0), "a");
  cache.put(t(1), "b");
  cache.put(t(2), "c");
  cache.put(t(3), "d"); // evicts a
  assert.equal(cache.size, 3);
  assert.equal(cache.get(t(0)), undefined);
  assert.equal(cache.get(t(3)), "d");
});

test("AMD-MAP-03: a hit is a recency touch", () => {
  const cache = new TileCache<string>(2);
  const t = (i: number) => ({ z: 12, x: i, y: 0 });
  cache.put(t(0), "a");
  cache.put(t(1), "b");
  cache.get(t(0)); // a is now warm
  cache.put(t(2), "c"); // evicts b, not a
  assert.equal(cache.get(t(0)), "a");
  assert.equal(cache.get(t(1)), undefined);
});

test("AMD-MAP-03: a bundle-version change wipes the cache wholesale", () => {
  const cache = new TileCache<string>(TILE_CACHE_CAPACITY);
  cache.setBundleVersion("1.0.0");
  cache.put({ z: 12, x: 1, y: 1 }, "tile");
  assert.equal(cache.size, 1);
  assert.equal(cache.setBundleVersion("1.0.0"), false); // no-op
  assert.equal(cache.size, 1);
  assert.equal(cache.setBundleVersion("1.1.0"), true); // wiped
  assert.equal(cache.size, 0);
  assert.equal(cache.get({ z: 12, x: 1, y: 1 }), undefined);
});

test("AMD-MAP-03: capacity is floored at one", () => {
  const cache = new TileCache<string>(0);
  cache.put({ z: 1, x: 0, y: 0 }, "only");
  cache.put({ z: 1, x: 1, y: 0 }, "next");
  assert.equal(cache.size, 1);
  assert.equal(cache.get({ z: 1, x: 1, y: 0 }), "next");
});

// ------------------------------------------------------------ overlays ----

test("AMD-MAP-03: polygon and cell-boundary projection land in screen space", () => {
  const viewport = {
    center: { lng: 3.4, lat: 6.5 },
    zoom: 13,
    width: 640,
    height: 420,
  };
  // A square ring around the centre projects to screen points inside the
  // viewport; the centre itself is (w/2, h/2).
  const ring: Array<[number, number]> = [
    [3.39, 6.49],
    [3.41, 6.49],
    [3.41, 6.51],
    [3.39, 6.51],
  ];
  const pts = projectPolygon(ring, viewport);
  assert.equal(pts.length, 4);
  for (const p of pts) {
    assert.ok(p.x > 0 && p.x < 640, String(p.x));
    assert.ok(p.y > 0 && p.y < 420, String(p.y));
  }
  // The ring is SW, SE, NE, NW: screen-x grows eastward, screen-y grows
  // SOUTHWARD (world origin is NW) — so the SW corner sits left of and
  // BELOW the NE corner.
  assert.ok(pts[0].x < pts[2].x && pts[0].y > pts[2].y);
  // The halo path is the same projector — a boundary ring, never a dot.
  const halo = projectCellBoundary(ring, viewport);
  assert.deepEqual(halo, pts);
});

// ------------------------------------------------------ cross-mirror pins --

test("AMD-MAP-03/04/05: console and PWA engines mirror the pinned math", () => {
  const client = readFileSync("src/presence/mapSurface.ts", "utf8");
  const consoleEngine = readFileSync("../console/src/mapEngine.ts", "utf8");
  const pwaEngine = readFileSync("../pwa/src/mapEngine.ts", "utf8");
  // The mirrors are header-adjusted copies of the same contract: the
  // pinned constants and function names must appear identically.
  for (const token of [
    "MAX_MERCATOR_LAT = 85.05112878",
    "TILE_CACHE_CAPACITY = 320",
    "export function lonLatToWorld",
    "export function worldToLonLat",
    "export function tileCover",
    "export function clampZoom",
    "export function planTileFetch",
    "export class TileCache",
    "MAP_OFFLINE_NOTICE",
  ]) {
    assert.ok(client.includes(token), `client missing ${token}`);
    assert.ok(consoleEngine.includes(token), `console missing ${token}`);
    assert.ok(pwaEngine.includes(token), `pwa missing ${token}`);
  }
  // The mirrors are dependency-free: no imports beyond local types.
  for (const [name, src] of [["console", consoleEngine], ["pwa", pwaEngine]] as const) {
    const imports = src.match(/^import .* from "(.+)";$/gm) ?? [];
    for (const imp of imports) {
      assert.ok(
        imp.includes("./") || imp.includes("../"),
        `${name} engine must stay zero-dependency, got: ${imp}`,
      );
    }
  }
});

test("AMD-MAP-01: the builder, basemap source and manifest shape exist", () => {
  const builder = readFileSync("../scripts/build_tiles.py", "utf8");
  assert.ok(builder.includes("presence-basemap/1"));
  assert.ok(builder.includes("presence-tile-manifest/1"));
  assert.ok(builder.includes("--check"));
  const basemap = JSON.parse(readFileSync("../maps/basemap/lagos.json", "utf8"));
  assert.equal(basemap.schema, "presence-basemap/1");
  assert.equal(basemap.id, "lagos");
  assert.equal(basemap.version, "1.0.0");
  assert.ok(basemap.layers.water.length >= 3);
  assert.ok(basemap.layers.roads.length >= 10);
  assert.ok(
    basemap.layers.landmarks.some(
      (m: { name: string }) => m.name === "University of Lagos",
    ),
  );
  // The bbox in the source matches the engine's Lagos footprint.
  assert.deepEqual(basemap.bbox, { west: 3.2, south: 6.38, east: 3.7, north: 6.66 });
  assert.deepEqual(basemap.zoom, { min: 10, max: 14 });
});

test("AMD-MAP-02: the registry migration pins the one-published invariant", () => {
  const sql = readFileSync("../db/migrations/0040_map_bundles.sql", "utf8");
  assert.ok(sql.includes("CREATE TABLE map_tile_bundles"));
  assert.ok(sql.includes("map_tile_bundles_one_published"));
  assert.ok(sql.includes("WHERE state = 'published'"));
  assert.ok(sql.includes("version_not_monotonic"));
  assert.ok(sql.includes("map_tile_bundle_events"));
  assert.ok(sql.includes("venues_near_cell"));
  assert.ok(sql.includes("active_tile_manifest"));
  // The venue-ops gate is the batch-63 NULL-safe form.
  const gates = sql.match(/IS DISTINCT FROM 'on'/g) ?? [];
  assert.ok(gates.length >= 3, `expected >=3 NULL-safe gates, got ${gates.length}`);
  // Tiles are static; no runtime tile server is created here.
  assert.ok(!sql.includes("CREATE SERVER"));
});

test("AMD-MAP-05: the edge routes and manifest normaliser exist", () => {
  const routes = readFileSync("../services/edge/src/routes/maps.ts", "utf8");
  assert.ok(routes.includes("/v1/maps/manifest"));
  assert.ok(routes.includes("/v1/maps/venues"));
  assert.ok(routes.includes("/v1/ops/maps/bundles"));
  assert.ok(routes.includes("register_tile_bundle"));
  assert.ok(routes.includes("publish_tile_bundle"));
  const contract = readFileSync("../services/edge/src/maps.ts", "utf8");
  assert.ok(contract.includes("MAP_CELL_RESOLUTION = 9"));
  assert.ok(contract.includes("MAP_VENUES_LIMIT_MAX = 40"));
  assert.ok(contract.includes("normalizeManifest"));
  // The app registers both route groups.
  const app = readFileSync("../services/edge/src/app.ts", "utf8");
  assert.ok(app.includes("registerMapRoutes"));
  assert.ok(app.includes("registerMapOpsRoutes"));
});

test("AMD-MAP-06: static serving is wired, no runtime tile server", () => {
  const compose = readFileSync("../deploy/docker-compose.yml", "utf8");
  assert.ok(compose.includes("tiles:"));
  const apisix = readFileSync("../deploy/apisix/apisix.yaml", "utf8");
  assert.ok(apisix.includes("tiles.presence.example"));
  // Both PWAs proxy /tiles/ same-origin so CSP stays 'self'.
  for (const f of ["../pwa/nginx.conf", "../console/nginx.conf"]) {
    const conf = readFileSync(f, "utf8");
    assert.ok(conf.includes("location /tiles/"), `${f} missing /tiles/ proxy`);
    assert.ok(conf.includes("immutable"), `${f} missing immutable caching`);
  }
  const tilesConf = readFileSync("../tiles/nginx.conf", "utf8");
  assert.ok(tilesConf.includes("manifest.json"));
  assert.ok(tilesConf.includes("no-cache"));
  const ux = readFileSync("../docs/ux/maps.md", "utf8");
  assert.ok(ux.includes("AMD-MAP-03"));
});

test("AMD-MAP-03: TR-44 flips to implemented in the traceability ledger", () => {
  const builder = readFileSync("../scripts/build_traceability.py", "utf8");
  const row = builder.match(/"TR-44": \("([^"]+)"/);
  assert.ok(row, "TR-44 row missing");
  assert.equal(row![1], "implemented");
});
