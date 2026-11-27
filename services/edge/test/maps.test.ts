/** SRS Addendum 001 (b70): the maps discovery contract — AMD-MAP-02/05. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUNDLE_VERSION_RE,
  MAP_CELL_RESOLUTION,
  MAP_VENUES_LIMIT_MAX,
  SHA256_RE,
  bboxToPolygonGeoJSON,
  normalizeManifest,
  normalizeVenues,
  parseBundleRegistration,
  parseMapCell,
  parseMapLimit,
} from "../src/maps.js";

// A real Lagos r9 cell (the market seed's child shape); second hex char
// carries the resolution — '9' pins r9 (TR-12 floor).
const R9 = "8928342e20fffff";
const R10 = "8a28342e20f7fff";

// ------------------------------------------------------------ parseMapCell --

test("AMD-MAP-05: a valid r9 cell parses", () => {
  assert.equal(parseMapCell(R9), R9);
  assert.equal(parseMapCell(` ${R9.toUpperCase()} `), R9); // trim + lower
});

test("AMD-MAP-05: wrong resolutions and garbage refuse", () => {
  assert.equal(parseMapCell(R10), null); // r10 — second char 'a'
  assert.equal(parseMapCell("not-a-cell"), null);
  assert.equal(parseMapCell(""), null);
  assert.equal(parseMapCell(undefined), null);
  assert.equal(parseMapCell(42), null);
  assert.equal(parseMapCell("8928342e20fffff0"), null); // 16 chars
});

test("AMD-MAP-05: the resolution pin is structural", () => {
  assert.equal(MAP_CELL_RESOLUTION, 9);
  assert.equal(R9[1], "9");
});

// ------------------------------------------------------------ parseMapLimit -

test("AMD-MAP-05: limit defaults to the cap, clamps 1..40", () => {
  assert.equal(MAP_VENUES_LIMIT_MAX, 40);
  assert.equal(parseMapLimit(undefined), 40);
  assert.equal(parseMapLimit(""), 40);
  assert.equal(parseMapLimit("1"), 1);
  assert.equal(parseMapLimit("40"), 40);
  assert.equal(parseMapLimit("0"), -1);
  assert.equal(parseMapLimit("41"), -1);
  assert.equal(parseMapLimit("3.5"), -1);
  assert.equal(parseMapLimit("abc"), -1);
});

// -------------------------------------------------------- normalizeManifest -

const VALID_ROW = {
  bundleId: "3f6b6f78-0000-4000-8000-000000000001",
  version: "1.0.0",
  label: "Lagos launch market",
  bbox: {
    type: "Polygon",
    coordinates: [[
      [3.2, 6.38], [3.7, 6.38], [3.7, 6.66], [3.2, 6.66], [3.2, 6.38],
    ]],
  },
  minZoom: 10,
  maxZoom: 14,
  tileCount: 465,
  tilesSha256: "a".repeat(64),
  attribution: "Presence governed basemap",
  urlTemplate: "/tiles/{z}/{x}/{y}.png",
  vectorsUrl: "/tiles/vectors.json",
  publishedAt: "2026-11-27T00:00:00Z",
};

test("AMD-MAP-05: a valid registry row normalises to the wire shape", () => {
  const m = normalizeManifest(VALID_ROW);
  assert.ok(m.available);
  if (m.available) {
    assert.equal(m.version, "1.0.0");
    assert.deepEqual(m.bbox, { west: 3.2, south: 6.38, east: 3.7, north: 6.66 });
    assert.equal(m.tileCount, 465);
    assert.equal(m.urlTemplate, "/tiles/{z}/{x}/{y}.png");
  }
});

test("AMD-MAP-05: malformed registry rows collapse to unavailable", () => {
  assert.deepEqual(normalizeManifest(null), { available: false });
  assert.deepEqual(normalizeManifest("x"), { available: false });
  assert.deepEqual(normalizeManifest({}), { available: false });
  // Bad version shape.
  assert.deepEqual(
    normalizeManifest({ ...VALID_ROW, version: "1.0" }),
    { available: false },
  );
  // Bad hash shape.
  assert.deepEqual(
    normalizeManifest({ ...VALID_ROW, tilesSha256: "zz" }),
    { available: false },
  );
  // Inverted zoom range.
  assert.deepEqual(
    normalizeManifest({ ...VALID_ROW, minZoom: 15 }),
    { available: false },
  );
  // Broken bbox (ring too short).
  assert.deepEqual(
    normalizeManifest({
      ...VALID_ROW,
      bbox: { type: "Polygon", coordinates: [[[3.2, 6.38]]] },
    }),
    { available: false },
  );
});

// ---------------------------------------------------------- normalizeVenues -

test("AMD-MAP-05: the venues envelope re-validates, dropping bad entries", () => {
  const good = {
    venueId: "3f6b6f78-0000-4000-8000-000000000002",
    label: "Unilag Main Hall",
    geofence: { type: "Polygon", coordinates: [[[3.39, 6.51]]] },
    floors: ["G", "1"],
  };
  assert.deepEqual(normalizeVenues([good]), [good]);
  assert.deepEqual(normalizeVenues([]), []);
  assert.deepEqual(normalizeVenues("not-an-array"), []);
  // A definer bug (missing label / null geofence) drops the entry, never
  // ships malformed payloads.
  assert.deepEqual(
    normalizeVenues([good, { venueId: "x" }, { ...good, geofence: null }]),
    [good],
  );
});

// ------------------------------------------------------ bundle registration -

const VALID_REG = {
  version: "1.1.0",
  label: "Lagos launch market",
  bbox: { west: 3.2, south: 6.38, east: 3.7, north: 6.66 },
  minZoom: 10,
  maxZoom: 14,
  tileCount: 465,
  tilesSha256: "b".repeat(64),
  attribution: "Presence governed basemap",
};

test("AMD-MAP-02: a valid registration parses; the bbox serialises closed", () => {
  const reg = parseBundleRegistration(VALID_REG);
  assert.ok(reg !== null);
  assert.equal(reg!.version, "1.1.0");
  const geo = JSON.parse(bboxToPolygonGeoJSON(reg!.bbox));
  assert.equal(geo.type, "Polygon");
  const ring = geo.coordinates[0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]); // closed ring
  assert.deepEqual(ring[0], [3.2, 6.38]);
});

test("AMD-MAP-02: malformed registrations refuse", () => {
  assert.equal(parseBundleRegistration(null), null);
  assert.equal(parseBundleRegistration({}), null);
  // Version must be x.y.z with bounded segments.
  assert.equal(parseBundleRegistration({ ...VALID_REG, version: "1.0" }), null);
  assert.equal(
    parseBundleRegistration({ ...VALID_REG, version: "1.0.0.1" }),
    null,
  );
  assert.ok(BUNDLE_VERSION_RE.test("1.0.0"));
  assert.ok(!BUNDLE_VERSION_RE.test("1.0.0-beta"));
  // Hash must be 64 lowercase hex.
  assert.equal(
    parseBundleRegistration({ ...VALID_REG, tilesSha256: "B".repeat(64) }),
    null,
  );
  assert.ok(SHA256_RE.test("a".repeat(64)));
  // Inverted bbox and zoom range refuse.
  assert.equal(
    parseBundleRegistration({ ...VALID_REG, bbox: { ...VALID_REG.bbox, west: 3.8 } }),
    null,
  );
  assert.equal(
    parseBundleRegistration({ ...VALID_REG, minZoom: 15 }),
    null,
  );
  assert.equal(
    parseBundleRegistration({ ...VALID_REG, maxZoom: 23 }),
    null,
  );
  // Tile count is a positive integer.
  assert.equal(parseBundleRegistration({ ...VALID_REG, tileCount: 0 }), null);
});
