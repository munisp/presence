/**
 * FR-84: the co-location close offer — an exit that only ever suggests.
 *
 * When both parties to an open conversation remain co-located for 15
 * minutes, the client SHOULD offer to close the thread and stop
 * notifications, on the stated basis that they have met. Declining MUST
 * NOT affect the conversation.
 *
 * The contract pins the four testable edges of that sentence:
 *
 *   1. Timing — {@link closeOfferDue} fires only when the conversation
 *      is open AND the co-location clock has reached
 *      {@link COLOCATION_CLOSE_OFFER_MIN_MS}. Garbage input fails
 *      closed: a broken clock never produces the offer.
 *   2. Basis — the offer carries the pinned {@link CLOSE_OFFER_BASIS}
 *      sentence, so "on the stated basis that they have met" is a
 *      string the tests can hold, not a design intention.
 *   3. Decline safety — {@link applyCloseOfferDecision} returns the
 *      conversation snapshot untouched on decline: still open, still
 *      notifying, nothing re-offered. {@link declineLeavesIntact}
 *      proves the untouched half by deep comparison.
 *   4. Frequency — the offer state machine moves due → shown →
 *      declined|accepted and never returns, so the user is asked at
 *      most once per conversation.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test. No network, no platform APIs.
 */

/** FR-84: co-location duration that makes the close offer due. */
export const COLOCATION_CLOSE_OFFER_MIN_MS = 15 * 60 * 1000;

/** FR-84: the stated basis — the offer says WHY it is being made. */
export const CLOSE_OFFER_BASIS =
  "You've been near each other for a while — if you've met, you can close this thread and stop its notifications.";

/** The two answers the offer accepts. */
export const CLOSE_OFFER_ACTIONS = ["close-thread", "dismiss"] as const;

export type CloseOfferAction = (typeof CLOSE_OFFER_ACTIONS)[number];

/** Where the offer is in its once-per-conversation lifecycle. */
export type CloseOfferState = "not-due" | "due" | "shown" | "declined" | "accepted";

/** The conversation facts the decision logic may read — and only these. */
export interface CloseOfferInput {
  conversationOpen: boolean;
  coLocatedMs: number;
  offerState: CloseOfferState;
}

/** What the offer may change when accepted — and must not when declined. */
export interface ConversationSnapshot {
  conversationOpen: boolean;
  notificationsEnabled: boolean;
}

/**
 * FR-84 timing: due exactly when the conversation is open, the clock
 * has reached fifteen minutes, and the offer has not been answered.
 * NaN, negative, and infinite clocks fail closed to not-due.
 */
export function closeOfferDue(input: CloseOfferInput): boolean {
  if (!input.conversationOpen) return false;
  if (input.offerState !== "due" && input.offerState !== "not-due") return false;
  return (
    Number.isFinite(input.coLocatedMs) &&
    input.coLocatedMs >= COLOCATION_CLOSE_OFFER_MIN_MS
  );
}

/** The plan the surface renders: offer with its basis, or nothing. */
export function planCloseOffer(
  input: CloseOfferInput,
): { action: "offer"; basis: string } | { action: "none" } {
  if (closeOfferDue(input)) return { action: "offer", basis: CLOSE_OFFER_BASIS };
  return { action: "none" };
}

/** The result of answering the offer. */
export interface CloseOfferDecision {
  snapshot: ConversationSnapshot;
  offerState: CloseOfferState;
}

/**
 * FR-84 decisions. Accept closes the thread and stops notifications —
 * the whole point of the offer. Decline changes NOTHING about the
 * conversation: the snapshot comes back byte-identical and the offer
 * moves to "declined" so it is never re-asked.
 */
export function applyCloseOfferDecision(
  decision: CloseOfferAction,
  snapshot: ConversationSnapshot,
): CloseOfferDecision {
  if (decision === "close-thread") {
    return {
      snapshot: { conversationOpen: false, notificationsEnabled: false },
      offerState: "accepted",
    };
  }
  return { snapshot: { ...snapshot }, offerState: "declined" };
}

/**
 * FR-84 decline proof: declining leaves the conversation exactly as it
 * was — open state, notification state, everything.
 */
export function declineLeavesIntact(
  before: ConversationSnapshot,
  after: CloseOfferDecision,
): boolean {
  return (
    after.offerState === "declined" &&
    after.snapshot.conversationOpen === before.conversationOpen &&
    after.snapshot.notificationsEnabled === before.notificationsEnabled
  );
}
