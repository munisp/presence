/** NFR-29/NFR-30: foreground <=2%/h duty-cycle ledger; empty background registry. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKGROUND_WORK_WHEN_PRESENCE_OFF,
  BACKGROUND_WORK_WHEN_PRESENCE_ON,
  CELL_COMPUTE_COST_MP,
  FIXED_CONSUMERS,
  FOREGROUND_BUDGET_MP_PER_HOUR,
  FOREGROUND_BUDGET_PERCENT_PER_HOUR,
  PUBLISH_COST_MP,
  activationsPerHour,
  backgroundParityHonoursNfr30,
  backgroundWorkSet,
  foregroundMilliPercentPerHour,
  foregroundWithinBudget,
  powerBudgetHonoursNfr29,
} from "../src/presence/powerBudget.js";
import { REDUCED_PUBLISH_INTERVAL_S, STANDARD_PUBLISH_INTERVAL_S } from "../src/presence/powerMode.js";

test("the ceiling is the NFR-29 figure: 2 %/h, 2000 mp/h", () => {
  assert.equal(FOREGROUND_BUDGET_PERCENT_PER_HOUR, 2);
  assert.equal(FOREGROUND_BUDGET_MP_PER_HOUR, 2000);
});

test("activations derive from the FR-85 cadence, never duplicated", () => {
  assert.equal(activationsPerHour("standard"), 3600 / STANDARD_PUBLISH_INTERVAL_S);
  assert.equal(activationsPerHour("reduced"), 3600 / REDUCED_PUBLISH_INTERVAL_S);
  assert.equal(activationsPerHour("standard"), 12);
  assert.equal(activationsPerHour("reduced"), 6);
});

test("both power modes fit the NFR-29 ceiling", () => {
  assert.ok(foregroundWithinBudget("standard"));
  assert.ok(foregroundWithinBudget("reduced"));
  assert.ok(powerBudgetHonoursNfr29());
  assert.ok(foregroundMilliPercentPerHour("standard") <= 2000);
  assert.ok(foregroundMilliPercentPerHour("reduced") <= 2000);
});

test("reduced mode is strictly cheaper — the FR-85 trade-off in numbers", () => {
  assert.ok(foregroundMilliPercentPerHour("reduced") < foregroundMilliPercentPerHour("standard"));
  const saving =
    foregroundMilliPercentPerHour("standard") - foregroundMilliPercentPerHour("reduced");
  assert.equal(saving, 6 * (PUBLISH_COST_MP + CELL_COMPUTE_COST_MP));
});

test("the ledger decomposes exactly into fixed plus per-activation work", () => {
  const fixed = FIXED_CONSUMERS.reduce((total, c) => total + c.milliPercentPerHour, 0);
  assert.equal(
    foregroundMilliPercentPerHour("standard"),
    fixed + 12 * (PUBLISH_COST_MP + CELL_COMPUTE_COST_MP),
  );
});

test("NFR-30: background presence off means NO background work — parity structurally", () => {
  assert.deepEqual(BACKGROUND_WORK_WHEN_PRESENCE_OFF, []);
  assert.deepEqual(backgroundWorkSet(false), []);
  assert.ok(backgroundParityHonoursNfr30());
});

test("opting in registers exactly the BLE central wake", () => {
  assert.deepEqual(backgroundWorkSet(true), BACKGROUND_WORK_WHEN_PRESENCE_ON);
  assert.deepEqual([...backgroundWorkSet(true)], ["ble-central-wake"]);
});

test("anything but a literal true reads as off (fail closed)", () => {
  assert.deepEqual(backgroundWorkSet(undefined as unknown as boolean), []);
  assert.deepEqual(backgroundWorkSet(null as unknown as boolean), []);
  assert.deepEqual(backgroundWorkSet(1 as unknown as boolean), []);
});
