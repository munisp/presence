/** FR-03/FR-08/FR-41/FR-48: the journey contracts. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACCOUNT_DELETE_ENDPOINT,
  ACCOUNT_DELETE_JOURNEY,
  ACCOUNT_DELETE_MAX_TAPS,
  INTERESTS_PUBLISH_BLOCK_SENTENCE,
  INTEREST_MAX_DECLARED,
  INTEREST_MIN_DECLARED,
  LOCAL_DELETE_NOTE,
  MESSAGE_REVOKE_WINDOW_MS,
  PRESENCE_SOURCE_CONFIDENCE,
  REVOKE_WINDOW_CLOSED_ERROR,
  TAXONOMY_FIRST_INTERACTION_MAX_DEPTH,
  VENUE_CHECKIN_ENDPOINT,
  checkinHonoursFr48,
  deleteConversationLocally,
  firstInteractionWithinDepth,
  interestDeclarationValid,
  journeyNeedsNoSupport,
  journeyWithinTapBudget,
  pickerResolvesBlock,
  planAccountDelete,
  planVenueCheckin,
  preferredPresenceSource,
  presenceReadiness,
  revokeAvailable,
} from "../src/presence/journeyContracts.js";

test("FR-03: three taps, inside the app, no support contact", () => {
  assert.equal(ACCOUNT_DELETE_MAX_TAPS, 3);
  assert.equal(ACCOUNT_DELETE_JOURNEY.length, 3);
  assert.equal(ACCOUNT_DELETE_ENDPOINT, "DELETE /v1/account");
  const plan = planAccountDelete();
  assert.ok(plan.withinBudget);
  assert.ok(plan.needsNoSupport);
  assert.ok(journeyWithinTapBudget(ACCOUNT_DELETE_JOURNEY));
  assert.ok(journeyNeedsNoSupport(ACCOUNT_DELETE_JOURNEY));
  assert.ok(
    !journeyNeedsNoSupport(["open-settings", "contact-support"]),
    "a support step fails the proof",
  );
});

test("FR-08: the 3..20 mirror and the three-level first interaction", () => {
  assert.equal(INTEREST_MIN_DECLARED, 3);
  assert.equal(INTEREST_MAX_DECLARED, 20);
  assert.equal(TAXONOMY_FIRST_INTERACTION_MAX_DEPTH, 3);
  assert.ok(!interestDeclarationValid(2));
  assert.ok(interestDeclarationValid(3));
  assert.ok(interestDeclarationValid(20));
  assert.ok(!interestDeclarationValid(21));
  assert.ok(!interestDeclarationValid(3.5), "non-integers are invalid");
  assert.ok(firstInteractionWithinDepth(1));
  assert.ok(firstInteractionWithinDepth(3));
  assert.ok(!firstInteractionWithinDepth(4));
  assert.ok(!firstInteractionWithinDepth(0));
});

test("FR-08/FR-11: two interests block the publish and offer the picker", () => {
  const readiness = presenceReadiness(2);
  assert.equal(readiness.publish, false);
  if (!readiness.publish) {
    assert.equal(readiness.reason, "too-few-interests");
    assert.equal(readiness.offer, "constellation-picker");
    assert.equal(readiness.missing, 1);
    assert.equal(readiness.sentence, INTERESTS_PUBLISH_BLOCK_SENTENCE);
    assert.match(readiness.sentence, /three/, "the sentence names the minimum");
  }
  assert.ok(pickerResolvesBlock(readiness), "the picker resolves the block");
  assert.deepEqual(presenceReadiness(3), { publish: true });
  assert.deepEqual(presenceReadiness(20), { publish: true });
});

test("FR-08: garbage counts fail closed to blocked", () => {
  for (const bad of [Number.NaN, -1, 2.5]) {
    const readiness = presenceReadiness(bad);
    assert.equal(readiness.publish, false);
  }
});

test("FR-41: the 24-hour window mirrors the server, own messages only", () => {
  assert.equal(MESSAGE_REVOKE_WINDOW_MS, 24 * 60 * 60 * 1000);
  assert.equal(
    REVOKE_WINDOW_CLOSED_ERROR,
    "the 24-hour revocation window has closed (FR-41)",
  );
  const now = 1_700_000_000_000;
  assert.ok(revokeAvailable({ own: true, sentAtMs: now - 1000 }, now));
  assert.ok(
    !revokeAvailable({ own: true, sentAtMs: now - MESSAGE_REVOKE_WINDOW_MS }, now),
    "exactly at the boundary the window has closed",
  );
  assert.ok(
    !revokeAvailable({ own: false, sentAtMs: now - 1000 }, now),
    "someone else's message is never revocable",
  );
});

test("FR-41: garbage and future timestamps fail closed", () => {
  const now = 1_700_000_000_000;
  assert.ok(!revokeAvailable({ own: true, sentAtMs: Number.NaN }, now));
  assert.ok(!revokeAvailable({ own: true, sentAtMs: now }, Number.NaN));
  assert.ok(
    !revokeAvailable({ own: true, sentAtMs: now + 60_000 }, now),
    "a future timestamp is not revocable",
  );
});

test("FR-41: local delete removes only the local copy, and says so", () => {
  assert.equal(
    LOCAL_DELETE_NOTE,
    "Deleting removes this conversation from this device only.",
  );
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(deleteConversationLocally(list, "b"), [{ id: "a" }, { id: "c" }]);
  assert.deepEqual(
    deleteConversationLocally(list, "zzz"),
    list,
    "an unknown id changes nothing",
  );
  assert.equal(list.length, 3, "the input is not mutated");
});

test("FR-48: check-in outranks cell matching, and is the refusal alternative", () => {
  assert.equal(VENUE_CHECKIN_ENDPOINT, "POST /v1/presence/checkin");
  assert.ok(
    PRESENCE_SOURCE_CONFIDENCE["venue-checkin"] > PRESENCE_SOURCE_CONFIDENCE.cell,
  );
  assert.ok(checkinHonoursFr48());
  assert.equal(preferredPresenceSource(["cell"]), "cell");
  assert.equal(preferredPresenceSource(["cell", "venue-checkin"]), "venue-checkin");
  assert.equal(
    preferredPresenceSource([]),
    null,
    "nothing available, nothing publishes",
  );
});

test("FR-48: an empty code fails closed, a present code attributes presence", () => {
  assert.deepEqual(planVenueCheckin("   "), {
    action: "refuse",
    reason: "empty-code",
  });
  assert.deepEqual(planVenueCheckin("FLR-2-9XK4"), {
    action: "checkin",
    endpoint: "POST /v1/presence/checkin",
    attributesPresence: true,
  });
});
