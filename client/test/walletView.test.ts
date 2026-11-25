/** SRS Addendum 001 (b54): client wallet contract — AMD-PAY-10..20. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DAILY_WITHDRAWAL_CAP_MINOR,
  MAX_WITHDRAWAL_MINOR,
  PLATFORM_WALLET_ID,
  WALLET_CURRENCY,
  WALLET_ENTRY_KINDS,
  WALLET_HOLD_STATES,
  WALLET_STATUSES,
  WALLET_SUMMARY_FIELDS,
  WITHDRAWAL_STATES,
  buildWalletSummary,
  copyKeyForEntryKind,
  copyKeyForHoldState,
  copyKeyForWalletStatus,
  copyKeyForWithdrawalState,
  formatWalletAmount,
  isWalletEntryKind,
  isWalletHoldState,
  isWalletStatus,
  isWithdrawalState,
  planWalletCreation,
  planWithdrawal,
  walletHonoursAmendment,
} from "../src/presence/walletView.js";

const VALID = {
  walletId: "11111111-2222-4333-8444-555555555555",
  currency: "NGN",
  status: "active",
  balanceMinor: 1_250_000,
  heldMinor: 250_000,
  availableMinor: 1_000_000,
};

test("the wallet vocabularies are pinned to the amendment values", () => {
  assert.deepEqual(WALLET_STATUSES, ["active", "frozen", "closed"]);
  assert.deepEqual(WALLET_ENTRY_KINDS, [
    "fund",
    "withdrawal",
    "transfer_out",
    "transfer_in",
    "fee_charge",
    "fee_revenue",
  ]);
  assert.deepEqual(WALLET_HOLD_STATES, ["pending", "posted", "voided"]);
  assert.equal(WALLET_CURRENCY, "NGN");
  assert.equal(PLATFORM_WALLET_ID, "00000000-0000-0000-0000-00000000fee1");
  assert.ok(isWalletStatus("frozen") && isWalletEntryKind("fee_charge") && isWalletHoldState("voided"));
  assert.equal(isWalletStatus("ACTIVE"), false);
  assert.equal(isWalletEntryKind("note"), false);
  assert.equal(isWalletHoldState("released"), false);
});

test("a wallet summary is id, currency, status and three amounts — never a note", () => {
  const summary = buildWalletSummary(VALID);
  assert.ok(summary !== null);
  assert.equal(summary.availableMinor, 1_000_000);
  assert.equal(WALLET_SUMMARY_FIELDS.length, 6);
  // A smuggled extra field refuses the summary — no free text by construction.
  assert.equal(buildWalletSummary({ ...VALID, note: "rent" }), null);
  assert.equal(buildWalletSummary({ ...VALID, memo: "" }), null);
  // Missing field, garbage shapes, unknown currency and status refuse.
  const { heldMinor: _drop, ...missing } = VALID;
  assert.equal(buildWalletSummary(missing), null);
  assert.equal(buildWalletSummary(null), null);
  assert.equal(buildWalletSummary([]), null);
  assert.equal(buildWalletSummary({ ...VALID, currency: "USD" }), null);
  assert.equal(buildWalletSummary({ ...VALID, status: "garbage" }), null);
  assert.equal(buildWalletSummary({ ...VALID, walletId: "not-a-uuid" }), null);
  // The arithmetic must agree: available = balance − held.
  assert.equal(buildWalletSummary({ ...VALID, availableMinor: 999_999 }), null);
  assert.equal(buildWalletSummary({ ...VALID, heldMinor: 2_000_000 }), null);
  assert.equal(buildWalletSummary({ ...VALID, balanceMinor: -1, availableMinor: -1_250_000, heldMinor: 250_000 }), null);
});

test("planWalletCreation refuses with exactly one reason", () => {
  assert.deepEqual(planWalletCreation({ selfKycVerified: true, existingCurrencies: [] }), {
    allowed: true,
  });
  assert.deepEqual(planWalletCreation({ selfKycVerified: false, existingCurrencies: [] }), {
    allowed: false,
    reason: "not-kyc-verified",
  });
  assert.deepEqual(planWalletCreation({ selfKycVerified: true, existingCurrencies: ["NGN"] }), {
    allowed: false,
    reason: "wallet-exists",
  });
  assert.deepEqual(planWalletCreation({ selfKycVerified: false, existingCurrencies: ["NGN"] }), {
    allowed: false,
    reason: "not-kyc-verified",
  });
  assert.deepEqual(planWalletCreation(null as never), { allowed: false, reason: "invalid-input" });
  assert.deepEqual(
    planWalletCreation({ selfKycVerified: "yes", existingCurrencies: [] } as never),
    { allowed: false, reason: "invalid-input" },
  );
});

test("wallet amounts format as naira deterministically, matching the transfer card", () => {
  assert.equal(formatWalletAmount(1_250_000), "₦12,500.00");
  assert.equal(formatWalletAmount(0), "₦0.00");
  assert.equal(formatWalletAmount(99), "₦0.99");
  assert.equal(formatWalletAmount(-1), null);
  assert.equal(formatWalletAmount(1.5), null);
  assert.equal(formatWalletAmount("1250000"), null);
});

test("copy keys exist for every status, entry kind and hold state", () => {
  for (const status of WALLET_STATUSES) {
    assert.equal(copyKeyForWalletStatus(status), `ui.wallet.status.${status}`);
  }
  for (const kind of WALLET_ENTRY_KINDS) {
    assert.equal(copyKeyForEntryKind(kind), `ui.wallet.entry.${kind}`);
  }
  for (const state of WALLET_HOLD_STATES) {
    assert.equal(copyKeyForHoldState(state), `ui.wallet.hold.${state}`);
  }
  assert.equal(copyKeyForWalletStatus("garbage"), null);
  assert.equal(copyKeyForEntryKind("note"), null);
  assert.equal(copyKeyForHoldState("garbage"), null);
});

test("the master guard holds and is not vacuous", () => {
  assert.equal(walletHonoursAmendment(), true);
});

test("the withdrawal lifecycle and caps are pinned to the amendment values", () => {
  assert.deepEqual(WITHDRAWAL_STATES, ["requested", "processing", "paid", "failed", "cancelled"]);
  assert.equal(MAX_WITHDRAWAL_MINOR, 5_000_000);
  assert.equal(DAILY_WITHDRAWAL_CAP_MINOR, 15_000_000);
  assert.ok(isWithdrawalState("processing"));
  assert.equal(isWithdrawalState("approved"), false);
});

test("planWithdrawal refuses with exactly one reason, in the pinned order", () => {
  const base = {
    amountMinor: 1_000_000,
    availableMinor: 2_000_000,
    dailyUsedMinor: 0,
    destinationRef: "PSP_rcpt_01234567",
  };
  assert.deepEqual(planWithdrawal(base), { allowed: true });
  // Garbage input refuses first.
  assert.deepEqual(planWithdrawal(null as never), { allowed: false, reason: "invalid-input" });
  assert.deepEqual(planWithdrawal({ ...base, amountMinor: 0 }), {
    allowed: false,
    reason: "invalid-input",
  });
  assert.deepEqual(planWithdrawal({ ...base, amountMinor: 1.5 }), {
    allowed: false,
    reason: "invalid-input",
  });
  assert.deepEqual(planWithdrawal({ ...base, availableMinor: -1 }), {
    allowed: false,
    reason: "invalid-input",
  });
  assert.deepEqual(planWithdrawal({ ...base, dailyUsedMinor: -1 }), {
    allowed: false,
    reason: "invalid-input",
  });
  assert.deepEqual(planWithdrawal({ ...base, destinationRef: 42 } as never), {
    allowed: false,
    reason: "invalid-input",
  });
  // The destination shape refuses second.
  assert.deepEqual(planWithdrawal({ ...base, destinationRef: "short" }), {
    allowed: false,
    reason: "invalid-destination",
  });
  assert.deepEqual(planWithdrawal({ ...base, destinationRef: "x".repeat(129) }), {
    allowed: false,
    reason: "invalid-destination",
  });
  // The per-withdrawal cap refuses third.
  assert.deepEqual(planWithdrawal({ ...base, amountMinor: 5_000_001, availableMinor: 20_000_000 }), {
    allowed: false,
    reason: "over-withdrawal-cap",
  });
  // The available balance refuses fourth.
  assert.deepEqual(planWithdrawal({ ...base, amountMinor: 3_000_000 }), {
    allowed: false,
    reason: "exceeds-available",
  });
  // The rolling daily cap refuses last.
  assert.deepEqual(planWithdrawal({ ...base, dailyUsedMinor: 14_500_000 }), {
    allowed: false,
    reason: "over-daily-cap",
  });
  // Exactly at every cap is allowed.
  assert.deepEqual(
    planWithdrawal({
      amountMinor: 5_000_000,
      availableMinor: 5_000_000,
      dailyUsedMinor: 10_000_000,
      destinationRef: "PSP_rcpt_01234567",
    }),
    { allowed: true },
  );
});

test("copy keys exist for every withdrawal state", () => {
  for (const state of WITHDRAWAL_STATES) {
    assert.equal(copyKeyForWithdrawalState(state), `ui.wallet.withdrawal.${state}`);
  }
  assert.equal(copyKeyForWithdrawalState("garbage"), null);
});
