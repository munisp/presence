/** AMD-MAP-05: the member PWA map engine — mirror of the AMD-MAP-03
 * contract plus centroidOfBoundary. The token-level cross-pin against
 * the client engine lives in client/test/mapSurface.test.ts; here the
 * member-specific behaviour is exercised directly. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BundleFootprint,
  MAP_OFFLINE_NOTICE,
  MAP_OUTSIDE_NOTICE,
  TILE_CACHE_CAPACITY,
  TileCache,
  centroidOfBoundary,
  clampZoom,
  insideFootprint,
  lonLatToWorld,
  planTileFetch,
  prefetchZoomRadius,
  projectCellBoundary,
  worldToLonLat,
} from "../src/mapEngine.js";

const LAGOS: BundleFootprint = {
  bbox: { west: 3.2, south: 6.38, east: 3.7, north: 6.66 },
  minZoom: 10,
  maxZoom: 14,
};

test("AMD-MAP-05: the mirror's projection matches the pinned math", () => {
  const p = { lng: 3.3992, lat: 6.518 };
  for (const z of [10, 12, 14]) {
    const back = worldToLonLat(lonLatToWorld(p, z), z);
    assert.ok(Math.abs(back.lng - p.lng) < 1e-9);
    assert.ok(Math.abs(back.lat - p.lat) < 1e-9);
  }
  assert.equal(clampZoom(LAGOS, 3), 10);
  assert.equal(insideFootprint(LAGOS, p), true);
  assert.equal(insideFootprint(LAGOS, { lng: 9.0, lat: 6.5 }), false);
});

test("AMD-MAP-05: the member's fetch discipline is the pinned contract", () => {
  // Online fetches without a notice, both ways.
  assert.deepEqual(planTileFetch("online", true), {
    action: "fetch",
    notice: null,
  });
  assert.deepEqual(planTileFetch("online", false), {
    action: "fetch",
    notice: null,
  });
  // Degraded never nags.
  assert.equal(planTileFetch("degraded", true).notice, null);
  assert.equal(planTileFetch("degraded", false).action, "placeholder");
  // Offline always carries the pinned notice.
  assert.equal(planTileFetch("offline", true).notice, MAP_OFFLINE_NOTICE);
  assert.equal(planTileFetch("offline", false).notice, MAP_OFFLINE_NOTICE);
  // Prefetch stays pinned at zero.
  for (const link of ["online", "degraded", "offline"] as const) {
    assert.equal(prefetchZoomRadius(link), 0);
  }
});

test("AMD-MAP-05: pinned copy matches the client contract", () => {
  assert.equal(
    MAP_OFFLINE_NOTICE,
    "Map is offline — showing what's already on this device.",
  );
  assert.equal(
    MAP_OUTSIDE_NOTICE,
    "Map coverage for your city's launch market is on the way.",
  );
});

test("AMD-MAP-05: the tile cache honours capacity and version wipe", () => {
  const cache = new TileCache<string>(TILE_CACHE_CAPACITY);
  assert.equal(cache.version, null);
  cache.setBundleVersion("1.0.0");
  cache.put({ z: 13, x: 4173, y: 3949 }, "png");
  assert.equal(cache.get({ z: 13, x: 4173, y: 3949 }), "png");
  assert.equal(cache.setBundleVersion("1.0.1"), true);
  assert.equal(cache.size, 0);
});

test("AMD-MAP-05: centroidOfBoundary centres the member's own halo", () => {
  // An r9-cell-shaped hexagon around Unilag.
  const boundary: Array<[number, number]> = [
    [3.398, 6.517],
    [3.4004, 6.517],
    [3.4016, 6.5185],
    [3.4004, 6.52],
    [3.398, 6.52],
    [3.3968, 6.5185],
  ];
  const c = centroidOfBoundary(boundary);
  assert.ok(c !== null);
  assert.ok(Math.abs(c!.lng - 3.3992) < 0.001, String(c!.lng));
  assert.ok(Math.abs(c!.lat - 6.5185) < 0.001, String(c!.lat));
  // Degenerate input refuses.
  assert.equal(centroidOfBoundary([]), null);
  assert.equal(centroidOfBoundary([[3.4, 6.5], [3.4, 6.5]]), null);
});

test("AMD-MAP-05: the halo projects as a boundary, never a dot", () => {
  const viewport = {
    center: { lng: 3.3992, lat: 6.518 },
    zoom: 14,
    width: 640,
    height: 420,
  };
  const boundary: Array<[number, number]> = [
    [3.398, 6.517],
    [3.4004, 6.517],
    [3.4016, 6.5185],
    [3.4004, 6.52],
    [3.398, 6.52],
    [3.3968, 6.5185],
  ];
  const pts = projectCellBoundary(boundary, viewport);
  assert.equal(pts.length, 6); // a ring, not a point
  for (const p of pts) {
    assert.ok(p.x > 0 && p.x < 640);
    assert.ok(p.y > 0 && p.y < 420);
  }
});
