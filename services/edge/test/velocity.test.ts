/** Velocity tests: SEC-20 travel math and the hourly/daily ceilings. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  impliedSpeedKmh,
  isImpossibleTravel,
  kmPerGridStep,
  MAX_PLAUSIBLE_KMH,
  SCAN_HOURLY_MAX,
  WAVE_DAILY_MAX,
} from "../src/velocity.js";

test("SEC-20: one grid step at res 9 is about 302 m", () => {
  assert.ok(Math.abs(kmPerGridStep(9) - 0.302) < 0.001);
  // finer resolutions move proportionally less per step
  assert.ok(kmPerGridStep(10) < kmPerGridStep(9));
  assert.ok(kmPerGridStep(11) < kmPerGridStep(10));
  assert.throws(() => kmPerGridStep(7));
});

test("SEC-20: implied speed scales with steps and shrinks with elapsed time", () => {
  const oneStepOneHour = impliedSpeedKmh(1, 9, 3_600_000);
  assert.ok(Math.abs(oneStepOneHour - 0.302) < 0.001);
  const twoSteps = impliedSpeedKmh(2, 9, 3_600_000);
  assert.ok(Math.abs(twoSteps - oneStepOneHour * 2) < 1e-9);
  const halfHour = impliedSpeedKmh(1, 9, 1_800_000);
  assert.ok(Math.abs(halfHour - oneStepOneHour * 2) < 1e-9);
});

test("SEC-20: zero or negative elapsed time is always impossible", () => {
  assert.equal(impliedSpeedKmh(1, 9, 0), Number.POSITIVE_INFINITY);
  assert.equal(isImpossibleTravel(1, 9, 0), true);
  assert.equal(isImpossibleTravel(0, 9, -5), true);
});

test("SEC-20: plausible drives pass, teleports trip", () => {
  // 1 000 res-9 steps ≈ 302 km in an hour — a fast drive, allowed.
  assert.equal(isImpossibleTravel(1_000, 9, 3_600_000), false);
  // 2 000 steps ≈ 604 km in an hour — no vehicle does that.
  assert.equal(isImpossibleTravel(2_000, 9, 3_600_000), true);
  // Same distance over a day is fine.
  assert.equal(isImpossibleTravel(2_000, 9, 24 * 3_600_000), false);
  // A zero-step heartbeat is never impossible.
  assert.equal(isImpossibleTravel(0, 9, 1_000), false);
  // The threshold itself is generous — trips on teleports only.
  assert.ok(MAX_PLAUSIBLE_KMH >= 300);
});

test("SEC-20: the hourly and daily ceilings match the spec", () => {
  assert.equal(SCAN_HOURLY_MAX, 200);
  assert.equal(WAVE_DAILY_MAX, 20);
});
