/** SRS Addendum 001 (b49): the client P2P transfer contract — AMD-PAY. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DAILY_TRANSFER_CAP_MINOR,
  DISPUTE_REASONS,
  MAX_TRANSFER_MINOR,
  TRANSFER_ACCEPT_WINDOW_MS,
  TRANSFER_CARD_FIELDS,
  TRANSFER_CURRENCY,
  TRANSFER_FEE_BPS,
  TRANSFER_STATES,
  TRANSFER_TRANSITIONS,
  TransferPlan,
  buildTransferCard,
  computeFeeMinor,
  copyKeyForTransferState,
  formatTransferAmount,
  isLegalTransferTransition,
  planTransfer,
  transferHonoursAmendment,
} from "../src/presence/transferCard.js";

const BASE_PLAN: TransferPlan = {
  amountMinor: 1_250_000,
  dailySpentMinor: 0,
  hasOpenConversation: true,
  selfKycVerified: true,
  counterpartKycVerified: true,
};

test("the transfer states and legal-transition table are pinned", () => {
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
    assert.ok(isLegalTransferTransition(from, to), `${from} → ${to}`);
  }
  // The rail shortcut is exactly what must be impossible.
  assert.equal(isLegalTransferTransition("proposed", "settled"), false);
  assert.equal(isLegalTransferTransition("declined", "accepted"), false);
  assert.equal(isLegalTransferTransition("resolved", "disputed"), false);
  assert.equal(isLegalTransferTransition("disputed", "settled"), false);
  assert.equal(isLegalTransferTransition("garbage", "accepted"), false);
});

test("caps, fee and currency are pinned to the amendment values", () => {
  assert.equal(MAX_TRANSFER_MINOR, 5_000_000);
  assert.equal(DAILY_TRANSFER_CAP_MINOR, 15_000_000);
  assert.equal(TRANSFER_FEE_BPS, 100);
  assert.equal(TRANSFER_CURRENCY, "NGN");
  assert.equal(TRANSFER_ACCEPT_WINDOW_MS, 3_600_000);
  assert.equal(computeFeeMinor(5_000_000), 50_000);
  assert.equal(computeFeeMinor(199), 1);
  assert.equal(computeFeeMinor(0), null);
  assert.deepEqual(DISPUTE_REASONS, ["not-received", "wrong-amount", "unauthorised"]);
});

test("a transfer card is amount, fee, currency and state — never a note", () => {
  assert.deepEqual(TRANSFER_CARD_FIELDS, ["amountMinor", "feeMinor", "currency", "state"]);
  const card = buildTransferCard({
    amountMinor: 1_250_000,
    feeMinor: 12_500,
    currency: "NGN",
    state: "accepted",
  });
  assert.ok(card !== null);
  assert.deepEqual(Object.keys(card).sort(), ["amountMinor", "currency", "feeMinor", "state"]);
  // A smuggled free-text field refuses the whole card — solicitation is
  // unrepresentable (AMD-PAY-03; FR-96/SEC-37 unchanged).
  assert.equal(
    buildTransferCard({
      amountMinor: 1_250_000,
      feeMinor: 12_500,
      currency: "NGN",
      state: "accepted",
      note: "send more",
    }),
    null,
  );
  assert.equal(
    buildTransferCard({ amountMinor: 1_250_000, feeMinor: 12_500, currency: "NGN" }),
    null,
  );
  // A fee that disagrees with the amendment formula is tampering.
  assert.equal(
    buildTransferCard({ amountMinor: 1_250_000, feeMinor: 1, currency: "NGN", state: "accepted" }),
    null,
  );
  // Over-cap amounts, foreign currencies, unknown states: fail closed.
  assert.equal(
    buildTransferCard({
      amountMinor: 5_000_001,
      feeMinor: 50_000,
      currency: "NGN",
      state: "accepted",
    }),
    null,
  );
  assert.equal(
    buildTransferCard({ amountMinor: 100, feeMinor: 1, currency: "USD", state: "accepted" }),
    null,
  );
  assert.equal(
    buildTransferCard({ amountMinor: 100, feeMinor: 1, currency: "NGN", state: "pending" }),
    null,
  );
  assert.equal(buildTransferCard("card"), null);
});

test("planTransfer refuses with exactly one reason", () => {
  assert.deepEqual(planTransfer(BASE_PLAN), { allowed: true });
  // Over the per-transfer cap.
  assert.deepEqual(planTransfer({ ...BASE_PLAN, amountMinor: 5_000_001 }), {
    allowed: false,
    reason: "over-transfer-cap",
  });
  // Verification beats the conversation check — pinned refusal order.
  assert.deepEqual(
    planTransfer({ ...BASE_PLAN, counterpartKycVerified: false, hasOpenConversation: false }),
    { allowed: false, reason: "not-kyc-verified" },
  );
  assert.deepEqual(planTransfer({ ...BASE_PLAN, selfKycVerified: false }), {
    allowed: false,
    reason: "not-kyc-verified",
  });
  assert.deepEqual(planTransfer({ ...BASE_PLAN, hasOpenConversation: false }), {
    allowed: false,
    reason: "no-open-conversation",
  });
  // Daily cap: exactly at the boundary it fits; one kobo over refuses.
  assert.deepEqual(
    planTransfer({ ...BASE_PLAN, amountMinor: 5_000_000, dailySpentMinor: 10_000_000 }),
    { allowed: true },
  );
  assert.deepEqual(
    planTransfer({ ...BASE_PLAN, amountMinor: 5_000_000, dailySpentMinor: 10_000_001 }),
    { allowed: false, reason: "over-daily-cap" },
  );
  // Garbage is invalid before any other reason.
  assert.deepEqual(planTransfer({ ...BASE_PLAN, amountMinor: 0 }), {
    allowed: false,
    reason: "invalid-input",
  });
  assert.deepEqual(planTransfer({ ...BASE_PLAN, amountMinor: 1.5 }), {
    allowed: false,
    reason: "invalid-input",
  });
});

test("amounts format as naira deterministically", () => {
  assert.equal(formatTransferAmount(1_250_000, "NGN"), "₦12,500.00");
  assert.equal(formatTransferAmount(5_000_000, "NGN"), "₦50,000.00");
  assert.equal(formatTransferAmount(99, "NGN"), "₦0.99");
  assert.equal(formatTransferAmount(0, "NGN"), "₦0.00");
  assert.equal(formatTransferAmount(1_234_567_899, "NGN"), "₦12,345,678.99");
  // Unknown currencies and garbage fail closed.
  assert.equal(formatTransferAmount(100, "USD"), null);
  assert.equal(formatTransferAmount(1.5, "NGN"), null);
  assert.equal(formatTransferAmount(-100, "NGN"), null);
  // States resolve to copy keys; garbage does not.
  assert.equal(copyKeyForTransferState("disputed"), "ui.transfer.state.disputed");
  assert.equal(copyKeyForTransferState("pending"), null);
});

test("the master guard holds and is not vacuous", () => {
  assert.equal(transferHonoursAmendment(), true);
});
