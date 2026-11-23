/** FR-28 density-scaled match budget unit tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUDGET_BUSY_MIN_POP,
  BUDGET_CROWD_MIN_POP,
  matchBudget,
} from "../src/budget.js";

test("sparse cells get three scans per hour", () => {
  for (const pop of [0, 1, BUDGET_BUSY_MIN_POP - 1]) {
    const b = matchBudget(pop);
    assert.equal(b.band, "sparse");
    assert.equal(b.limit, 3);
    assert.equal(b.windowSeconds, 3600);
  }
});

test("busy cells get two scans per hour", () => {
  for (const pop of [BUDGET_BUSY_MIN_POP, 50, BUDGET_CROWD_MIN_POP - 1]) {
    const b = matchBudget(pop);
    assert.equal(b.band, "busy");
    assert.equal(b.limit, 2);
    assert.equal(b.windowSeconds, 3600);
  }
});

test("crowd cells get one scan per day", () => {
  for (const pop of [BUDGET_CROWD_MIN_POP, 500, 10_000]) {
    const b = matchBudget(pop);
    assert.equal(b.band, "crowd");
    assert.equal(b.limit, 1);
    assert.equal(b.windowSeconds, 86_400);
  }
});

test("the ladder is monotone: denser never means more budget per second", () => {
  const rate = (pop: number) => {
    const b = matchBudget(pop);
    return b.limit / b.windowSeconds;
  };
  assert.ok(rate(0) >= rate(BUDGET_BUSY_MIN_POP));
  assert.ok(rate(BUDGET_BUSY_MIN_POP) >= rate(BUDGET_CROWD_MIN_POP));
});
