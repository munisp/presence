/** FR-84: the co-location close offer suggests once, and declining is free. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLOSE_OFFER_ACTIONS,
  CLOSE_OFFER_BASIS,
  COLOCATION_CLOSE_OFFER_MIN_MS,
  applyCloseOfferDecision,
  closeOfferDue,
  declineLeavesIntact,
  planCloseOffer,
  type ConversationSnapshot,
} from "../src/presence/closeOffer.js";

const OPEN: ConversationSnapshot = {
  conversationOpen: true,
  notificationsEnabled: true,
};

test("the fifteen-minute threshold and the stated basis are pinned (FR-84)", () => {
  assert.equal(COLOCATION_CLOSE_OFFER_MIN_MS, 15 * 60 * 1000);
  assert.equal(
    CLOSE_OFFER_BASIS,
    "You've been near each other for a while — if you've met, you can close this thread and stop its notifications.",
  );
  assert.ok(CLOSE_OFFER_BASIS.includes("met"), "the basis states that they have met");
  assert.deepEqual(CLOSE_OFFER_ACTIONS, ["close-thread", "dismiss"]);
});

test("due exactly at fifteen minutes co-located in an open conversation", () => {
  assert.ok(
    closeOfferDue({ conversationOpen: true, coLocatedMs: COLOCATION_CLOSE_OFFER_MIN_MS, offerState: "not-due" }),
  );
  assert.ok(
    closeOfferDue({ conversationOpen: true, coLocatedMs: COLOCATION_CLOSE_OFFER_MIN_MS * 2, offerState: "due" }),
  );
  assert.ok(
    !closeOfferDue({
      conversationOpen: true,
      coLocatedMs: COLOCATION_CLOSE_OFFER_MIN_MS - 1,
      offerState: "not-due",
    }),
    "one millisecond early is not due",
  );
});

test("no open conversation, no offer", () => {
  assert.ok(
    !closeOfferDue({ conversationOpen: false, coLocatedMs: COLOCATION_CLOSE_OFFER_MIN_MS * 4, offerState: "not-due" }),
  );
});

test("a broken clock fails closed to no offer", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.ok(!closeOfferDue({ conversationOpen: true, coLocatedMs: bad, offerState: "not-due" }));
  }
});

test("the plan carries the pinned basis, or nothing", () => {
  assert.deepEqual(
    planCloseOffer({ conversationOpen: true, coLocatedMs: COLOCATION_CLOSE_OFFER_MIN_MS, offerState: "not-due" }),
    { action: "offer", basis: CLOSE_OFFER_BASIS },
  );
  assert.deepEqual(
    planCloseOffer({ conversationOpen: true, coLocatedMs: 0, offerState: "not-due" }),
    { action: "none" },
  );
});

test("accepting closes the thread and stops notifications", () => {
  const decision = applyCloseOfferDecision("close-thread", OPEN);
  assert.deepEqual(decision.snapshot, { conversationOpen: false, notificationsEnabled: false });
  assert.equal(decision.offerState, "accepted");
});

test("declining MUST NOT affect the conversation (FR-84)", () => {
  const decision = applyCloseOfferDecision("dismiss", OPEN);
  assert.deepEqual(decision.snapshot, OPEN, "the conversation is byte-identical after declining");
  assert.equal(decision.offerState, "declined");
  assert.ok(declineLeavesIntact(OPEN, decision));

  const silenced: ConversationSnapshot = { conversationOpen: true, notificationsEnabled: false };
  const declined = applyCloseOfferDecision("dismiss", silenced);
  assert.deepEqual(
    declined.snapshot,
    silenced,
    "declining never toggles notifications either way",
  );
  assert.ok(declineLeavesIntact(silenced, declined));
});

test("the offer is asked at most once per conversation", () => {
  for (const state of ["shown", "declined", "accepted"] as const) {
    assert.ok(
      !closeOfferDue({ conversationOpen: true, coLocatedMs: COLOCATION_CLOSE_OFFER_MIN_MS * 3, offerState: state }),
      `no re-offer from state ${state}`,
    );
  }
});
