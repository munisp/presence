/** Offer-lifecycle tests: FR-32 masking, FR-33 window, FR-34 keys, FR-37. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONVERSATION_TTL_MS,
  LIFECYCLE_TICK_MS,
  OFFER_TTL_MS,
  PURGE_AFTER_CLOSE_MS,
  blockKey,
  isOfferLive,
  maskCloseReason,
} from "../src/lifecycle.js";

test("FR-33/37: lifecycle windows match the spec", () => {
  assert.equal(OFFER_TTL_MS, 30 * 60 * 1000); // offer: 30 minutes
  assert.equal(CONVERSATION_TTL_MS, 24 * 60 * 60 * 1000); // conversation: 24 h
  assert.equal(PURGE_AFTER_CLOSE_MS, 24 * 60 * 60 * 1000); // ciphertext purge: 24 h
  assert.ok(LIFECYCLE_TICK_MS <= OFFER_TTL_MS / 30, "tick must be far tighter than the window");
});

test("FR-34: block keys are canonically ordered", () => {
  assert.equal(blockKey("b", "a"), blockKey("a", "b"));
  assert.equal(blockKey("a", "b"), "block:a:b");
  assert.notEqual(blockKey("a", "b"), blockKey("a", "c"));
});

test("FR-32: decline is masked as expiry; blocks vanish entirely", () => {
  assert.equal(maskCloseReason("declined"), "expired");
  assert.equal(maskCloseReason("blocked"), null);
  assert.equal(maskCloseReason("expired"), "expired");
  assert.equal(maskCloseReason("lapsed"), "lapsed");
});

test("FR-33: an offer is live only pre-OPEN, unclosed and inside its window", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(isOfferLive("DETECTED", null, future), true);
  assert.equal(isOfferLive("MUTUAL", null, null), true); // window not yet armed
  assert.equal(isOfferLive("DETECTED", null, past), false); // window ran out
  assert.equal(isOfferLive("DETECTED", new Date().toISOString(), future), false); // closed
  assert.equal(isOfferLive("OPEN", null, null), false); // conversations are not offers
});
