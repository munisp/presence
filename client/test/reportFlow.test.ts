import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_SCREENS,
  MAX_SAFETY_TAPS,
  MONETISATION_FIELDS,
  SAFETY_ACTIONS,
  SAFETY_TRAY_ENTRY,
  SAFETY_WIRE,
  planSafetyAccess,
  safetyAccessHonoursBr07,
  safetyPlanViolations,
  safetyScreenViolations,
} from "../src/presence/reportFlow.js";

test("the action registry is exactly the five the SRS names", () => {
  assert.deepEqual([...SAFETY_ACTIONS], [
    "report",
    "block",
    "withdraw-consent",
    "delete-account",
    "privacy-controls",
  ]);
});

test("every wire endpoint is pinned and ungated", () => {
  assert.equal(SAFETY_WIRE.report, "POST /v1/reports");
  assert.equal(SAFETY_WIRE.block, "POST /v1/blocks");
  assert.equal(SAFETY_WIRE["withdraw-consent"], "DELETE /v1/account/consents/{purpose}");
  assert.equal(SAFETY_WIRE["delete-account"], "DELETE /v1/account");
  assert.equal(SAFETY_WIRE["privacy-controls"], "GET /v1/account/consents");
});

test("every screen reaches every action inside the two-tap budget", () => {
  for (const screen of APP_SCREENS) {
    for (const action of SAFETY_ACTIONS) {
      const plan = planSafetyAccess(screen, action);
      assert.notEqual(plan, null);
      assert.ok(plan!.taps <= MAX_SAFETY_TAPS);
      assert.equal(plan!.free, true);
      assert.deepEqual(plan!.path, [SAFETY_TRAY_ENTRY, action]);
    }
  }
});

test("plans are free by construction and travel on the pinned wire", () => {
  const plan = planSafetyAccess("conversation-thread", "report")!;
  assert.equal(plan.endpoint, "POST /v1/reports");
  assert.equal(plan.free, true);
  assert.equal("price" in plan, false);
});

test("unknown screens and actions refuse", () => {
  assert.equal(planSafetyAccess("admin-console", "report"), null);
  assert.equal(planSafetyAccess("settings", "boost-profile"), null);
  assert.equal(planSafetyAccess("", ""), null);
});

test("a screen without the safety-tray entry is a violation", () => {
  assert.equal(
    safetyScreenViolations({ name: "discovery", affordances: [SAFETY_TRAY_ENTRY] }).length,
    0,
  );
  assert.deepEqual(
    safetyScreenViolations({ name: "discovery", affordances: ["refresh"] }),
    ["safety-entry"],
  );
  assert.ok(
    safetyScreenViolations({ name: "unknown", affordances: [] }).includes("screen"),
  );
});

test("monetisation fields on a screen descriptor are violations", () => {
  const violations = safetyScreenViolations({
    name: "settings",
    affordances: [SAFETY_TRAY_ENTRY],
    fields: { paywall: true },
  });
  assert.deepEqual(violations, ["monetisation:paywall"]);
});

test("a plan over the tap budget or off the pinned wire is a violation", () => {
  const good = planSafetyAccess("settings", "block")!;
  assert.equal(safetyPlanViolations(good).length, 0);
  const slow = { ...good, taps: 3 };
  assert.ok(safetyPlanViolations(slow).includes("taps"));
  const rerouted = { ...good, endpoint: "POST /v1/premium/block" };
  assert.ok(safetyPlanViolations(rerouted).includes("endpoint"));
  const gated = { ...good, free: false as unknown as true };
  assert.ok(safetyPlanViolations(gated).includes("free"));
});

test("a monetisation field smuggled onto a plan is flagged", () => {
  const plan = planSafetyAccess("settings", "report")!;
  for (const field of MONETISATION_FIELDS) {
    const smuggled = { ...plan, [field]: 1 } as typeof plan;
    assert.ok(
      safetyPlanViolations(smuggled).includes(`monetisation:${field}`),
      field,
    );
  }
});

test("the master guard proves the whole matrix", () => {
  assert.equal(safetyAccessHonoursBr07(), true);
});
