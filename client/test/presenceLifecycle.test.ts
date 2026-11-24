/** FR-19: background withdrawal within 60 seconds. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKGROUND_WITHDRAWAL_DEADLINE_S,
  WITHDRAWAL_WIRE,
  evaluateVisibilityChange,
  withdrawalHonoursFr19,
} from "../src/presence/presenceLifecycle.js";

test("backgrounding without the opt-in withdraws within 60 seconds (FR-19)", () => {
  const decision = evaluateVisibilityChange("background", { backgroundPresenceEnabled: false });
  assert.equal(decision.action, "withdraw");
  if (decision.action === "withdraw") {
    assert.equal(decision.deadlineS, 60);
    assert.equal(decision.deadlineS, BACKGROUND_WITHDRAWAL_DEADLINE_S);
    assert.deepEqual(decision.wire, { method: "DELETE", path: "/v1/presence" });
  }
});

test("backgrounding with background presence enabled keeps presence live", () => {
  const decision = evaluateVisibilityChange("background", { backgroundPresenceEnabled: true });
  assert.deepEqual(decision, { action: "remain", reason: "background-presence-enabled" });
});

test("returning to the foreground cancels a pending withdrawal", () => {
  const decision = evaluateVisibilityChange("foreground", { backgroundPresenceEnabled: false });
  assert.equal(decision.action, "cancel-pending-withdrawal");
  const withOptIn = evaluateVisibilityChange("foreground", { backgroundPresenceEnabled: true });
  assert.equal(withOptIn.action, "cancel-pending-withdrawal");
});

test("the withdrawal guarantee is pinned: 60 s, DELETE /v1/presence", () => {
  assert.equal(BACKGROUND_WITHDRAWAL_DEADLINE_S, 60);
  assert.deepEqual(WITHDRAWAL_WIRE, { method: "DELETE", path: "/v1/presence" });
  const decision = evaluateVisibilityChange("background", { backgroundPresenceEnabled: false });
  assert.ok(withdrawalHonoursFr19(decision));
  // The guard vacuously accepts non-withdrawal actions.
  assert.ok(
    withdrawalHonoursFr19(
      evaluateVisibilityChange("background", { backgroundPresenceEnabled: true }),
    ),
  );
});
