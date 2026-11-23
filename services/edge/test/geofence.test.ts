/** TR-41 geofence authoring unit tests: parse + density gate mirror. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GEOFENCE_MAX_AREA_M2,
  GEOFENCE_MAX_SEGMENT_M,
  GEOFENCE_MIN_AREA_M2,
  GEOFENCE_MIN_VERTICES,
  densityCheck,
  parseGeofencePolygon,
  ringAreaM2,
  segmentLengthM,
} from "../src/geofence.js";

/** A roughly 10 m square around a point, dense by construction. */
function square(lon: number, lat: number, sideM: number): Array<[number, number]> {
  const dLat = sideM / 111_320;
  const dLon = sideM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [
    [lon, lat],
    [lon + dLon, lat],
    [lon + dLon, lat + dLat],
    [lon, lat + dLat],
    [lon, lat],
  ];
}

test("the governed density constants match migration 0017", () => {
  assert.equal(GEOFENCE_MIN_VERTICES, 4);
  assert.equal(GEOFENCE_MIN_AREA_M2, 10);
  assert.equal(GEOFENCE_MAX_AREA_M2, 1_000_000);
  assert.equal(GEOFENCE_MAX_SEGMENT_M, 25);
});

test("a valid single-ring polygon parses", () => {
  const ring = square(3.3792, 6.5244, 12); // Unilag quad-sized
  const out = parseGeofencePolygon({ type: "Polygon", coordinates: [ring] });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.ring.length, 5);
});

test("parse rejects the shapes the console must not store", () => {
  assert.equal(parseGeofencePolygon(null).ok, false);
  assert.equal(parseGeofencePolygon({ type: "Point", coordinates: [3, 6] }).ok, false);
  // Two rings (a hole) are rejected at P0.
  const ring = square(3.3792, 6.5244, 12);
  assert.equal(parseGeofencePolygon({ type: "Polygon", coordinates: [ring, ring] }).ok, false);
  // Unclosed ring (first vertex differs from last).
  assert.equal(
    parseGeofencePolygon({ type: "Polygon", coordinates: [[[3, 6], [3.1, 6], [3.1, 6.1], [3, 6.1]]] }).ok,
    false,
  );
  // Out-of-range lon/lat.
  assert.equal(
    parseGeofencePolygon({ type: "Polygon", coordinates: [[[300, 6], [3.1, 6], [3.1, 6.1], [300, 6]]] }).ok,
    false,
  );
});

test("segment length is a great-circle distance in metres", () => {
  // One degree of latitude is ~111.2 km anywhere.
  const d = segmentLengthM([3.3792, 6.5244], [3.3792, 7.5244]);
  assert.ok(Math.abs(d - 111_195) < 800, `${d}`);
});

test("ring area is in square metres", () => {
  const area = ringAreaM2(square(3.3792, 6.5244, 12));
  assert.ok(area > 130 && area < 160, `${area}`); // ~144 m², geodesic slop
});

test("the density gate passes a dense venue outline", () => {
  // A ~20 m-sided octagon: edges well under 25 m.
  const ring: Array<[number, number]> = [];
  const dLat = 20 / 111_320;
  const dLon = 20 / (111_320 * Math.cos((6.5244 * Math.PI) / 180));
  for (let i = 0; i < 8; i++) {
    const t = (i * Math.PI) / 4;
    ring.push([3.3792 + dLon * Math.cos(t), 6.5244 + dLat * Math.sin(t)]);
  }
  ring.push(ring[0]);
  assert.equal(densityCheck(ring).ok, true);
});

test("the density gate refuses a long-edged polygon and names the segment", () => {
  // A 100 m square: valid shape, but chord error is unacceptable.
  const out = densityCheck(square(3.3792, 6.5244, 100));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.error, /at most 25 m/);
    assert.match(out.error, /segment 1/);
  }
});

test("the density gate refuses out-of-band areas", () => {
  // Tiny: 1 m square — under the 10 m² floor.
  assert.equal(densityCheck(square(3.3792, 6.5244, 1)).ok, false);
  // Huge: a degree-square — over the 1 km² ceiling even though dense.
  const huge: Array<[number, number]> = [];
  for (let i = 0; i <= 200; i++) huge.push([3 + i * 0.0001, 6]);
  for (let i = 0; i <= 200; i++) huge.push([3.02, 6 + i * 0.0001]);
  for (let i = 200; i >= 0; i--) huge.push([3 + i * 0.0001, 6.02]);
  for (let i = 200; i >= 1; i--) huge.push([3, 6 + i * 0.0001]);
  const out = densityCheck(huge);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /between 10 m² and 1 km²/);
});
