/**
 * NFR-28: OS floors and the BLE degradation ladder — pinned floors,
 * boundary behaviour, fail-closed garbage, no dead ends.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ANDROID_FLOOR_API,
  BLE_CAPABILITIES,
  BLE_UNAVAILABLE_NOTICE,
  BLE_WITNESS_ONLY_NOTICE,
  IOS_FLOOR_MAJOR,
  UNSUPPORTED_OS_NOTICE,
  bleFloorHonoursNfr28,
  normaliseCapability,
  osIsSupported,
  resolveBlePlan,
} from "../src/presence/bleFloor.js";
import { assertNoDeadEnds, resolveCapabilities } from "../src/presence/permissions.js";

test("NFR-28: the OS floors are pinned to the SRS numbers", () => {
  assert.equal(IOS_FLOOR_MAJOR, 16);
  assert.equal(ANDROID_FLOOR_API, 29);
});

test("NFR-28: the capability ladder is exactly the three registered levels", () => {
  assert.deepEqual([...BLE_CAPABILITIES], ["advertise+scan", "scan-only", "none"]);
});

test("NFR-28: the floor itself is supported; one below is not", () => {
  assert.ok(osIsSupported({ os: "ios", version: 16 }));
  assert.ok(!osIsSupported({ os: "ios", version: 15 }));
  assert.ok(osIsSupported({ os: "android", version: 29 }));
  assert.ok(!osIsSupported({ os: "android", version: 28 }));
  assert.ok(osIsSupported({ os: "ios", version: 26 }));
  assert.ok(osIsSupported({ os: "android", version: 35 }));
});

test("NFR-28: garbage OS readings fail closed to unsupported", () => {
  assert.ok(!osIsSupported({ os: "ios", version: Number.NaN }));
  assert.ok(!osIsSupported({ os: "ios", version: -1 }));
  assert.ok(!osIsSupported({ os: "android", version: Number.POSITIVE_INFINITY }));
  assert.ok(!osIsSupported({ os: "windows" as never, version: 99 }));
});

test("NFR-28: full capability plans the two-way attestation path", () => {
  const plan = resolveBlePlan({ os: "ios", version: 17 }, "advertise+scan");
  assert.equal(plan.tier, "full");
  assert.equal(plan.attestation, "two-way");
  assert.equal(plan.notice, null);
});

test("NFR-28: scan-only degrades to witness-only with the pinned notice", () => {
  const plan = resolveBlePlan({ os: "android", version: 34 }, "scan-only");
  assert.equal(plan.tier, "degraded");
  assert.equal(plan.attestation, "witness-only");
  assert.equal(plan.notice, BLE_WITNESS_ONLY_NOTICE);
});

test("NFR-28: no BLE degrades to off with the pinned notice", () => {
  const plan = resolveBlePlan({ os: "ios", version: 16 }, "none");
  assert.equal(plan.tier, "degraded");
  assert.equal(plan.attestation, "off");
  assert.equal(plan.notice, BLE_UNAVAILABLE_NOTICE);
});

test("NFR-28: below-floor OS refuses with the pinned upgrade notice", () => {
  const plan = resolveBlePlan({ os: "android", version: 28 }, "advertise+scan");
  assert.equal(plan.tier, "unsupported");
  assert.equal(plan.attestation, "off");
  assert.equal(plan.notice, UNSUPPORTED_OS_NOTICE);
  const ios = resolveBlePlan({ os: "ios", version: 15 }, "scan-only");
  assert.equal(ios.tier, "unsupported");
});

test("NFR-28: garbage capability readings fail closed to the least radio", () => {
  assert.equal(normaliseCapability("Advertise+Scan"), "none");
  assert.equal(normaliseCapability("full"), "none");
  assert.equal(normaliseCapability(undefined), "none");
  assert.equal(normaliseCapability(null), "none");
  assert.equal(normaliseCapability(42), "none");
  assert.equal(normaliseCapability({}), "none");
  // A garbage reading plans the BLE-off degraded tier, never the full one.
  assert.equal(resolveBlePlan({ os: "ios", version: 17 }, "garbage").attestation, "off");
});

test("NFR-28: every supported combination keeps the TR-32 journey alive", () => {
  for (const reading of [
    { os: "ios" as const, version: 16 },
    { os: "ios" as const, version: 18 },
    { os: "android" as const, version: 29 },
    { os: "android" as const, version: 35 },
  ]) {
    for (const capability of BLE_CAPABILITIES) {
      const plan = resolveBlePlan(reading, capability);
      assert.notEqual(plan.tier, "unsupported");
      const profile = resolveCapabilities({
        bluetooth: plan.attestation === "off" ? "denied" : "granted",
        location: "denied",
        push: "denied",
      });
      assert.ok(
        assertNoDeadEnds(profile),
        `dead end at ${reading.os} ${reading.version} / ${capability}`,
      );
    }
  }
});

test("NFR-28: degradation never strands the manual check-in floor", () => {
  // The worst supported case: BLE off, location denied, push denied.
  const profile = resolveCapabilities({
    bluetooth: "denied",
    location: "denied",
    push: "denied",
  });
  assert.ok(profile.presenceModes.includes("manual-checkin"));
  assert.ok(assertNoDeadEnds(profile));
});

test("NFR-28: the master guard holds", () => {
  assert.ok(bleFloorHonoursNfr28());
});
