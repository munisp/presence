/** NFR-35/NFR-36: 60 fps render ledger (30 fps floor); ambient refresh <=1/min, no radio wake. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ambientHonoursSec35 } from "../src/presence/ambientSurfaces.js";
import {
  AMBIENT_NETWORK_FETCHES_PER_REFRESH,
  AMBIENT_REFRESH_MIN_INTERVAL_MS,
  AMBIENT_REFRESH_SOURCES,
  FRAME_BUDGET_MS,
  FRAME_FLOOR_MS,
  MATCH_SURFACE_RENDER_PHASES,
  ambientRefreshAllowed,
  ambientRefreshHonoursNfr36,
  frameBudgetHonoursNfr35,
  isAmbientRefreshSource,
  planAmbientRefresh,
  renderBudgetTotal,
  renderWithinFrameBudget,
} from "../src/presence/frameBudget.js";

test("the frame budget is one 60 fps frame, the floor one 30 fps frame", () => {
  assert.ok(Math.abs(FRAME_BUDGET_MS - 1000 / 60) < 1e-9);
  assert.ok(Math.abs(FRAME_FLOOR_MS - 1000 / 30) < 1e-9);
  assert.ok(FRAME_BUDGET_MS < FRAME_FLOOR_MS);
});

test("the pinned render ledger fits the 60 fps budget AND the 30 fps floor", () => {
  assert.equal(renderBudgetTotal(MATCH_SURFACE_RENDER_PHASES), 16);
  assert.ok(renderWithinFrameBudget(MATCH_SURFACE_RENDER_PHASES));
  assert.ok(frameBudgetHonoursNfr35());
});

test("a render plan that misses the 30 fps floor fails loudly", () => {
  const heavy = [{ phase: "everything", ms: 40 }];
  assert.equal(renderWithinFrameBudget(heavy), false);
  const overBudgetUnderFloor = [{ phase: "most", ms: 20 }];
  assert.equal(renderWithinFrameBudget(overBudgetUnderFloor), false);
});

test("garbage render phases fail closed", () => {
  assert.equal(renderWithinFrameBudget([{ phase: "x", ms: Number.NaN }]), false);
  assert.equal(renderWithinFrameBudget([{ phase: "x", ms: -1 }]), false);
});

test("the ambient refresh interval is one minute", () => {
  assert.equal(AMBIENT_REFRESH_MIN_INTERVAL_MS, 60_000);
});

test("the refresh gate allows a first refresh and enforces the minute", () => {
  assert.ok(ambientRefreshAllowed(null, 1_000));
  assert.equal(ambientRefreshAllowed(0, 59_999), false);
  assert.ok(ambientRefreshAllowed(0, 60_000));
  assert.equal(ambientRefreshAllowed(60_000, 119_999), false);
  assert.ok(ambientRefreshAllowed(60_000, 120_000));
});

test("garbage clocks refuse the refresh (fail closed)", () => {
  assert.equal(ambientRefreshAllowed(Number.NaN, 100_000), false);
  assert.equal(ambientRefreshAllowed(0, Number.NaN), false);
  assert.equal(ambientRefreshAllowed(null, Number.NaN), false);
  assert.equal(ambientRefreshAllowed(100_000, 50_000), false);
});

test("poll is not a refresh source — an idle device never wakes the radio", () => {
  assert.deepEqual([...AMBIENT_REFRESH_SOURCES], ["push", "app-active"]);
  assert.equal(isAmbientRefreshSource("poll"), false);
  assert.ok(isAmbientRefreshSource("push"));
  assert.ok(isAmbientRefreshSource("app-active"));
  assert.equal(AMBIENT_NETWORK_FETCHES_PER_REFRESH, 0);
  assert.ok(ambientRefreshHonoursNfr36());
});

test("an approved refresh carries the SEC-35 contentless payload built locally", () => {
  const plan = planAmbientRefresh(true, null, 1_000);
  assert.equal(plan.action, "refresh");
  if (plan.action === "refresh") {
    assert.deepEqual(plan.payload, { kind: "presence-ambient", active: true });
    assert.ok(ambientHonoursSec35(plan.payload));
  }
});

test("a refused refresh carries no payload and names its reason", () => {
  assert.deepEqual(planAmbientRefresh(true, 0, 59_999), { action: "skip", reason: "interval" });
  assert.deepEqual(planAmbientRefresh(true, Number.NaN, 0), {
    action: "skip",
    reason: "invalid-clock",
  });
});
