/** FR-05/FR-07 device enrolment unit tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEVICE_LABEL_MAX_LEN,
  DEVICE_LIMIT,
  attestationKeyHash,
  deviceFingerprint,
  parseDeviceBody,
} from "../src/devices.js";
import { screenText } from "../src/screening.js";

test("the concurrent device cap is three (FR-05)", () => {
  assert.equal(DEVICE_LIMIT, 3);
});

test("attestation key hash is the SHA-256 of the assertion (FR-07)", () => {
  const hash = attestationKeyHash("assertion-1");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, attestationKeyHash("assertion-1"));
  assert.notEqual(hash, attestationKeyHash("assertion-2"));
});

test("device fingerprint is scoped to the account (FR-05)", () => {
  const fp = deviceFingerprint("user-a", "assertion-1");
  assert.match(fp, /^[0-9a-f]{64}$/);
  // Same key on a second account yields a different fingerprint — the
  // cross-account signal comes from the key hash, not the device row.
  assert.notEqual(fp, deviceFingerprint("user-b", "assertion-1"));
  assert.notEqual(fp, attestationKeyHash("assertion-1"));
});

test("parseDeviceBody: the label is optional", () => {
  for (const body of [null, undefined, {}, { label: null }, { label: "  " }]) {
    const out = parseDeviceBody(body, screenText);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.label, null);
  }
});

test("parseDeviceBody: a real label is trimmed and kept", () => {
  const out = parseDeviceBody({ label: "  Work phone  " }, screenText);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.label, "Work phone");
});

test("parseDeviceBody: malformed labels are rejected", () => {
  assert.equal(parseDeviceBody("nope", screenText).ok, false);
  assert.equal(parseDeviceBody({ label: 42 }, screenText).ok, false);
  const tooLong = parseDeviceBody({ label: "x".repeat(DEVICE_LABEL_MAX_LEN + 1) }, screenText);
  assert.equal(tooLong.ok, false);
  const atCap = parseDeviceBody({ label: "x".repeat(DEVICE_LABEL_MAX_LEN) }, screenText);
  assert.equal(atCap.ok, true);
});

test("parseDeviceBody: labels pass screening (SEC-26 idiom)", () => {
  const out = parseDeviceBody({ label: "call me on 08012345678" }, screenText);
  assert.equal(out.ok, false);
});
