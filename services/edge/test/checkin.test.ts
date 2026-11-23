/** FR-100 check-in token unit tests: mint/verify round-trip and refusal. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHECKIN_TOKEN_TTL_MAX_S,
  mintCheckinToken,
  newCheckinClaims,
  verifyCheckinToken,
} from "../src/checkin.js";

const SECRET = "a".repeat(64); // 32 bytes hex
const OTHER_SECRET = "b".repeat(64);
const NOW = 1_800_000_000;

test("mint/verify round-trip", () => {
  const claims = newCheckinClaims("venue-1", "L2", 60, NOW);
  const token = mintCheckinToken(claims, SECRET);
  const out = verifyCheckinToken(token, SECRET, NOW + 30);
  assert.deepEqual(out, claims);
});

test("tampered signature is rejected", () => {
  const token = mintCheckinToken(newCheckinClaims("venue-1", "L2", 60, NOW), SECRET);
  const [v, body] = token.split(".");
  const forged = `${v}.${body}.${"c".repeat(43)}`;
  assert.equal(verifyCheckinToken(forged, SECRET, NOW + 1), null);
});

test("wrong secret is rejected", () => {
  const token = mintCheckinToken(newCheckinClaims("venue-1", "L2", 60, NOW), OTHER_SECRET);
  assert.equal(verifyCheckinToken(token, SECRET, NOW + 1), null);
});

test("expired tokens are rejected (FR-100)", () => {
  const token = mintCheckinToken(newCheckinClaims("venue-1", "L2", 60, NOW), SECRET);
  assert.equal(verifyCheckinToken(token, SECRET, NOW + 61), null);
});

test("malformed tokens are rejected without an oracle", () => {
  for (const bad of ["", "pc1", "pc1..x", "v2.abc.def", "pc1.not-json.sig", "pc1.@@@.sig"]) {
    assert.equal(verifyCheckinToken(bad, SECRET, NOW), null, `expected rejection of ${bad}`);
  }
});

test("ttl is clamped to the FR-100 ceiling", () => {
  const claims = newCheckinClaims("venue-1", "L2", 99_999, NOW);
  assert.equal(claims.exp - NOW, CHECKIN_TOKEN_TTL_MAX_S);
  const floor = newCheckinClaims("venue-1", "L2", 0, NOW);
  assert.equal(floor.exp - NOW, 1);
});

test("claims with missing fields are rejected", () => {
  // valid signature over malformed claims — the shape check must catch it
  const malformed = mintCheckinToken(
    { vid: "v", exp: NOW + 60 } as unknown as ReturnType<typeof newCheckinClaims>,
    SECRET,
  );
  assert.equal(verifyCheckinToken(malformed, SECRET, NOW), null);
});
