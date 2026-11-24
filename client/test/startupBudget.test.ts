/** NFR-04/NFR-05: cold start <=1.8 s, warm start <=600 ms — the pinned ledger. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLD_START_BUDGET_MS,
  DEFERRED_UNTIL_INTERACTIVE,
  STARTUP_PHASES,
  WARM_START_BUDGET_MS,
  deferredWorkStaysOffCriticalPath,
  isDeferredUntilInteractive,
  phaseTotal,
  planStartup,
  startupBudgetHonoursNfr04Nfr05,
  startupBudgetMs,
  startupWithinBudget,
} from "../src/presence/startupBudget.js";

test("the budgets are the NFR-04/NFR-05 figures", () => {
  assert.equal(COLD_START_BUDGET_MS, 1800);
  assert.equal(WARM_START_BUDGET_MS, 600);
  assert.equal(startupBudgetMs("cold"), 1800);
  assert.equal(startupBudgetMs("warm"), 600);
});

test("the pinned ledger fills both budgets exactly and passes the audit", () => {
  assert.equal(phaseTotal(STARTUP_PHASES, "cold"), COLD_START_BUDGET_MS);
  assert.equal(phaseTotal(STARTUP_PHASES, "warm"), WARM_START_BUDGET_MS);
  assert.ok(startupWithinBudget(STARTUP_PHASES));
  assert.ok(startupBudgetHonoursNfr04Nfr05());
});

test("warm start never pays for the resident native runtime or JS bundle", () => {
  const native = STARTUP_PHASES.find((p) => p.phase === "native-init");
  const bundle = STARTUP_PHASES.find((p) => p.phase === "js-bundle-load");
  assert.equal(native?.warmMs, 0);
  assert.equal(bundle?.warmMs, 0);
});

test("no warm phase is dearer than its cold twin", () => {
  for (const phase of STARTUP_PHASES) {
    assert.ok(phase.warmMs <= phase.coldMs, `${phase.phase} must not cost more warm than cold`);
  }
});

test("an over-budget ledger fails the audit loudly", () => {
  const greedy = [{ phase: "everything", coldMs: 1900, warmMs: 700 }];
  assert.equal(startupWithinBudget(greedy), false);
});

test("garbage allocations fail closed", () => {
  assert.equal(startupWithinBudget([{ phase: "x", coldMs: Number.NaN, warmMs: 0 }]), false);
  assert.equal(startupWithinBudget([{ phase: "x", coldMs: 10, warmMs: -1 }]), false);
  assert.equal(startupWithinBudget([{ phase: "x", coldMs: 10, warmMs: 20 }]), false);
});

test("deferred work stays off the critical path", () => {
  assert.ok(deferredWorkStaysOffCriticalPath());
  assert.ok(deferredWorkStaysOffCriticalPath(STARTUP_PHASES));
  for (const work of DEFERRED_UNTIL_INTERACTIVE) {
    assert.ok(isDeferredUntilInteractive(work));
    assert.equal(STARTUP_PHASES.some((p) => p.phase === work), false, `${work} must be deferred`);
  }
  assert.equal(isDeferredUntilInteractive("first-render"), false);
});

test("planStartup exposes the mode, budget and pinned phases", () => {
  const cold = planStartup("cold");
  assert.equal(cold.mode, "cold");
  assert.equal(cold.budgetMs, 1800);
  assert.equal(cold.phases, STARTUP_PHASES);
  assert.equal(planStartup("warm").budgetMs, 600);
});
