/** SRS Addendum 001 (b54): edge wallet validators — AMD-PAY-10..20. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CREDIT_APPROVAL_STATES,
  DAILY_WITHDRAWAL_CAP_MINOR,
  FOUR_EYES_CREDIT_THRESHOLD_MINOR,
  MAX_FUNDING_MINOR,
  MAX_WITHDRAWAL_MINOR,
  PLATFORM_WALLET_ID,
  RAIL_RISK_SIGNAL_KEYS,
  RAIL_SIGNAL_STATES,
  RAIL_SIGNATURE_SKEW_S,
  WALLET_CURRENCY,
  WALLET_ENTRY_KINDS,
  WALLET_HOLD_STATES,
  WALLET_STATUSES,
  WITHDRAWAL_STATES,
  fundingSignaturePayload,
  isWalletEntryKind,
  isWalletHoldState,
  isWalletStatus,
  isWithdrawalState,
  parseEmptyBody,
  parseFundingCallback,
  parsePayoutCallback,
  parseRailTimestamp,
  parseSignalDecision,
  parseWalletCreation,
  parseWithdrawalDecision,
  parseWithdrawalRequest,
  payoutSignaturePayload,
} from "../src/wallets.js";

test("AMD-PAY-10: statuses, currency and the platform wallet are pinned", () => {
  assert.deepEqual(WALLET_STATUSES, ["active", "frozen", "closed"]);
  assert.equal(WALLET_CURRENCY, "NGN");
  assert.equal(PLATFORM_WALLET_ID, "00000000-0000-0000-0000-00000000fee1");
  assert.ok(isWalletStatus("active") && isWalletStatus("frozen") && isWalletStatus("closed"));
  assert.equal(isWalletStatus("garbage"), false);
  assert.equal(isWalletStatus("ACTIVE"), false);
});

test("AMD-PAY-11: the six ledger kinds are pinned and closed", () => {
  assert.deepEqual(WALLET_ENTRY_KINDS, [
    "fund",
    "withdrawal",
    "transfer_out",
    "transfer_in",
    "fee_charge",
    "fee_revenue",
  ]);
  for (const kind of WALLET_ENTRY_KINDS) assert.ok(isWalletEntryKind(kind));
  assert.equal(isWalletEntryKind("note"), false);
  assert.equal(isWalletEntryKind(""), false);
});

test("AMD-PAY-12: the hold lifecycle is pending → posted | voided", () => {
  assert.deepEqual(WALLET_HOLD_STATES, ["pending", "posted", "voided"]);
  assert.ok(isWalletHoldState("pending"));
  assert.equal(isWalletHoldState("released"), false);
});

test("AMD-PAY-10: creation takes a strictly empty body", () => {
  assert.deepEqual(parseWalletCreation({}), {});
  assert.equal(parseWalletCreation(null), null);
  assert.equal(parseWalletCreation([]), null);
  assert.equal(parseWalletCreation("wallet"), null);
  assert.equal(parseWalletCreation({ currency: "NGN" }), null);
  assert.equal(parseWalletCreation({ amount: 1 }), null);
});

test("AMD-PAY-17: the withdrawal lifecycle is pinned and closed", () => {
  assert.deepEqual(WITHDRAWAL_STATES, ["requested", "processing", "paid", "failed", "cancelled"]);
  for (const state of WITHDRAWAL_STATES) assert.ok(isWithdrawalState(state));
  assert.equal(isWithdrawalState("approved"), false);
  assert.equal(isWithdrawalState(""), false);
});

test("AMD-PAY-16/17: the rail caps are pinned in minor units", () => {
  assert.equal(MAX_WITHDRAWAL_MINOR, 5_000_000);
  assert.equal(DAILY_WITHDRAWAL_CAP_MINOR, 15_000_000);
  assert.equal(MAX_FUNDING_MINOR, 15_000_000);
});

test("AMD-PAY-17: withdrawal requests are strictly {amountMinor, destinationRef}", () => {
  assert.deepEqual(
    parseWithdrawalRequest({ amountMinor: 1_000_000, destinationRef: "PSP_rcpt_01234567" }),
    { amountMinor: 1_000_000, destinationRef: "PSP_rcpt_01234567" },
  );
  // A smuggled extra field refuses — the destination is an opaque reference, never raw bank details.
  assert.equal(
    parseWithdrawalRequest({ amountMinor: 1, destinationRef: "PSP_rcpt_01234567", note: "rent" }),
    null,
  );
  assert.equal(parseWithdrawalRequest({ amountMinor: 1 }), null);
  assert.equal(parseWithdrawalRequest(null), null);
  assert.equal(parseWithdrawalRequest([]), null);
  // The amount must be a positive integer number of kobo.
  assert.equal(parseWithdrawalRequest({ amountMinor: 0, destinationRef: "PSP_rcpt_01234567" }), null);
  assert.equal(parseWithdrawalRequest({ amountMinor: -5, destinationRef: "PSP_rcpt_01234567" }), null);
  assert.equal(parseWithdrawalRequest({ amountMinor: 1.5, destinationRef: "PSP_rcpt_01234567" }), null);
  assert.equal(parseWithdrawalRequest({ amountMinor: "100", destinationRef: "PSP_rcpt_01234567" }), null);
  // The destination reference is 8–128 characters.
  assert.equal(parseWithdrawalRequest({ amountMinor: 1, destinationRef: "short" }), null);
  assert.equal(parseWithdrawalRequest({ amountMinor: 1, destinationRef: "x".repeat(129) }), null);
  assert.equal(parseWithdrawalRequest({ amountMinor: 1, destinationRef: 42 }), null);
});

test("AMD-PAY-16: funding callbacks are strictly {walletId, amountMinor, reference}", () => {
  const good = {
    walletId: "11111111-2222-4333-8444-555555555555",
    amountMinor: 2_500_000,
    reference: "PSP_fund_01234567",
  };
  assert.deepEqual(parseFundingCallback(good), good);
  assert.equal(parseFundingCallback({ ...good, note: "x" }), null);
  const { reference: _dropped, ...missing } = good;
  assert.equal(parseFundingCallback(missing), null);
  assert.equal(parseFundingCallback(null), null);
  assert.equal(parseFundingCallback([]), null);
  assert.equal(parseFundingCallback({ ...good, walletId: "not-a-uuid" }), null);
  assert.equal(parseFundingCallback({ ...good, amountMinor: 0 }), null);
  assert.equal(parseFundingCallback({ ...good, amountMinor: -1 }), null);
  assert.equal(parseFundingCallback({ ...good, amountMinor: 1.5 }), null);
  assert.equal(parseFundingCallback({ ...good, reference: "short" }), null);
  assert.equal(parseFundingCallback({ ...good, reference: "x".repeat(129) }), null);
});

test("AMD-PAY-17: payout callbacks are strictly {requestId, outcome, reference}", () => {
  const good = {
    requestId: "11111111-2222-4333-8444-555555555555",
    outcome: "completed",
    reference: "PSP_pay_01234567",
  };
  assert.deepEqual(parsePayoutCallback(good), good);
  assert.deepEqual(parsePayoutCallback({ ...good, outcome: "failed" }), { ...good, outcome: "failed" });
  assert.equal(parsePayoutCallback({ ...good, outcome: "paid" }), null);
  assert.equal(parsePayoutCallback({ ...good, note: "x" }), null);
  const { outcome: _dropped, ...missing } = good;
  assert.equal(parsePayoutCallback(missing), null);
  assert.equal(parsePayoutCallback(null), null);
  assert.equal(parsePayoutCallback({ ...good, requestId: "garbage" }), null);
  assert.equal(parsePayoutCallback({ ...good, reference: "short" }), null);
});

test("AMD-PAY-17: moderation decisions are strictly {decision}", () => {
  assert.deepEqual(parseWithdrawalDecision({ decision: "approve" }), { decision: "approve" });
  assert.deepEqual(parseWithdrawalDecision({ decision: "reject" }), { decision: "reject" });
  assert.equal(parseWithdrawalDecision({ decision: "maybe" }), null);
  assert.equal(parseWithdrawalDecision({ decision: "approve", reason: "x" }), null);
  assert.equal(parseWithdrawalDecision({}), null);
  assert.equal(parseWithdrawalDecision(null), null);
  assert.equal(parseWithdrawalDecision([]), null);
});

test("AMD-PAY-16/17: the signed strings are canonical and colon-joined", () => {
  // AMD-PAY-22: the timestamp leads the canonical string, so a replayed
  // signature dies with its timestamp inside the freshness window.
  assert.equal(
    fundingSignaturePayload(
      "1764100000",
      "11111111-2222-4333-8444-555555555555",
      2_500_000,
      "PSP_fund_01234567",
    ),
    "1764100000:11111111-2222-4333-8444-555555555555:2500000:PSP_fund_01234567",
  );
  assert.equal(
    payoutSignaturePayload(
      "1764100000",
      "11111111-2222-4333-8444-555555555555",
      "completed",
      "PSP_pay_01234567",
    ),
    "1764100000:11111111-2222-4333-8444-555555555555:completed:PSP_pay_01234567",
  );
});

test("AMD-PAY-22: the freshness window and timestamp parser are pinned", () => {
  assert.equal(RAIL_SIGNATURE_SKEW_S, 300);
  assert.equal(parseRailTimestamp("1764100000"), 1_764_100_000);
  assert.equal(parseRailTimestamp(""), null);
  assert.equal(parseRailTimestamp("now"), null);
  assert.equal(parseRailTimestamp("17.5"), null);
  assert.equal(parseRailTimestamp(undefined), null);
  assert.equal(parseRailTimestamp(1_764_100_000), null);
});

test("AMD-PAY-21: signal vocabularies and the ack decision parser are pinned", () => {
  assert.deepEqual(RAIL_RISK_SIGNAL_KEYS, [
    "fund_velocity_1h",
    "fund_daily_volume",
    "withdrawal_velocity_1h",
  ]);
  assert.deepEqual(RAIL_SIGNAL_STATES, ["open", "acknowledged", "dismissed"]);
  assert.deepEqual(parseSignalDecision({ decision: "acknowledge" }), { decision: "acknowledge" });
  assert.deepEqual(parseSignalDecision({ decision: "dismiss" }), { decision: "dismiss" });
  assert.equal(parseSignalDecision({ decision: "approve" }), null);
  assert.equal(parseSignalDecision({ decision: "acknowledge", note: "x" }), null);
  assert.equal(parseSignalDecision({}), null);
  assert.equal(parseSignalDecision(null), null);
  assert.equal(parseSignalDecision([]), null);
});

test("AMD-PAY-23: the four-eyes threshold and empty-body parser are pinned", () => {
  assert.equal(FOUR_EYES_CREDIT_THRESHOLD_MINOR, 5_000_000);
  assert.deepEqual(CREDIT_APPROVAL_STATES, ["pending", "approved", "rejected"]);
  assert.equal(parseEmptyBody({}), true);
  assert.equal(parseEmptyBody({ reason: "x" }), null);
  assert.equal(parseEmptyBody(null), null);
  assert.equal(parseEmptyBody([]), null);
  assert.equal(parseEmptyBody("x"), null);
});
