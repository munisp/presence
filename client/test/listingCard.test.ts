/** AMD-MKT-01..05: listing card — formatting, badges, action rules, cross-pins. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  canConfirmPurchase,
  canDisputePurchase,
  canPurchase,
  formatListingPrice,
  LISTING_KINDS,
  LISTING_MAX_PRICE_MINOR,
  listingIsLive,
  listingStateBadge,
  LISTING_STATES,
  MARKETPLACE_CURRENCY,
  ORDER_STATES,
} from "../src/presence/listingCard.js";

test("AMD-MKT-01/04: the constants mirror the edge module", () => {
  // Cross-pinned: the edge mirrors the migration contract.
  const edge = readFileSync("../services/edge/src/marketplace.ts", "utf8");
  assert.match(edge, /LISTING_KINDS = \["item", "service"\]/);
  assert.match(edge, /LISTING_MAX_PRICE_MINOR = 5_000_000/);
  assert.match(edge, /LISTING_MAX_ACTIVE = 12/);
  assert.match(edge, /MARKETPLACE_CURRENCY = "NGN"/);
  assert.deepEqual([...LISTING_KINDS], ["item", "service"]);
  assert.equal(LISTING_MAX_PRICE_MINOR, 5_000_000);
  assert.equal(MARKETPLACE_CURRENCY, "NGN");
  assert.deepEqual([...LISTING_STATES], ["draft", "listed", "held", "sold", "removed"]);
  assert.deepEqual([...ORDER_STATES], ["active", "completed", "refunded", "disputed"]);
});

test("AMD-MKT-04: price formatting is deterministic NGN", () => {
  assert.equal(formatListingPrice(5_000_000), "₦50,000.00");
  assert.equal(formatListingPrice(100_000), "₦1,000.00");
  assert.equal(formatListingPrice(99), "₦0.99");
  assert.equal(formatListingPrice(1_234_567_890), "₦12,345,678.90");
});

test("AMD-MKT-01: every state has a badge; live states match the seller cap", () => {
  for (const state of LISTING_STATES) {
    assert.ok(listingStateBadge(state).length > 0, state);
  }
  assert.deepEqual(LISTING_STATES.filter(listingIsLive), ["draft", "listed", "held"]);
});

test("AMD-MKT-03: the action rules mirror the state machines", () => {
  // Buy: listed only, never own.
  assert.equal(canPurchase("listed", false), true);
  assert.equal(canPurchase("listed", true), false);
  assert.equal(canPurchase("held", false), false);
  assert.equal(canPurchase("draft", false), false);
  // Confirm: active order, buyer only.
  assert.equal(canConfirmPurchase("active", true), true);
  assert.equal(canConfirmPurchase("active", false), false);
  assert.equal(canConfirmPurchase("disputed", true), false);
  // Dispute: active order, either party.
  assert.equal(canDisputePurchase("active", true), true);
  assert.equal(canDisputePurchase("active", false), false);
  assert.equal(canDisputePurchase("completed", true), false);
});
