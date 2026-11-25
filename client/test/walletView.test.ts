/** SRS Addendum 001 (b53): client wallet contract — AMD-PAY-10..14. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLATFORM_WALLET_ID,
  WALLET_CURRENCY,
  WALLET_ENTRY_KINDS,
  WALLET_HOLD_STATES,
  WALLET_STATUSES,
  WALLET_SUMMARY_FIELDS,
  buildWalletSummary,
  copyKeyForEntryKind,
  copyKeyForHoldState,
  copyKeyForWalletStatus,
  formatWalletAmount,
  isWalletEntryKind,
  isWalletHoldState,
  isWalletStatus,
  planWalletCreation,
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
