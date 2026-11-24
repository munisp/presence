/** TR-31: BLE rotating derived codes — never a stable identifier. */

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";

import {
  BLE_ROTATION_PERIOD_S,
  advertisementDiscardsIdentifiers,
  bleWindowIndex,
  deriveBleCode,
  nextRotationAtS,
  rotationPeriodWithinLimit,
  secondsUntilRotation,
  toAdvertisement,
  verifyBleCode,
} from "../src/presence/bleCodes.js";
import { hmacSha256, sha256, toHex, utf8 } from "../src/presence/sha256.js";

/** FR-16 session ids are 128-bit hex — a plausible live example. */
const SESSION = "0123456789abcdef0123456789abcdef";

// ------------------------------------------------------- sha256 support --

test("sha256 matches the FIPS published vectors", () => {
  assert.equal(toHex(sha256(utf8("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(toHex(sha256(utf8(""))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(
    toHex(sha256(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("hmac-sha256 matches RFC 4231 test cases 1 and 2", () => {
  const key1 = new Uint8Array(20).fill(0x0b);
  assert.equal(
    toHex(hmacSha256(key1, utf8("Hi There"))),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
  assert.equal(
    toHex(hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?"))),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});

test("the in-repo digest agrees with node:crypto on arbitrary input", () => {
  const msg = utf8("presence cross-check vector with a longer, boundary-crossing payload!!");
  assert.equal(toHex(sha256(msg)), createHash("sha256").update(msg).digest("hex"));
  assert.equal(
    toHex(hmacSha256(utf8("presence-ble-v1"), msg)),
    createHmac("sha256", utf8("presence-ble-v1")).update(msg).digest("hex"),
  );
});

// ------------------------------------------------------------- rotation --

test("the rotation period is within the SRS 15-minute cap (TR-31)", () => {
  assert.equal(BLE_ROTATION_PERIOD_S, 900);
  assert.ok(rotationPeriodWithinLimit());
  assert.ok(!rotationPeriodWithinLimit(901));
  assert.ok(!rotationPeriodWithinLimit(0));
});

test("derivation is deterministic within a window", () => {
  assert.equal(deriveBleCode(SESSION, 1_000), deriveBleCode(SESSION, 1_000));
  assert.equal(deriveBleCode(SESSION, 1_000), deriveBleCode(SESSION, 1_799));
});

test("codes rotate every window — a captured code cannot be tracked (TR-31)", () => {
  const w0 = deriveBleCode(SESSION, 0);
  const w1 = deriveBleCode(SESSION, BLE_ROTATION_PERIOD_S);
  const w2 = deriveBleCode(SESSION, 2 * BLE_ROTATION_PERIOD_S);
  assert.notEqual(w0, w1);
  assert.notEqual(w1, w2);
  assert.notEqual(w0, w2);
});

test("the advertised code is never the session id itself", () => {
  const code = deriveBleCode(SESSION, 5_000);
  assert.match(code, /^[0-9a-f]{32}$/);
  assert.notEqual(code, SESSION);
  // Different sessions advertise different codes in the same window.
  const other = deriveBleCode("ffffffffffffffffffffffffffffffff", 5_000);
  assert.notEqual(code, other);
});

test("the advertisement carries only the derived code (TR-31)", () => {
  const ad = toAdvertisement(SESSION, 12_345);
  assert.equal(advertisementDiscardsIdentifiers(ad), true);
  assert.deepEqual(Object.keys(ad), ["code"]);
});

test("window helpers agree at boundaries", () => {
  assert.equal(bleWindowIndex(0), 0);
  assert.equal(bleWindowIndex(899), 0);
  assert.equal(bleWindowIndex(900), 1);
  assert.equal(secondsUntilRotation(0), 900);
  assert.equal(secondsUntilRotation(1), 899);
  assert.equal(secondsUntilRotation(899), 1);
  assert.equal(nextRotationAtS(0), 900);
  assert.equal(nextRotationAtS(901), 1800);
});

// ----------------------------------------------------------- receivers --

test("a receiver verifies the current window and one lookback, never more", () => {
  const t0 = BLE_ROTATION_PERIOD_S * 10;
  const code = deriveBleCode(SESSION, t0);
  // Same window: verifies.
  assert.equal(verifyBleCode(SESSION, code, t0 + 60), true);
  // One window later: still verifies (boundary clock skew).
  assert.equal(verifyBleCode(SESSION, code, t0 + BLE_ROTATION_PERIOD_S + 30), true);
  // Two windows later: stale — rejected.
  assert.equal(verifyBleCode(SESSION, code, t0 + 2 * BLE_ROTATION_PERIOD_S), false);
  // A code from the FUTURE never verifies.
  const future = deriveBleCode(SESSION, t0 + BLE_ROTATION_PERIOD_S);
  assert.equal(verifyBleCode(SESSION, future, t0), false);
});

test("verification rejects malformed codes and wrong sessions", () => {
  const t0 = 7_777;
  assert.equal(verifyBleCode(SESSION, "not-a-code", t0), false);
  assert.equal(verifyBleCode(SESSION, deriveBleCode(SESSION, t0).toUpperCase(), t0), false);
  assert.equal(verifyBleCode("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", deriveBleCode(SESSION, t0), t0), false);
});
