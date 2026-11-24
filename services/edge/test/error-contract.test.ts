/**
 * Batch 26 — TR-25 machine error codes + FR-58 delivery-side switches.
 *
 * TR-25: error codes are derived from the test-pinned human message, so a
 * message that keeps passing its contract test keeps its code; retryable is
 * true only for 429 and 5xx.
 *
 * FR-58: shouldNotify is the single gate for realtime notification delivery.
 * Safety always passes — not the switch, not the quiet window. Any other
 * category respects both.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { errorCodeFor, isRetryable } from "../src/errors.js";
import { shouldNotify } from "../src/notifications.js";

test("TR-25: codes derive from status and the pinned message", () => {
  assert.equal(errorCodeFor(404, "pair not found"), "404.pair_not_found");
  assert.equal(errorCodeFor(409, "illegal consent transition (FR-29)"), "409.illegal_consent_transition");
  assert.equal(errorCodeFor(422, "presence moved implausibly fast (SEC-20)"), "422.presence_moved_implausibly_fast");
  assert.equal(errorCodeFor(429, "hourly scan limit reached (SEC-20)"), "429.hourly_scan_limit_reached");
  // Long messages cap at four words — stable and short.
  assert.equal(errorCodeFor(403, "discovery is disabled for this account right now"), "403.discovery_is_disabled_for");
});

test("TR-25: retry hint is true only for 429 and 5xx", () => {
  assert.equal(isRetryable(429), true);
  assert.equal(isRetryable(500), true);
  assert.equal(isRetryable(503), true);
  for (const s of [400, 401, 403, 404, 409, 422]) assert.equal(isRetryable(s), false);
});

test("FR-58: safety notices always pass — switch and quiet window cannot stop them", () => {
  const quietAllDay = { quiet: { start: "00:00", end: "23:59" } };
  const now = new Date("2026-11-24T12:00:00Z");
  assert.equal(shouldNotify({ safety: true }, "safety", now), true);
  assert.equal(shouldNotify({}, "safety", now), true);
  // A stored false is impossible via applyPrefsPatch, but even a hostile
  // stored blob must not silence safety.
  assert.equal(shouldNotify({ safety: false, ...quietAllDay }, "safety", now), true);
});

test("FR-58: non-safety categories respect the switch", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  assert.equal(shouldNotify({ matches: false }, "matches", now), false);
  assert.equal(shouldNotify({ matches: true }, "matches", now), true);
  assert.equal(shouldNotify({ nudges: false }, "nudges", now), false);
  // Default-on: an absent key means on.
  assert.equal(shouldNotify({}, "announcements", now), true);
  assert.equal(shouldNotify(null, "offers", now), true);
});

test("FR-58: the quiet window suppresses non-safety, never safety", () => {
  const stored = { quiet: { start: "22:00", end: "07:00" } }; // wraps midnight
  const night = new Date("2026-11-24T23:30:00Z");
  const day = new Date("2026-11-24T12:00:00Z");
  assert.equal(shouldNotify(stored, "nudges", night), false);
  assert.equal(shouldNotify(stored, "nudges", day), true);
  assert.equal(shouldNotify(stored, "safety", night), true);
});
