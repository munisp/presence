/** Edge helper tests: TR-15 rejection, TR-12/14 ladder, FR-23 key shape,
 *  FR-16 session ids. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { containsCoordinates } from "../src/auth.js";
import { newPresenceSessionId, sessionKey, suppressionKey } from "../src/context.js";
import { FALLBACK_LADDER, resolutionFor } from "../src/markets.js";

test("TR-15: any coordinate-shaped field is rejected", () => {
  assert.equal(containsCoordinates({ lat: 51.5 }), true);
  assert.equal(containsCoordinates({ longitude: -0.1 }), true);
  assert.equal(containsCoordinates({ coords: [0, 0] }), true);
  assert.equal(containsCoordinates({ location: "x" }), true);
  assert.equal(containsCoordinates({ cell: "891f1d4d5afffff" }), false);
  assert.equal(containsCoordinates(null), false);
});

test("TR-12/14: resolution ladder follows venue density", () => {
  // TR-37: the governed fallback ladder matches the seeded market config.
  assert.equal(resolutionFor(0, FALLBACK_LADDER), 9);
  assert.equal(resolutionFor(2_000, FALLBACK_LADDER), 9);
  assert.equal(resolutionFor(2_001, FALLBACK_LADDER), 10);
  assert.equal(resolutionFor(10_000, FALLBACK_LADDER), 10);
  assert.equal(resolutionFor(10_001, FALLBACK_LADDER), 11);
});

test("TR-37: a market's configured ladder calibrates independently", () => {
  const dense = { resDefault: 10, resBusy: 11, resCrowd: 11, busyMinPresences: 500, crowdMinPresences: 5_000 };
  assert.equal(resolutionFor(0, dense), 10);
  assert.equal(resolutionFor(501, dense), 11);
  assert.equal(resolutionFor(5_001, dense), 11);
});

test("FR-23: suppression keys are canonically ordered", () => {
  assert.equal(suppressionKey("b", "a"), suppressionKey("a", "b"));
  assert.equal(suppressionKey("a", "b"), "suppress:a:b");
});

test("FR-16: session ids are 128-bit hex and unique", () => {
  const a = newPresenceSessionId();
  const b = newPresenceSessionId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.match(b, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test("FR-16: the reverse index key names the session", () => {
  const sid = "0123456789abcdef0123456789abcdef";
  assert.equal(sessionKey(sid), `presence:session:${sid}`);
});
