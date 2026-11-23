/** SEC-09 recovery-phone hash + SEC-17/BR-03 age re-verification unit tests. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  E164_PATTERN,
  normalizePhone,
  parseRecoveryBody,
  recoveryPhoneHash,
} from "../src/recovery.js";
import {
  REVERIFY_CONSISTENCY_YEARS,
  isUnderage,
  reverifyDecision,
} from "../src/routes/account.js";

test("E.164 normalisation strips display punctuation (SEC-09)", () => {
  assert.equal(normalizePhone("+234 801 234 5678"), "+2348012345678");
  assert.equal(normalizePhone("+1 (415) 555-0132"), "+14155550132");
  assert.equal(normalizePhone("+44.20.7946.0958"), "+442079460958");
});

test("E.164 normalisation rejects non-international and implausible input", () => {
  for (const bad of [
    "08012345678", // no country code
    "+012345678", // leading zero after +
    "+12345", // too short
    "+12345678901234567", // too long
    "+1415555CALL",
    "",
    "+",
  ]) {
    assert.equal(normalizePhone(bad), null, bad);
  }
});

test("the stored hash is keyed and hex-shaped (SEC-09)", () => {
  const hash = recoveryPhoneHash("+2348012345678", "test-key");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, recoveryPhoneHash("+2348012345678", "test-key"));
  // The key is what makes the column non-enumerable: same number, other
  // key, unrelated hash.
  assert.notEqual(hash, recoveryPhoneHash("+2348012345678", "other-key"));
  // And the hash is not the unkeyed digest of the digits.
  assert.notEqual(hash, createHash("sha256").update("+2348012345678").digest("hex"));
});

test("formatting variants of one number collide on one hash (SEC-09)", () => {
  const a = recoveryPhoneHash(normalizePhone("+234 801 234 5678")!, "k");
  const b = recoveryPhoneHash(normalizePhone("+2348012345678")!, "k");
  assert.equal(a, b);
});

test("parseRecoveryBody accepts a phone string and nothing else", () => {
  const ok = parseRecoveryBody({ phone: "+234 801 234 5678" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.e164, "+2348012345678");
  for (const body of [null, 42, "phone", {}, { phone: 42 }, { phone: "nope" }]) {
    assert.equal(parseRecoveryBody(body).ok, false, JSON.stringify(body));
  }
});

test("the E.164 pattern is the single source of truth", () => {
  assert.ok(E164_PATTERN.test("+14155550132"));
  assert.ok(!E164_PATTERN.test("14155550132"));
});

test("re-verification demands an adult year (SEC-17/BR-03)", () => {
  // Stored adult year, re-declared underage: refused even though it is
  // "consistent".
  assert.equal(reverifyDecision(1990, 2012, 2026).ok, false);
  assert.equal(isUnderage(2012, 2026), true);
});

test("re-verification demands consistency within ±1 year (BR-03)", () => {
  assert.equal(REVERIFY_CONSISTENCY_YEARS, 1);
  assert.equal(reverifyDecision(1990, 1990, 2026).ok, true);
  assert.equal(reverifyDecision(1990, 1991, 2026).ok, true);
  assert.equal(reverifyDecision(1990, 1989, 2026).ok, true);
  assert.equal(reverifyDecision(1990, 1992, 2026).ok, false); // decade-jump evasion
  assert.equal(reverifyDecision(2005, 1980, 2026).ok, false);
});

test("a failing re-verification never says which check failed", () => {
  const a = reverifyDecision(1990, 2012, 2026); // underage
  const b = reverifyDecision(1990, 1980, 2026); // inconsistent
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  if (!a.ok && !b.ok) assert.equal(a.error, b.error);
});
