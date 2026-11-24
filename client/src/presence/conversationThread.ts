/**
 * FR-41 / FR-84 / FR-87 (+FR-38/SEC-21): the conversation thread.
 *
 * The thread is the surface where the FR-87 engagement bans bind
 * hardest: there is no typing indicator and no read receipt here, and
 * there never can be, because the thread's affordance list is pinned
 * and audited against the surface-integrity registry.
 *
 * The contract pins four things:
 *
 *   1. Affordances — {@link THREAD_AFFORDANCES} is the complete list:
 *      send, revoke your own message, answer the close offer, delete
 *      the local copy, leave. {@link typingAndReceiptsBanned} proves
 *      the two banned patterns are absent by construction, and
 *      {@link threadHonoursFr87} runs the descriptor through the
 *      registry so no future edit can smuggle one in.
 *
 *   2. Revocation — FR-41 lives here as {@link planRevoke}: only the
 *      user's own messages, only inside the 24-hour window
 *      (journeyContracts.ts mirrors the messages.ts predicate), and
 *      past the window the surface renders the server's pinned 410
 *      sentence instead of offering what would fail.
 *
 *   3. First-message screening — FR-38/SEC-21: the first message each
 *      sender posts to a pair is screened. {@link composeRequiresScreening}
 *      marks exactly that message so the compose path routes it through
 *      the same classifier the server runs.
 *
 *   4. The close offer — FR-84 lives in closeOffer.ts; the thread
 *      carries its state and delegates, so the offer logic has exactly
 *      one home. {@link planThreadCloseOffer} is the wiring, not a
 *      reimplementation.
 *
 * Message bodies are opaque envelopes: the thread renders ciphertext
 * placeholders and never sees plaintext — screening and revocation
 * work on envelope metadata alone.
 *
 * Imports are pinned by tests/test_batch41.py: closeOffer.js (FR-84),
 * journeyContracts.js (FR-41 window + local delete), surfaceIntegrity.js
 * (the FR-87 registry). No network, no platform APIs.
 */

import {
  applyCloseOfferDecision,
  planCloseOffer,
  type CloseOfferAction,
  type CloseOfferInput,
  type CloseOfferState,
  type ConversationSnapshot,
} from "./closeOffer.js";
import {
  LOCAL_DELETE_NOTE,
  MESSAGE_REVOKE_WINDOW_MS,
  REVOKE_WINDOW_CLOSED_ERROR,
  deleteConversationLocally,
  revokeAvailable,
  type RevocableMessage,
} from "./journeyContracts.js";
import {
  honoursSurfaceProhibitions,
  type SurfaceDescriptor,
} from "./surfaceIntegrity.js";

/**
 * The complete affordance list. Typing indicators and read receipts
 * are not merely unimplemented — they are absent from the type, so the
 * FR-87 registry audit is a formality the tests still run.
 */
export const THREAD_AFFORDANCES = [
  "send-message",
  "revoke-own-message",
  "answer-close-offer",
  "delete-local-copy",
  "leave-conversation",
] as const;

export type ThreadAffordance = (typeof THREAD_AFFORDANCES)[number];

/**
 * FR-87, executable: the two chat-specific engagement mechanics the
 * SRS bans outright are absent from the affordance list.
 */
export function typingAndReceiptsBanned(): boolean {
  return (
    !THREAD_AFFORDANCES.includes("typing-indicator" as never) &&
    !THREAD_AFFORDANCES.includes("read-receipt" as never)
  );
}

/** One rendered message: an opaque envelope plus revocation metadata. */
export interface ThreadMessage extends RevocableMessage {
  messageId: string;
  /** Ciphertext envelope; the thread never renders plaintext. */
  envelope: string;
}

/** The thread facts the planner may read — and only these. */
export interface ThreadState {
  pairId: string;
  messages: readonly ThreadMessage[];
  /** Messages this user has already sent to the pair (FR-38 marker). */
  sentCount: number;
  closeOffer: CloseOfferInput;
  snapshot: ConversationSnapshot;
}

/* ------------------------------------------------------------------ */
/* FR-41: revocation and local deletion.                               */
/* ------------------------------------------------------------------ */

/** FR-41: the endpoint a revoke calls (messages.ts). */
export const REVOKE_ENDPOINT_TEMPLATE =
  "DELETE /v1/pairs/:pairId/messages/:messageId";

/** What the revoke affordance plans for one message. */
export type RevokePlan =
  | {
      readonly action: "revoke";
      readonly endpoint: string;
    }
  | {
      readonly action: "unavailable";
      readonly reason: "not-own" | "window-closed";
      readonly notice: typeof REVOKE_WINDOW_CLOSED_ERROR | null;
    };

/**
 * FR-41: plan revocation for one message. Inside the window the plan
 * is the pinned endpoint; past it the surface shows the server's 410
 * sentence and offers nothing; someone else's message never gets an
 * affordance at all.
 */
export function planRevoke(
  thread: ThreadState,
  message: ThreadMessage,
  nowMs: number,
): RevokePlan {
  if (revokeAvailable(message, nowMs)) {
    return {
      action: "revoke",
      endpoint: REVOKE_ENDPOINT_TEMPLATE.replace(
        ":pairId",
        thread.pairId,
      ).replace(":messageId", message.messageId),
    };
  }
  if (!message.own) {
    return { action: "unavailable", reason: "not-own", notice: null };
  }
  return {
    action: "unavailable",
    reason: "window-closed",
    notice: REVOKE_WINDOW_CLOSED_ERROR,
  };
}

/** FR-41: local deletion, re-exported through the thread's lens. */
export function planLocalDelete(
  conversations: readonly { id: string }[],
  id: string,
): { remaining: { id: string }[]; note: typeof LOCAL_DELETE_NOTE } {
  return { remaining: deleteConversationLocally(conversations, id), note: LOCAL_DELETE_NOTE };
}

/* ------------------------------------------------------------------ */
/* FR-38/SEC-21: the first message is screened.                        */
/* ------------------------------------------------------------------ */

/**
 * FR-38: the first message each sender posts to a pair is screened —
 * the compose path must route exactly that envelope through the
 * classifier the server runs (messages.ts, screening.ts).
 */
export function composeRequiresScreening(sentCount: number): boolean {
  return sentCount === 0;
}

/* ------------------------------------------------------------------ */
/* FR-84: the close offer is delegated, not reimplemented.             */
/* ------------------------------------------------------------------ */

/** FR-84: the thread's close-offer plan — closeOffer.ts decides. */
export function planThreadCloseOffer(
  thread: ThreadState,
): ReturnType<typeof planCloseOffer> {
  return planCloseOffer(thread.closeOffer);
}

/** FR-84: answering the offer updates offer state and the snapshot. */
export function answerThreadCloseOffer(
  thread: ThreadState,
  action: CloseOfferAction,
): { closeOfferState: CloseOfferState; snapshot: ConversationSnapshot } {
  const decision = applyCloseOfferDecision(action, thread.snapshot);
  return { closeOfferState: decision.offerState, snapshot: decision.snapshot };
}

/* ------------------------------------------------------------------ */
/* The descriptor and the FR-87 audit.                                 */
/* ------------------------------------------------------------------ */

/** The generic descriptor view of the thread, for the registry audit. */
export function threadDescriptor(thread: ThreadState): SurfaceDescriptor {
  return {
    kind: "conversation-thread",
    affordances: THREAD_AFFORDANCES,
    fields: {
      messageCount: thread.messages.length,
      closeOfferState: thread.closeOffer.offerState,
      revokeWindowMs: MESSAGE_REVOKE_WINDOW_MS,
      deleteScope: "local-only",
    },
  };
}

/**
 * The guard the surface asserts before rendering: no FR-87 engagement
 * mechanic anywhere in the descriptor, and the chat-specific bans
 * absent from the affordance list.
 */
export function threadHonoursFr87(thread: ThreadState): boolean {
  return (
    typingAndReceiptsBanned() &&
    honoursSurfaceProhibitions(threadDescriptor(thread))
  );
}
