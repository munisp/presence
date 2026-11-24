/** TR-32: clean degradation on denied permissions — no dead ends. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CORE_JOURNEY,
  assertNoDeadEnds,
  resolveCapabilities,
  type PermissionMatrix,
  type PermissionName,
} from "../src/presence/permissions.js";

const ALL_GRANTED: PermissionMatrix = { bluetooth: "granted", location: "granted", push: "granted" };
const ALL_DENIED: PermissionMatrix = { bluetooth: "denied", location: "denied", push: "denied" };

function matrix(overrides: Partial<PermissionMatrix>): PermissionMatrix {
  return { ...ALL_GRANTED, ...overrides };
}

test("all granted: every presence mode and push are available", () => {
  const profile = resolveCapabilities(ALL_GRANTED);
  assert.deepEqual(profile.presenceModes, ["gps-cell", "ble-attestation", "manual-checkin"]);
  assert.equal(profile.notificationChannel, "push");
  assert.equal(profile.degraded, false);
  assert.equal(profile.degradations.length, 0);
});

test("all denied: the journey still has no dead end (TR-32)", () => {
  const profile = resolveCapabilities(ALL_DENIED);
  // Manual check-in is the permission-free floor (FR-99/FR-100).
  assert.deepEqual(profile.presenceModes, ["manual-checkin"]);
  // In-app realtime (Centrifugo) is the notification floor (TECH-06).
  assert.equal(profile.notificationChannel, "in-app");
  assert.equal(profile.degraded, true);
  assert.equal(profile.degradations.length, 3);
  assert.equal(assertNoDeadEnds(profile), true);
});

test("every one of the eight permission combinations is dead-end-free", () => {
  const names: PermissionName[] = ["bluetooth", "location", "push"];
  for (let mask = 0; mask < 8; mask++) {
    const m: PermissionMatrix = {
      bluetooth: mask & 1 ? "granted" : "denied",
      location: mask & 2 ? "granted" : "denied",
      push: mask & 4 ? "granted" : "denied",
    };
    void names;
    const profile = resolveCapabilities(m);
    assert.equal(assertNoDeadEnds(profile), true, `mask ${mask}`);
    // The manual check-in floor is unconditional.
    assert.ok(profile.presenceModes.includes("manual-checkin"));
    // Notifications always have a channel.
    assert.ok(profile.journey.chat.length > 0);
  }
});

test("a denied location degrades to BLE + check-in, with a recovery hint", () => {
  const profile = resolveCapabilities(matrix({ location: "denied" }));
  assert.deepEqual(profile.presenceModes, ["ble-attestation", "manual-checkin"]);
  const d = profile.degradations.find((x) => x.capability === "location");
  assert.ok(d);
  assert.match(d.impact, /GPS cell presence/);
  assert.match(d.recovery, /settings|check in/i);
});

test("a denied bluetooth keeps GPS presence; only attestation is lost", () => {
  const profile = resolveCapabilities(matrix({ bluetooth: "denied" }));
  assert.deepEqual(profile.presenceModes, ["gps-cell", "manual-checkin"]);
  assert.equal(profile.notificationChannel, "push");
});

test("a denied push falls back to in-app realtime, never silence", () => {
  const profile = resolveCapabilities(matrix({ push: "denied" }));
  assert.equal(profile.notificationChannel, "in-app");
  assert.deepEqual(profile.journey.chat, ["in-app"]);
});

test("the core journey is the SRS four-step, and consent is server-driven", () => {
  assert.deepEqual([...CORE_JOURNEY], ["check-in", "discover", "connect", "chat"]);
  const profile = resolveCapabilities(ALL_DENIED);
  // Consent (FR-29 lifecycle) needs no device permission, even all denied.
  assert.deepEqual(profile.journey.connect, ["server-consent"]);
  assert.deepEqual(profile.journey["check-in"], profile.presenceModes);
  assert.deepEqual(profile.journey.discover, profile.presenceModes);
});
