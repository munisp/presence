/** AMD-KYC-06..10: OpenKYC verification module pins — protocol constants,
 * the cross-language canonical challenge, the upload token, and the signed
 * verdict callback (freshness before signature, fail-closed parsing). */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACCEPT_MIN,
  ACTION_WINDOW_MS,
  CHALLENGE_ACTIONS,
  CHALLENGE_COUNT,
  CREDENTIAL_KINDS,
  KYC_SIGNATURE_SKEW_S,
  REVIEW_FLOOR,
  SESSION_TTL_MAX_SECONDS,
  SESSION_TTL_MIN_SECONDS,
  SESSION_TTL_SECONDS,
  VERDICT_OUTCOMES,
  buildChallenge,
  canonicalChallenge,
  challengeDigest,
  challengeToken,
  parseVerdictCallback,
  verdictSignaturePayload,
  verdictSignatureValid,
  verdictTimestampFresh,
} from "../src/kycVerification.js";

const SESSION = "11111111-2222-4333-8444-555555555555";

/** The cross-language fixture — identical to tests/test_openkyc.py. */
function challenge() {
  return (["blink", "nod", "smile"] as const).map((action) => ({
    action,
    windowMs: ACTION_WINDOW_MS,
  }));
}

const GOLDEN_DIGEST =
  "d4cad8456d535a0e07f264c362b8b0f136452b3bb0c1ace18277ff8a8abf8f0e";

function verdict() {
  return {
    sessionId: SESSION,
    challengeDigest: GOLDEN_DIGEST,
    outcome: "verified" as const,
    credentialKind: "id_card" as const,
    over18: true,
    credentialValid: true,
    authenticityScore: 0.9,
    livenessScore: 0.85,
    providerRef: "openkyc:rehearsal",
  };
}

test("AMD-KYC-07: the challenge protocol constants are pinned", () => {
  assert.deepEqual([...CHALLENGE_ACTIONS], [
    "blink",
    "turn_left",
    "turn_right",
    "smile",
    "nod",
  ]);
  assert.equal(CHALLENGE_COUNT, 3);
  assert.equal(ACTION_WINDOW_MS, 4000);
  assert.equal(SESSION_TTL_SECONDS, 600);
  assert.equal(SESSION_TTL_MIN_SECONDS, 60);
  assert.equal(SESSION_TTL_MAX_SECONDS, 900);
});

test("AMD-KYC-07: buildChallenge picks 3 distinct actions with the window", () => {
  const built = buildChallenge(() => 0);
  assert.deepEqual(built, [
    { action: "blink", windowMs: 4000 },
    { action: "turn_left", windowMs: 4000 },
    { action: "turn_right", windowMs: 4000 },
  ]);
  const seen = new Set(built.map((s) => s.action));
  assert.equal(seen.size, CHALLENGE_COUNT);
});

test("AMD-KYC-07: the canonical form is byte-identical to the pipeline", () => {
  assert.equal(
    canonicalChallenge(challenge()),
    '[{"action":"blink","windowMs":4000},' +
      '{"action":"nod","windowMs":4000},' +
      '{"action":"smile","windowMs":4000}]',
  );
  assert.equal(challengeDigest(challenge()), GOLDEN_DIGEST);
});

test("AMD-KYC-07: the upload token matches the pipeline HMAC", () => {
  // hmac-sha256("s3cret", "sess:<golden>:999") — the Python golden.
  assert.equal(
    challengeToken("s3cret", "sess", GOLDEN_DIGEST, 999),
    "12bfcd369532338471605c4205585ab34913447bab935adb0185c95a0fc36d62",
  );
});

test("AMD-KYC-09: the verdict parser is fail-closed", () => {
  assert.deepEqual(parseVerdictCallback(verdict()), verdict());
  assert.equal(parseVerdictCallback(null), null);
  assert.equal(parseVerdictCallback([]), null);
  assert.equal(parseVerdictCallback({ ...verdict(), sessionId: "nope" }), null);
  assert.equal(parseVerdictCallback({ ...verdict(), challengeDigest: "zz" }), null);
  assert.equal(parseVerdictCallback({ ...verdict(), outcome: "approved" }), null);
  assert.equal(parseVerdictCallback({ ...verdict(), credentialKind: "passport" }), null);
  assert.equal(parseVerdictCallback({ ...verdict(), over18: "yes" }), null);
  assert.equal(parseVerdictCallback({ ...verdict(), authenticityScore: 1.1 }), null);
  assert.equal(parseVerdictCallback({ ...verdict(), livenessScore: -0.1 }), null);
  assert.equal(parseVerdictCallback({ ...verdict(), providerRef: "short" }), null);
});

test("AMD-KYC-09: the signature payload pins field order and formatting", () => {
  assert.equal(
    verdictSignaturePayload("1700000000", verdict()),
    `1700000000|${SESSION}|${GOLDEN_DIGEST}|verified|0.9000|0.8500|openkyc:rehearsal`,
  );
});

test("AMD-KYC-09: signature verification is constant-time and strict", () => {
  const payload = verdictSignaturePayload("1700000000", verdict());
  // hmac-sha256("verdict-secret", payload) — the Python golden.
  const golden =
    "889de23ba2ca5a38c60f64c13c1ef863be66db4f1ab1464a108cf8267d158043";
  assert.equal(verdictSignatureValid("verdict-secret", payload, golden), true);
  assert.equal(verdictSignatureValid("wrong-secret", payload, golden), false);
  assert.equal(verdictSignatureValid("verdict-secret", `${payload}x`, golden), false);
  assert.equal(verdictSignatureValid("verdict-secret", payload, "not-hex"), false);
  assert.equal(verdictSignatureValid("verdict-secret", payload, undefined), false);
});

test("AMD-KYC-09: freshness is enforced BEFORE the signature", () => {
  const now = 1_700_000_000;
  assert.equal(verdictTimestampFresh(String(now), now), now);
  assert.equal(verdictTimestampFresh(String(now - KYC_SIGNATURE_SKEW_S), now), now - 300);
  assert.equal(verdictTimestampFresh(String(now - 301), now), null);
  assert.equal(verdictTimestampFresh(String(now + 301), now), null);
  assert.equal(verdictTimestampFresh("soon", now), null);
  assert.equal(verdictTimestampFresh(undefined, now), null);
});

test("AMD-KYC-08: thresholds and vocabulary are pinned", () => {
  assert.equal(ACCEPT_MIN, 0.8);
  assert.equal(REVIEW_FLOOR, 0.5);
  assert.deepEqual([...CREDENTIAL_KINDS], ["id_card", "driving_permit", "travel_document"]);
  assert.deepEqual([...VERDICT_OUTCOMES], ["verified", "rejected", "review"]);
});
