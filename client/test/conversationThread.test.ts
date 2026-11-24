/** FR-41/FR-84/FR-87: the conversation thread inherits the registry. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REVOKE_ENDPOINT_TEMPLATE,
  THREAD_AFFORDANCES,
  answerThreadCloseOffer,
  composeRequiresScreening,
  planLocalDelete,
  planRevoke,
  planThreadCloseOffer,
  threadDescriptor,
  threadHonoursFr87,
  typingAndReceiptsBanned,
  type ThreadState,
} from "../src/presence/conversationThread.js";
import { MESSAGE_REVOKE_WINDOW_MS } from "../src/presence/journeyContracts.js";

const NOW = 1_700_000_000_000;

function thread(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    pairId: "pair-1",
    messages: [
      { messageId: "m1", own: true, sentAtMs: NOW - 1000, envelope: "Y2lwaGVy" },
      {
        messageId: "m2",
        own: false,
        sentAtMs: NOW - 2000,
        envelope: "Y2lwaGVy",
      },
    ],
    sentCount: 1,
    closeOffer: {
      conversationOpen: true,
      coLocatedMs: 16 * 60 * 1000,
      offerState: "not-due",
    },
    snapshot: { conversationOpen: true, notificationsEnabled: true },
    ...overrides,
  };
}

test("FR-87: typing indicators and read receipts are absent by construction", () => {
  assert.ok(typingAndReceiptsBanned());
  assert.deepEqual(THREAD_AFFORDANCES, [
    "send-message",
    "revoke-own-message",
    "answer-close-offer",
    "delete-local-copy",
    "leave-conversation",
  ]);
  assert.ok(threadHonoursFr87(thread()));
  const descriptor = threadDescriptor(thread());
  assert.equal(descriptor.kind, "conversation-thread");
  assert.equal(descriptor.fields.deleteScope, "local-only");
  assert.equal(descriptor.fields.revokeWindowMs, MESSAGE_REVOKE_WINDOW_MS);
});

test("FR-41: an own message inside the window plans the pinned endpoint", () => {
  const plan = planRevoke(thread(), thread().messages[0], NOW);
  assert.equal(plan.action, "revoke");
  if (plan.action === "revoke") {
    assert.equal(
      plan.endpoint,
      REVOKE_ENDPOINT_TEMPLATE.replace(":pairId", "pair-1").replace(
        ":messageId",
        "m1",
      ),
    );
    assert.equal(plan.endpoint, "DELETE /v1/pairs/pair-1/messages/m1");
  }
});

test("FR-41: past the window the surface shows the server's 410 sentence", () => {
  const stale = thread({
    messages: [
      {
        messageId: "m9",
        own: true,
        sentAtMs: NOW - MESSAGE_REVOKE_WINDOW_MS - 1,
        envelope: "Y2lwaGVy",
      },
    ],
  });
  const plan = planRevoke(stale, stale.messages[0], NOW);
  assert.deepEqual(plan, {
    action: "unavailable",
    reason: "window-closed",
    notice: "the 24-hour revocation window has closed (FR-41)",
  });
});

test("FR-41: someone else's message never gets a revoke affordance", () => {
  const plan = planRevoke(thread(), thread().messages[1], NOW);
  assert.deepEqual(plan, {
    action: "unavailable",
    reason: "not-own",
    notice: null,
  });
});

test("FR-41: local delete returns the remainder and the honesty note", () => {
  const { remaining, note } = planLocalDelete(
    [{ id: "a" }, { id: "b" }],
    "a",
  );
  assert.deepEqual(remaining, [{ id: "b" }]);
  assert.equal(note, "Deleting removes this conversation from this device only.");
});

test("FR-38: only the sender's first message requires screening", () => {
  assert.ok(composeRequiresScreening(0));
  assert.ok(!composeRequiresScreening(1));
  assert.ok(!composeRequiresScreening(42));
});

test("FR-84: the close offer is delegated, and declining changes nothing", () => {
  assert.deepEqual(planThreadCloseOffer(thread()), {
    action: "offer",
    basis:
      "You've been near each other for a while — if you've met, you can close this thread and stop its notifications.",
  });
  const declined = answerThreadCloseOffer(thread(), "dismiss");
  assert.equal(declined.closeOfferState, "declined");
  assert.deepEqual(declined.snapshot, {
    conversationOpen: true,
    notificationsEnabled: true,
  });
  const accepted = answerThreadCloseOffer(thread(), "close-thread");
  assert.equal(accepted.closeOfferState, "accepted");
  assert.deepEqual(accepted.snapshot, {
    conversationOpen: false,
    notificationsEnabled: false,
  });
});
