/** Account tests: FR-02 age declaration boundary and neutral block helper. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AGE_LIMIT, DISCOVERY_BLOCKED_ERROR, isUnderage } from "../src/routes/account.js";

test("FR-02: the age limit is 18", () => {
  assert.equal(AGE_LIMIT, 18);
});

test("FR-02: under-18 is blocked, 18 and over is not (year precision)", () => {
  const ref = 2026;
  assert.equal(isUnderage(2010, ref), true); // 16
  assert.equal(isUnderage(2009, ref), true); // 17
  assert.equal(isUnderage(2008, ref), false); // turns 18 this year
  assert.equal(isUnderage(1990, ref), false);
  // boundary fails toward blocking: someone born THIS year is 0, not 18
  assert.equal(isUnderage(ref, ref), true);
});

test("FR-02: the block message is neutral — no reason is disclosed", () => {
  assert.equal(DISCOVERY_BLOCKED_ERROR.includes("18"), false);
  assert.equal(DISCOVERY_BLOCKED_ERROR.toLowerCase().includes("age"), false);
  assert.equal(DISCOVERY_BLOCKED_ERROR.toLowerCase().includes("delete"), false);
});
