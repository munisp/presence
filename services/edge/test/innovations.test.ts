/** AMD-INN-01..10: innovation module pins — constants, parsers, attestations. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOND_AMOUNT_MINOR,
  DISCLOSURE_CLAIMS,
  DISCLOSURE_TTL_S,
  ESCROW_MAX_MILESTONES,
  ESCROW_MAX_TOTAL_MINOR,
  INTRO_TTL_H,
  MET_WINDOW_S,
  mintAttestationToken,
  parseDisclosureIssueBody,
  parseDisclosureVerifyBody,
  parseEscrowBody,
  parseEscrowResolution,
  parseIntroductionAnswerBody,
  parseIntroductionBody,
  parseMetReceiptBody,
  parseAttestationVerifyBody,
  parseSerendipityStateBody,
  parseSerendipityWindowBody,
  parseStakeRefundBody,
  ATTESTATION_TTL_S,
  SERENDIPITY_MAX_ACTIVE,
  STAKE_AMOUNT_MINOR,
  STAKE_TTL_H,
  verifyAttestationToken,
} from "../src/innovations.js";

const SECRET = "a".repeat(64);
const UID = "11111111-2222-4333-8444-555555555555";
const UID2 = "66666666-7777-4333-8444-888888888888";

test("AMD-INN: pinned constants match the migration contract", () => {
  assert.equal(BOND_AMOUNT_MINOR, 100_000);
  assert.equal(MET_WINDOW_S, 900);
  assert.equal(ESCROW_MAX_TOTAL_MINOR, 5_000_000);
  assert.equal(ESCROW_MAX_MILESTONES, 12);
  assert.equal(STAKE_AMOUNT_MINOR, 50_000);
  assert.equal(STAKE_TTL_H, 24);
  assert.equal(DISCLOSURE_TTL_S, 900);
  assert.deepEqual([...DISCLOSURE_CLAIMS], ["over_18", "kyc_verified"]);
  assert.equal(SERENDIPITY_MAX_ACTIVE, 4);
  assert.equal(INTRO_TTL_H, 72);
  assert.equal(ATTESTATION_TTL_S, 3600);
});

test("AMD-INN-09: attestation round-trips; the subject is a pseudonym", () => {
  const token = mintAttestationToken(UID, ["kyc_verified", "over_18"], SECRET, 1_000);
  const out = verifyAttestationToken(token, SECRET, 1_500);
  assert.ok(out !== null && out !== "expired");
  assert.deepEqual(out.claims, ["kyc_verified", "over_18"]);
  assert.match(out.sub, /^[0-9a-f]{64}$/);
  assert.ok(!out.sub.includes(UID));
  // Expired, tampered and malformed tokens get the three pinned verdicts.
  assert.equal(verifyAttestationToken(token, SECRET, 1_000 + 3_601), "expired");
  assert.equal(verifyAttestationToken(token, "b".repeat(64), 1_500), null);
  assert.equal(verifyAttestationToken("pp1.garbage.sig", SECRET, 1_500), null);
  assert.equal(verifyAttestationToken(token + "x", SECRET, 1_500), null);
});

test("AMD-INN parsers: strict shape, no extra keys", () => {
  assert.deepEqual(parseMetReceiptBody({ peer: UID }), { peer: UID });
  assert.equal(parseMetReceiptBody({ peer: UID, extra: 1 }), null);
  assert.equal(parseMetReceiptBody({ peer: "nope" }), null);

  assert.deepEqual(parseEscrowBody({ payee: UID, milestones: [100, 200] }), {
    payee: UID,
    milestones: [100, 200],
  });
  assert.equal(parseEscrowBody({ payee: UID, milestones: [] }), null);
  assert.equal(parseEscrowBody({ payee: UID, milestones: [0] }), null);
  assert.equal(parseEscrowBody({ payee: UID, milestones: [5_000_001] }), null);
  assert.equal(
    parseEscrowBody({ payee: UID, milestones: Array(13).fill(1) }),
    null,
  );

  assert.deepEqual(parseEscrowResolution({ decision: "refund" }), { decision: "refund" });
  assert.equal(parseEscrowResolution({ decision: "split" }), null);

  const secret = "c".repeat(48);
  assert.deepEqual(parseDisclosureVerifyBody({ grantId: UID, secret }), {
    grantId: UID,
    secret,
  });
  assert.equal(parseDisclosureVerifyBody({ grantId: UID, secret: "short" }), null);

  assert.deepEqual(parseDisclosureIssueBody({ claim: "over_18" }), { claim: "over_18" });
  assert.equal(parseDisclosureIssueBody({ claim: "age_exact" }), null);

  assert.deepEqual(
    parseSerendipityWindowBody({ weekday: 5, hourStart: 18, hourEnd: 23, market: "lagos" }),
    { weekday: 5, hourStart: 18, hourEnd: 23, market: "lagos" },
  );
  assert.equal(
    parseSerendipityWindowBody({ weekday: 7, hourStart: 18, hourEnd: 23, market: "lagos" }),
    null,
  );
  assert.equal(
    parseSerendipityWindowBody({ weekday: 5, hourStart: 23, hourEnd: 18, market: "lagos" }),
    null,
  );
  assert.deepEqual(parseSerendipityStateBody({ state: "paused" }), { state: "paused" });
  assert.equal(parseSerendipityStateBody({ state: "deleted" }), null);

  assert.deepEqual(parseIntroductionBody({ partyA: UID, partyB: UID2 }), {
    partyA: UID,
    partyB: UID2,
  });
  assert.deepEqual(parseIntroductionAnswerBody({ decision: "accept" }), {
    decision: "accept",
  });
  assert.equal(parseIntroductionAnswerBody({ decision: "maybe" }), null);

  assert.ok(parseStakeRefundBody({ stakeId: UID, checkinToken: "t".repeat(64) }));
  assert.equal(parseStakeRefundBody({ stakeId: UID }), null);

  assert.ok(parseAttestationVerifyBody({ token: "t".repeat(64) }));
  assert.equal(parseAttestationVerifyBody({ token: "short" }), null);
});
