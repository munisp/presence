/** TR-29: on-device cell computation — coordinates never travel. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_FIX_ACCURACY_M,
  PRESENCE_H3_RESOLUTION,
  computePresenceCell,
  payloadDiscardsCoordinates,
  toPublishPayload,
  type LocationFix,
} from "../src/presence/cell.js";

/** Unilag quad — a valid, accurate fix. */
const LAGOS_FIX: LocationFix = { latitude: 6.5244, longitude: 3.3792, accuracyM: 12 };

test("the publish resolution matches the server contract (TR-12)", () => {
  assert.equal(PRESENCE_H3_RESOLUTION, 9);
});

test("a fix computes to a single H3 cell id", () => {
  const cell = computePresenceCell(LAGOS_FIX);
  assert.equal(typeof cell, "string");
  assert.equal(cell.length, 15);
});

test("computation is deterministic — the same fix yields the same cell", () => {
  assert.equal(computePresenceCell(LAGOS_FIX), computePresenceCell(LAGOS_FIX));
});

test("the publish payload carries the cell and nothing coordinate-shaped (TR-29)", () => {
  const payload = toPublishPayload(LAGOS_FIX);
  assert.ok(payload);
  assert.equal(payloadDiscardsCoordinates(payload), true);
  assert.deepEqual(Object.keys(payload), ["cell"]);
  assert.equal(payload.cell, computePresenceCell(LAGOS_FIX));
});

test("an approximate-only fix refuses to publish (FR-88)", () => {
  assert.equal(toPublishPayload({ ...LAGOS_FIX, accuracyM: MAX_FIX_ACCURACY_M + 1 }), null);
  assert.equal(toPublishPayload({ ...LAGOS_FIX, accuracyM: MAX_FIX_ACCURACY_M }) !== null, true);
  assert.equal(toPublishPayload({ ...LAGOS_FIX, accuracyM: 0 }), null);
  assert.equal(toPublishPayload({ ...LAGOS_FIX, accuracyM: -5 }), null);
});

test("nearby fixes share a cell; distant fixes do not", () => {
  const near = computePresenceCell({ latitude: 6.5244, longitude: 3.37925, accuracyM: 10 });
  const far = computePresenceCell({ latitude: 51.5074, longitude: -0.1278, accuracyM: 10 });
  assert.equal(near, computePresenceCell(LAGOS_FIX));
  assert.notEqual(far, computePresenceCell(LAGOS_FIX));
});
