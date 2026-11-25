/** AMD-MKT-01..05: marketplace module pins — constants and strict parsers. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LISTING_KINDS,
  LISTING_MAX_ACTIVE,
  LISTING_MAX_PRICE_MINOR,
  LISTING_STATES,
  MARKETPLACE_BROWSE_LIMIT,
  MARKETPLACE_CURRENCY,
  ORDER_STATES,
  parseListingBody,
  parseListingBrowseQuery,
  parseModerationRemoveBody,
  parseOrderResolution,
} from "../src/marketplace.js";

const VALID = {
  kind: "item",
  category: "electronics.phones",
  priceMinor: 250_000,
  market: "lagos",
};

test("AMD-MKT: pinned constants match the migration contract", () => {
  assert.deepEqual([...LISTING_KINDS], ["item", "service"]);
  assert.equal(LISTING_MAX_PRICE_MINOR, 5_000_000);
  assert.equal(LISTING_MAX_ACTIVE, 12);
  assert.equal(MARKETPLACE_CURRENCY, "NGN");
  assert.equal(MARKETPLACE_BROWSE_LIMIT, 50);
  assert.deepEqual([...LISTING_STATES], ["draft", "listed", "held", "sold", "removed"]);
  assert.deepEqual([...ORDER_STATES], ["active", "completed", "refunded", "disputed"]);
});

test("AMD-MKT-01: listing parser — strict shape, no extra keys", () => {
  assert.deepEqual(parseListingBody(VALID), VALID);
  assert.equal(parseListingBody({ ...VALID, description: "nice phone" }), null);
  assert.equal(parseListingBody({ ...VALID, photo: "data:..." }), null);
  assert.equal(parseListingBody({ kind: "item" }), null);
  assert.equal(parseListingBody(null), null);
  assert.equal(parseListingBody("x"), null);
});

test("AMD-MKT-01/04: kind, category shape, price ceiling and market bounds", () => {
  assert.equal(parseListingBody({ ...VALID, kind: "gig" }), null);
  assert.equal(parseListingBody({ ...VALID, category: "Not A Node" }), null);
  assert.equal(parseListingBody({ ...VALID, category: "a.b.c.d.e.f" }), null);
  assert.equal(parseListingBody({ ...VALID, priceMinor: 0 }), null);
  assert.equal(parseListingBody({ ...VALID, priceMinor: -5 }), null);
  assert.equal(parseListingBody({ ...VALID, priceMinor: 5_000_001 }), null);
  assert.equal(parseListingBody({ ...VALID, priceMinor: 1.5 }), null);
  assert.notEqual(parseListingBody({ ...VALID, priceMinor: 5_000_000 }), null);
  assert.equal(parseListingBody({ ...VALID, market: "" }), null);
  assert.equal(parseListingBody({ ...VALID, market: "x".repeat(65) }), null);
});

test("AMD-MKT-01: browse filters — any subset of category/kind/market", () => {
  assert.deepEqual(parseListingBrowseQuery({}), {});
  assert.deepEqual(parseListingBrowseQuery({ category: "electronics.phones" }), {
    category: "electronics.phones",
  });
  assert.deepEqual(parseListingBrowseQuery({ kind: "service", market: "lagos" }), {
    kind: "service",
    market: "lagos",
  });
  assert.equal(parseListingBrowseQuery({ kind: "gig" }), null);
  assert.equal(parseListingBrowseQuery({ category: "nope!" }), null);
  assert.equal(parseListingBrowseQuery({ q: "search" }), null);
  assert.equal(parseListingBrowseQuery(null), null);
});

test("AMD-MKT-05: moderation remove — a governed reason code and nothing else", () => {
  assert.deepEqual(parseModerationRemoveBody({ reasonCode: "prohibited-item" }), {
    reasonCode: "prohibited-item",
  });
  assert.equal(parseModerationRemoveBody({}), null);
  assert.equal(parseModerationRemoveBody({ reasonCode: "" }), null);
  assert.equal(parseModerationRemoveBody({ reasonCode: "x".repeat(65) }), null);
  assert.equal(parseModerationRemoveBody({ reasonCode: "ok", extra: 1 }), null);
});

test("AMD-MKT-03: order resolution — refund | release only", () => {
  assert.deepEqual(parseOrderResolution({ decision: "refund" }), { decision: "refund" });
  assert.deepEqual(parseOrderResolution({ decision: "release" }), { decision: "release" });
  assert.equal(parseOrderResolution({ decision: "split" }), null);
  assert.equal(parseOrderResolution({}), null);
  assert.equal(parseOrderResolution({ decision: "refund", extra: 1 }), null);
});
