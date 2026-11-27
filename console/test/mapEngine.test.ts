/** AMD-MAP-04: the console map engine — mirror of the AMD-MAP-03 contract
 * plus the editor's fitViewportToRing. The token-level cross-pin against
 * the client engine lives in client/test/mapSurface.test.ts; here the
 * console-specific behaviour is exercised directly. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BundleFootprint,
  MAP_OFFLINE_NOTICE,
  TILE_CACHE_CAPACITY,
  TileCache,
  clampZoom,
  fitViewportToRing,
  insideFootprint,
  lonLatToWorld,
  planTileFetch,
  prefetchZoomRadius,
  projectPolygon,
  tileCover,
  tileUrl,
  worldToLonLat,
} from "../src/mapEngine.js";

const LAGOS: BundleFootprint = {
  bbox: { west: 3.2, south: 6.38, east: 3.7, north: 6.66 },
  minZoom: 10,
  maxZoom: 14,
};

test("AMD-MAP-04: the mirror's projection matches the pinned math", () => {
  // Golden values from the client contract (same formula, same answer).
  const p = { lng: 3.3992, lat: 6.518 };
  for (const z of [10, 12, 14]) {
    const back = worldToLonLat(lonLatToWorld(p, z), z);
    assert.ok(Math.abs(back.lng - p.lng) < 1e-9);
    assert.ok(Math.abs(back.lat - p.lat) < 1e-9);
  }
  assert.equal(clampZoom(LAGOS, 99), 14);
  assert.equal(insideFootprint(LAGOS, p), true);
  assert.equal(
    tileUrl("/tiles/{z}/{x}/{y}.png", { z: 12, x: 2087, y: 1973 }),
    "/tiles/12/2087/1973.png",
  );
});

test("AMD-MAP-04: the fetch discipline mirrors LINK_SURFACE_MAP", () => {
  assert.deepEqual(planTileFetch("online", false), {
    action: "fetch",
    notice: null,
  });
  assert.deepEqual(planTileFetch("degraded", true), {
    action: "cache-only",
    notice: null,
  });
  assert.deepEqual(planTileFetch("offline", false), {
    action: "placeholder",
    notice: MAP_OFFLINE_NOTICE,
  });
  assert.equal(prefetchZoomRadius("online"), 0);
});

test("AMD-MAP-04: the tile cache wipes wholesale on bundle change", () => {
  const cache = new TileCache<string>(TILE_CACHE_CAPACITY);
  cache.setBundleVersion("1.0.0");
  cache.put({ z: 12, x: 1, y: 1 }, "tile");
  assert.equal(cache.setBundleVersion("1.1.0"), true);
  assert.equal(cache.size, 0);
});

test("AMD-MAP-04: fitViewportToRing centres the polygon with margin", () => {
  // A Unilag-sized geofence ring (~400 m across).
  const ring: Array<[number, number]> = [
    [3.396, 6.516],
    [3.402, 6.516],
    [3.402, 6.520],
    [3.396, 6.520],
  ];
  const vp = fitViewportToRing(LAGOS, ring, 640, 420);
  assert.ok(vp !== null);
  assert.equal(vp!.center.lng, 3.399);
  assert.equal(vp!.center.lat, 6.518);
  // A small polygon earns a deep zoom (within the bundle's range).
  assert.ok(vp!.zoom >= 13 && vp!.zoom <= 14, String(vp!.zoom));
  // The ring projects INSIDE the viewport with margin.
  const pts = projectPolygon(ring, vp!);
  for (const p of pts) {
    assert.ok(p.x > 30 && p.x < 610, String(p.x));
    assert.ok(p.y > 30 && p.y < 390, String(p.y));
  }
});

test("AMD-MAP-04: fitViewportToRing refuses degenerate input", () => {
  assert.equal(fitViewportToRing(LAGOS, [], 640, 420), null);
  assert.equal(
    fitViewportToRing(LAGOS, [[3.4, 6.5], [3.4, 6.5]], 640, 420),
    null,
  );
  // A zero-area line ring is not a polygon viewport.
  assert.equal(
    fitViewportToRing(
      LAGOS,
      [[3.4, 6.5], [3.4, 6.5], [3.4, 6.5]],
      640,
      420,
    ),
    null,
  );
  // A huge ring clamps to the bundle's min zoom.
  const huge: Array<[number, number]> = [
    [3.2, 6.38],
    [3.7, 6.38],
    [3.7, 6.66],
    [3.2, 6.66],
  ];
  const vp = fitViewportToRing(LAGOS, huge, 320, 240);
  assert.ok(vp !== null);
  assert.equal(vp!.zoom, LAGOS.minZoom);
});

test("AMD-MAP-04: the tile cover is bounded by the world", () => {
  const cover = tileCover(LAGOS, {
    center: { lng: 3.4, lat: 6.5 },
    zoom: 14,
    width: 640,
    height: 420,
  });
  assert.ok(cover.length >= 6);
  for (const t of cover) {
    assert.equal(t.z, 14);
    assert.ok(t.x >= 0 && t.y >= 0);
  }
});
