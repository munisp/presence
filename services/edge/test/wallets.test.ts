/** SRS Addendum 001 (b53): edge wallet validators — AMD-PAY-10..14. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLATFORM_WALLET_ID,
  WALLET_CURRENCY,
  WALLET_ENTRY_KINDS,
  WALLET_HOLD_STATES,
  WALLET_STATUSES,
  isWalletEntryKind,
  isWalletHoldState,
  isWalletStatus,
  parseWalletCreation,
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
