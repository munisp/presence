/**
 * FR-90/TR-38: attribution lookup-cell semantics. The SQL path is covered by
 * the pytest source invariants; these tests pin the resolution handling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { cellToParent, latLngToCell } from "h3-js";
import { ATTRIBUTION_RESOLUTION, attributionLookupCell } from "../src/attribution.js";

const LAGOS = { lat: 6.521, lng: 3.371 };

test("governed attribution resolution is 9", () => {
  assert.equal(ATTRIBUTION_RESOLUTION, 9);
});

test("a cell at the attribution resolution maps to itself", () => {
  const cell = latLngToCell(LAGOS.lat, LAGOS.lng, ATTRIBUTION_RESOLUTION);
  assert.equal(attributionLookupCell(cell), cell);
});

test("a finer cell maps to its attribution-resolution parent", () => {
  const fine = latLngToCell(LAGOS.lat, LAGOS.lng, 11);
  assert.equal(
    attributionLookupCell(fine),
    cellToParent(fine, ATTRIBUTION_RESOLUTION),
  );
});

test("a res-10 cell maps to its res-9 parent", () => {
  const cell = latLngToCell(LAGOS.lat, LAGOS.lng, 10);
  const key = attributionLookupCell(cell);
  assert.ok(key !== null);
  assert.equal(key!.length, 15);
  assert.equal(cellToParent(cell, ATTRIBUTION_RESOLUTION), key);
});

test("a cell coarser than the attribution grain cannot claim a polygon", () => {
  const coarse = latLngToCell(LAGOS.lat, LAGOS.lng, 8);
  assert.equal(attributionLookupCell(coarse), null);
});
