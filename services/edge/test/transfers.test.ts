/** SRS Addendum 001 (b49): edge P2P transfer validators — AMD-PAY-03..08. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DAILY_TRANSFER_CAP_MINOR,
  DISPUTE_REASONS,
  MAX_TRANSFER_MINOR,
  TRANSFER_ACCEPT_WINDOW_MS,
  TRANSFER_CURRENCY,
  TRANSFER_FEE_BPS,
  TRANSFER_STATES,
  TRANSFER_TRANSITIONS,
  computeFeeMinor,
  isLegalTransferTransition,
  isTransferState,
  parseDisputeOutcome,
  parseTransferDispute,
  parseTransferProposal,
} from "../src/transfers.js";

test("AMD-PAY-04: the eight states and the eight legal transitions are pinned", () => {
  assert.deepEqual(TRANSFER_STATES, [
    "proposed",
    "accepted",
    "declined",
    "cancelled",
    "expired",
    "settled",
    "disputed",
    "resolved",
  ]);
  assert.equal(TRANSFER_TRANSITIONS.length, 8);
  for (const [from, to] of TRANSFER_TRANSITIONS) {
    assert.ok(isTransferState(from) && isTransferState(to));
    assert.ok(isLegalTransferTransition(from, to), `${from} → ${to}`);
  }
  // The illegal moves the table must refuse.
  assert.equal(isLegalTransferTransition("proposed", "settled"), false);
  assert.equal(isLegalTransferTransition("proposed", "disputed"), false);
  assert.equal(isLegalTransferTransition("declined", "accepted"), false);
  assert.equal(isLegalTransferTransition("cancelled", "accepted"), false);
  assert.equal(isLegalTransferTransition("expired", "accepted"), false);
  assert.equal(isLegalTransferTransition("resolved", "disputed"), false);
  assert.equal(isLegalTransferTransition("disputed", "settled"), false);
  assert.equal(isLegalTransferTransition("settled", "resolved"), false);
  assert.equal(isLegalTransferTransition("garbage", "accepted"), false);
  assert.equal(isLegalTransferTransition("proposed", "acceptedd"), false);
});

test("AMD-PAY-05: caps, fee and currency are pinned to the amendment values", () => {
  assert.equal(MAX_TRANSFER_MINOR, 5_000_000);
  assert.equal(DAILY_TRANSFER_CAP_MINOR, 15_000_000);
  assert.equal(TRANSFER_FEE_BPS, 100);
  assert.equal(TRANSFER_CURRENCY, "NGN");
  assert.equal(TRANSFER_ACCEPT_WINDOW_MS, 3_600_000);
});

test("AMD-PAY-05: the fee is floor(amount × 100 bps / 10 000), agreeing with the definer", () => {
  assert.equal(computeFeeMinor(5_000_000), 50_000);
  assert.equal(computeFeeMinor(10_000), 100);
  assert.equal(computeFeeMinor(1), 0);
  assert.equal(computeFeeMinor(199), 1);
  // Garbage fails closed — no fee for a non-amount.
  assert.equal(computeFeeMinor(0), null);
  assert.equal(computeFeeMinor(-500), null);
  assert.equal(computeFeeMinor(1.5), null);
  assert.equal(computeFeeMinor(Number.NaN), null);
});

test("AMD-PAY-03: the dispute vocabulary is the closed three-category set", () => {
  assert.deepEqual(DISPUTE_REASONS, ["not-received", "wrong-amount", "unauthorised"]);
});

test("TR-23: proposal bodies are strict — {recipient, amountMinor} only", () => {
  const recipient = "3f6b9c6a-1b2c-4d5e-8f9a-0b1c2d3e4f5a";
  assert.deepEqual(parseTransferProposal({ recipient, amountMinor: 25_000 }), {
    recipient,
    amountMinor: 25_000,
  });
  // Unknown fields refuse, even alongside valid ones — a smuggled memo
  // field is exactly what AMD-PAY-03 forbids.
  assert.equal(parseTransferProposal({ recipient, amountMinor: 25_000, note: "pay me" }), null);
  assert.equal(parseTransferProposal({ recipient }), null);
  assert.equal(parseTransferProposal({ amountMinor: 25_000 }), null);
  assert.equal(parseTransferProposal({ recipient: "not-a-uuid", amountMinor: 25_000 }), null);
  assert.equal(parseTransferProposal({ recipient, amountMinor: 0 }), null);
  assert.equal(parseTransferProposal({ recipient, amountMinor: -1 }), null);
  assert.equal(parseTransferProposal({ recipient, amountMinor: 1.5 }), null);
  assert.equal(parseTransferProposal("recipient"), null);
  assert.equal(parseTransferProposal(null), null);
});

test("AMD-PAY-03/04: dispute and resolution bodies are strict closed vocabularies", () => {
  assert.deepEqual(parseTransferDispute({ reason: "not-received" }), { reason: "not-received" });
  assert.equal(parseTransferDispute({ reason: "they were rude" }), null);
  assert.equal(parseTransferDispute({ reason: "not-received", detail: "…" }), null);
  assert.equal(parseTransferDispute({}), null);
  assert.deepEqual(parseDisputeOutcome({ outcome: "upheld" }), { outcome: "upheld" });
  assert.deepEqual(parseDisputeOutcome({ outcome: "rejected" }), { outcome: "rejected" });
  assert.equal(parseDisputeOutcome({ outcome: "refunded" }), null);
  assert.equal(parseDisputeOutcome({}), null);
});
