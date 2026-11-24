/**
 * FR-51/SEC-19: the attestation crypto contract — challenge shape, signature
 * verification against a real P-256 key, and body parsing strictness.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { test } from "node:test";
import {
  ATTESTATION_CHALLENGE_TTL_S,
  assertionMessage,
  attestedKeyHash,
  challengeKey,
  mintChallenge,
  parseAttestationBody,
  verifyAssertion,
} from "../src/attestation.js";

function makeKeyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { privateKey: pair.privateKey, publicKey };
}

function sign(privateKey: import("node:crypto").KeyObject, message: string): string {
  const s = createSign("sha256");
  s.update(message);
  return s.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
}

test("a challenge is 256 bits and the TTL is the SEC-19 two minutes", () => {
  const c = mintChallenge();
  assert.equal(Buffer.from(c, "base64url").length, 32);
  assert.notEqual(mintChallenge(), c, "challenges are random");
  assert.equal(ATTESTATION_CHALLENGE_TTL_S, 120);
  assert.equal(challengeKey("u1"), "attest:ch:u1");
});

test("a valid assertion verifies against the presented key", () => {
  const { privateKey, publicKey } = makeKeyPair();
  const challenge = mintChallenge();
  const signature = sign(privateKey, assertionMessage(challenge, "u1"));
  assert.equal(verifyAssertion(publicKey, challenge, "u1", signature), true);
});

test("wrong user, wrong challenge or wrong key all fail verification", () => {
  const { privateKey, publicKey } = makeKeyPair();
  const other = makeKeyPair();
  const challenge = mintChallenge();
  const signature = sign(privateKey, assertionMessage(challenge, "u1"));
  assert.equal(verifyAssertion(publicKey, challenge, "u2", signature), false);
  assert.equal(verifyAssertion(publicKey, mintChallenge(), "u1", signature), false);
  assert.equal(verifyAssertion(other.publicKey, challenge, "u1", signature), false);
});

test("malformed inputs never throw — they are simply invalid", () => {
  assert.equal(verifyAssertion("not-base64!!", "c", "u1", "@@@"), false);
  assert.equal(verifyAssertion("", "c", "u1", ""), false);
});

test("the registry hash is sha256 of the public key", () => {
  const { publicKey } = makeKeyPair();
  const h = attestedKeyHash(publicKey);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(attestedKeyHash(publicKey), h, "deterministic");
});

test("parseAttestationBody accepts a well-formed object", () => {
  const parsed = parseAttestationBody({
    platform: "app_attest",
    publicKey: "A".repeat(88) + "==",
    counter: 7,
    signature: "B".repeat(86) + "==",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.platform, "app_attest");
    assert.equal(parsed.value.counter, 7);
  }
});

test("parseAttestationBody rejects each malformed field", () => {
  const base = {
    platform: "play_integrity",
    publicKey: "A".repeat(88),
    counter: 1,
    signature: "B".repeat(86),
  };
  assert.equal(parseAttestationBody(null).ok, false);
  assert.equal(parseAttestationBody({ ...base, platform: "sms" }).ok, false);
  assert.equal(parseAttestationBody({ ...base, publicKey: "short" }).ok, false);
  assert.equal(parseAttestationBody({ ...base, counter: -1 }).ok, false);
  assert.equal(parseAttestationBody({ ...base, counter: 1.5 }).ok, false);
  assert.equal(parseAttestationBody({ ...base, signature: 42 }).ok, false);
});
