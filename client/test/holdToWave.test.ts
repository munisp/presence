/** FR-82: waving needs a sustained 400 ms press; no tap can wave. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WAVE_CANCEL_PATHS,
  WAVE_PRESS_MIN_MS,
  evaluatePress,
  rampStage,
  tapCannotWave,
  waveProgress,
} from "../src/presence/holdToWave.js";

test("the threshold and cancel paths are pinned (FR-82)", () => {
  assert.equal(WAVE_PRESS_MIN_MS, 400);
  assert.deepEqual(WAVE_CANCEL_PATHS, ["early-release", "off-control"]);
});

test("progressive feedback ramps from 0 to 1 over the threshold", () => {
  assert.equal(waveProgress(0), 0);
  assert.equal(waveProgress(WAVE_PRESS_MIN_MS / 2), 0.5);
  assert.equal(waveProgress(WAVE_PRESS_MIN_MS), 1);
  assert.equal(waveProgress(WAVE_PRESS_MIN_MS * 2), 1, "clamped at full");
});

test("garbage input fails closed to no press", () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(waveProgress(bad), 0);
  }
});

test("the ramp is monotonic non-decreasing in held time", () => {
  let previous = 0;
  for (let held = 0; held <= WAVE_PRESS_MIN_MS * 2; held += 10) {
    const stage = rampStage(held);
    assert.ok(stage >= previous, `monotonic at ${held} ms`);
    previous = stage;
  }
  assert.equal(rampStage(0), 0);
  assert.equal(rampStage(WAVE_PRESS_MIN_MS * 0.25), 1);
  assert.equal(rampStage(WAVE_PRESS_MIN_MS * 0.5), 2);
  assert.equal(rampStage(WAVE_PRESS_MIN_MS), 3);
});

test("wave fires only at or beyond the threshold, on the control", () => {
  assert.equal(evaluatePress(WAVE_PRESS_MIN_MS, false, true), "wave");
  assert.equal(evaluatePress(WAVE_PRESS_MIN_MS * 3, true, true), "wave");
  assert.equal(
    evaluatePress(WAVE_PRESS_MIN_MS - 1, false, true),
    "pressing",
    "one millisecond short is still just pressing",
  );
});

test("early release cancels — it never waves", () => {
  for (const held of [0, 50, 200, WAVE_PRESS_MIN_MS - 1]) {
    assert.equal(evaluatePress(held, true, true), "cancelled-early-release");
  }
});

test("moving off the control cancels at any duration", () => {
  for (const held of [0, 200, WAVE_PRESS_MIN_MS, WAVE_PRESS_MIN_MS * 2]) {
    assert.equal(
      evaluatePress(held, false, false),
      "cancelled-off-control",
      `off-control at ${held} ms`,
    );
    assert.equal(evaluatePress(held, true, false), "cancelled-off-control");
  }
});

test("a single tap cannot wave at any sub-threshold duration", () => {
  for (const tap of [0, 30, 120, 250, WAVE_PRESS_MIN_MS - 1]) {
    assert.ok(tapCannotWave(tap), `tap at ${tap} ms`);
  }
  assert.ok(!tapCannotWave(WAVE_PRESS_MIN_MS), "the threshold itself is not a tap");
});
