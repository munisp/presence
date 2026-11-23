/** Edge helper tests: TR-15 rejection, TR-12/14 ladder, FR-23 key shape,
 *  FR-16 session ids. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { containsCoordinates } from "../src/auth.js";
import { newPresenceSessionId, sessionKey, suppressionKey } from "../src/context.js";
import { resolutionFor } from "../src/routes/presence.js";

test("TR-15: any coordinate-shaped field is rejected", () => {
  assert.equal(containsCoordinates({ lat: 51.5 }), true);
  assert.equal(containsCoordinates({ longitude: -0.1 }), true);
  assert.equal(containsCoordinates({ coords: [0, 0] }), true);
  assert.equal(containsCoordinates({ location: "x" }), true);
  assert.equal(containsCoordinates({ cell: "891f1d4d5afffff" }), false);
  assert.equal(containsCoordinates(null), false);
});

test("TR-12/14: resolution ladder follows venue density", () => {
  assert.equal(resolutionFor(0), 9);
  assert.equal(resolutionFor(2_000), 9);
  assert.equal(resolutionFor(2_001), 10);
  assert.equal(resolutionFor(10_000), 10);
  assert.equal(resolutionFor(10_001), 11);
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
