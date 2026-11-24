/**
 * FR-03 / FR-08 / FR-41 / FR-48: the journey contracts.
 *
 * Four end-to-end journeys whose server sides already exist; this module
 * pins the client half of each so the requirement is testable rather
 * than aspirational.
 *
 *   1. FR-03 — account deletion. "A user MUST be able to delete their
 *      account from inside the app, without contacting support, in at
 *      most three taps." The journey is the pinned
 *      {@link ACCOUNT_DELETE_JOURNEY}: three steps, ending in
 *      DELETE /v1/account (account.ts — one call erases). No step is or
 *      can be "contact support"; {@link journeyWithinTapBudget} and
 *      {@link journeyNeedsNoSupport} are the proofs.
 *
 *   2. FR-08 — interest editing. The editor mirrors the server mirror
 *      (profile.ts INTEREST_MIN/MAX): 3 to 20 interests from a searchable
 *      taxonomy, at most three levels deep in the first interaction. The
 *      FR-08/FR-11 acceptance is the publish block: with fewer than
 *      three declarations the client explains why (one pinned sentence),
 *      offers the picker, and does NOT publish until the third is
 *      confirmed — {@link presenceReadiness} fails closed.
 *
 *   3. FR-41 — conversation deletion and message revocation. A
 *      conversation can be deleted locally (this device only — the
 *      pinned {@link LOCAL_DELETE_NOTE} says exactly that), and a user's
 *      OWN messages can be revoked within 24 hours of sending, mirroring
 *      the messages.ts window and its 410 semantics. The window is
 *      {@link MESSAGE_REVOKE_WINDOW_MS}; {@link revokeAvailable} fails
 *      closed on garbage timestamps and never offers revocation for
 *      anyone else's message.
 *
 *   4. FR-48 — venue check-in. A venue displays a check-in code that
 *      attributes presence with higher confidence than cell matching
 *      alone; FR-89 makes that code mandatory indoors, where cell
 *      presence is the fallback, never the default. The confidence
 *      ordering {@link PRESENCE_SOURCE_CONFIDENCE} is the testable
 *      statement, and the code is the pinned alternative the FR-88
 *      accuracy refusal already offers (publishGate.ts) — the journey
 *      posts to POST /v1/presence/checkin, which needs no location
 *      grant at all.
 *
 * Imports are pinned by tests/test_batch41.py: publishGate.js (the
 * refusal alternative the check-in journey fulfils) and
 * constellationPicker.js (the picker the FR-08 block offers). No
 * network, no platform APIs.
 */

import { ACCURACY_REFUSAL_ALTERNATIVE } from "./publishGate.js";
import { MAX_PICKER_INTERACTIONS } from "./constellationPicker.js";

/* ------------------------------------------------------------------ */
/* FR-03: account deletion in at most three taps, inside the app.      */
/* ------------------------------------------------------------------ */

/** FR-03: the tap budget. */
export const ACCOUNT_DELETE_MAX_TAPS = 3;

/**
 * FR-03: the pinned journey — settings, account, confirm. Three steps,
 * each one tap, and the last one issues DELETE /v1/account, which
 * account.ts answers by erasing the account in one call.
 */
export const ACCOUNT_DELETE_JOURNEY = [
  "open-settings",
  "open-account",
  "confirm-delete",
] as const;

export type AccountDeleteStep = (typeof ACCOUNT_DELETE_JOURNEY)[number];

/** FR-03: the endpoint the final tap calls. */
export const ACCOUNT_DELETE_ENDPOINT = "DELETE /v1/account";

/** FR-03: the journey fits the budget — at most three taps. */
export function journeyWithinTapBudget(
  journey: readonly string[],
): boolean {
  return journey.length <= ACCOUNT_DELETE_MAX_TAPS;
}

/**
 * FR-03: "without contacting support" — the proof is structural: no
 * step in the journey may be a support contact.
 */
export function journeyNeedsNoSupport(journey: readonly string[]): boolean {
  return !journey.some((step) => step.toLowerCase().includes("support"));
}

/** The plan the account screen renders. */
export interface AccountDeletePlan {
  steps: readonly AccountDeleteStep[];
  endpoint: typeof ACCOUNT_DELETE_ENDPOINT;
  withinBudget: boolean;
  needsNoSupport: boolean;
}

export function planAccountDelete(): AccountDeletePlan {
  return {
    steps: ACCOUNT_DELETE_JOURNEY,
    endpoint: ACCOUNT_DELETE_ENDPOINT,
    withinBudget: journeyWithinTapBudget(ACCOUNT_DELETE_JOURNEY),
    needsNoSupport: journeyNeedsNoSupport(ACCOUNT_DELETE_JOURNEY),
  };
}

/* ------------------------------------------------------------------ */
/* FR-08: 3–20 interests, searchable taxonomy, ≤3 levels first touch.  */
/* ------------------------------------------------------------------ */

/** FR-08: mirror of services/edge/src/profile.ts INTEREST_MIN. */
export const INTEREST_MIN_DECLARED = 3;

/** FR-08: mirror of services/edge/src/profile.ts INTEREST_MAX. */
export const INTEREST_MAX_DECLARED = 20;

/**
 * FR-08: "no more than three levels deep in the first interaction" —
 * the taxonomy browser may not nest deeper than this on first use.
 */
export const TAXONOMY_FIRST_INTERACTION_MAX_DEPTH = 3;

/**
 * FR-08/FR-11 acceptance: the one-sentence explanation shown when the
 * user tries to enable presence with fewer than three interests.
 */
export const INTERESTS_PUBLISH_BLOCK_SENTENCE =
  "A good introduction needs at least three interests — add one more and you're discoverable.";

/** FR-08: a declaration set is valid iff it is 3..20 entries. */
export function interestDeclarationValid(declared: number): boolean {
  return (
    Number.isInteger(declared) &&
    declared >= INTEREST_MIN_DECLARED &&
    declared <= INTEREST_MAX_DECLARED
  );
}

/** FR-08: the first interaction may not exceed the pinned depth. */
export function firstInteractionWithinDepth(depth: number): boolean {
  return (
    Number.isInteger(depth) &&
    depth >= 1 &&
    depth <= TAXONOMY_FIRST_INTERACTION_MAX_DEPTH
  );
}

/** The answer to "may presence publish with this declaration set?" */
export type PresenceReadiness =
  | { readonly publish: true }
  | {
      readonly publish: false;
      readonly reason: "too-few-interests";
      readonly sentence: typeof INTERESTS_PUBLISH_BLOCK_SENTENCE;
      readonly offer: "constellation-picker";
      readonly missing: number;
    };

/**
 * FR-08/FR-11 acceptance, executable: fewer than three declared
 * interests blocks the publish, explains why in the pinned sentence,
 * and offers the picker — and the picker is exactly the surface that
 * reaches three declarations inside {@link MAX_PICKER_INTERACTIONS}
 * interactions. Garbage counts fail closed to blocked.
 */
export function presenceReadiness(declared: number): PresenceReadiness {
  if (Number.isInteger(declared) && declared >= INTEREST_MIN_DECLARED) {
    return { publish: true };
  }
  const missing = Number.isInteger(declared)
    ? INTEREST_MIN_DECLARED - Math.max(declared, 0)
    : INTEREST_MIN_DECLARED;
  return {
    publish: false,
    reason: "too-few-interests",
    sentence: INTERESTS_PUBLISH_BLOCK_SENTENCE,
    offer: "constellation-picker",
    missing,
  };
}

/** FR-08: the offered picker resolves the block inside its budget. */
export function pickerResolvesBlock(readiness: PresenceReadiness): boolean {
  if (readiness.publish) return true;
  return readiness.missing <= MAX_PICKER_INTERACTIONS;
}

/* ------------------------------------------------------------------ */
/* FR-41: local conversation delete + 24-hour own-message revocation.  */
/* ------------------------------------------------------------------ */

/**
 * FR-41: the revocation window, mirroring the messages.ts predicate
 * `sent_at > now() - interval '24 hours'`.
 */
export const MESSAGE_REVOKE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** FR-41: the pinned 410 body the server returns past the window. */
export const REVOKE_WINDOW_CLOSED_ERROR =
  "the 24-hour revocation window has closed (FR-41)";

/**
 * FR-41: what a local delete means — the pinned honesty sentence. A
 * local delete removes the conversation from THIS device; it never
 * claims to erase the other party's copy.
 */
export const LOCAL_DELETE_NOTE =
  "Deleting removes this conversation from this device only.";

/** The message facts the revocation decision may read — and only these. */
export interface RevocableMessage {
  own: boolean;
  sentAtMs: number;
}

/**
 * FR-41: revocation is offered exactly for the user's own messages
 * still inside the window — the same predicate messages.ts enforces,
 * so the client never offers what the server would 410. Someone else's
 * message, a garbage timestamp, or a future timestamp fails closed.
 */
export function revokeAvailable(
  message: RevocableMessage,
  nowMs: number,
): boolean {
  if (!message.own) return false;
  if (!Number.isFinite(message.sentAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  const age = nowMs - message.sentAtMs;
  return age >= 0 && age < MESSAGE_REVOKE_WINDOW_MS;
}

/**
 * FR-41: delete a conversation locally. Pure: the conversation list
 * comes back without the id, nothing else changes, and the caller
 * renders {@link LOCAL_DELETE_NOTE} so the scope is never ambiguous.
 */
export function deleteConversationLocally<T extends { id: string }>(
  conversations: readonly T[],
  id: string,
): T[] {
  return conversations.filter((conversation) => conversation.id !== id);
}

/* ------------------------------------------------------------------ */
/* FR-48 (+FR-89): venue check-in outranks cell matching.              */
/* ------------------------------------------------------------------ */

/** FR-48: the endpoint the check-in journey posts to. */
export const VENUE_CHECKIN_ENDPOINT = "POST /v1/presence/checkin";

/**
 * FR-48: "higher confidence than cell matching alone" as a testable
 * ordering. Venue check-in is a signed, venue-bound artefact; a cell is
 * a radio measurement. FR-89: indoors, the cell is the fallback —
 * never the default.
 */
export const PRESENCE_SOURCE_CONFIDENCE = {
  "venue-checkin": 2,
  cell: 1,
} as const;

export type PresenceSource = keyof typeof PRESENCE_SOURCE_CONFIDENCE;

/**
 * FR-89: pick the presence source. The highest-confidence available
 * source wins, so an available check-in code always beats the cell;
 * with no code the cell is the fallback. An empty availability list
 * yields null — the caller publishes nothing.
 */
export function preferredPresenceSource(
  available: readonly PresenceSource[],
): PresenceSource | null {
  let best: PresenceSource | null = null;
  for (const source of available) {
    if (
      best === null ||
      PRESENCE_SOURCE_CONFIDENCE[source] > PRESENCE_SOURCE_CONFIDENCE[best]
    ) {
      best = source;
    }
  }
  return best;
}

/** The plan the check-in surface executes. */
export type VenueCheckinPlan =
  | {
      readonly action: "checkin";
      readonly endpoint: typeof VENUE_CHECKIN_ENDPOINT;
      readonly attributesPresence: true;
    }
  | { readonly action: "refuse"; readonly reason: "empty-code" };

/**
 * FR-48: plan a venue check-in. An empty or whitespace-only code fails
 * closed — no request is made. A present code posts to the pinned
 * endpoint, and the resulting presence is attributed to the venue.
 */
export function planVenueCheckin(code: string): VenueCheckinPlan {
  if (code.trim().length === 0) {
    return { action: "refuse", reason: "empty-code" };
  }
  return {
    action: "checkin",
    endpoint: VENUE_CHECKIN_ENDPOINT,
    attributesPresence: true,
  };
}

/**
 * FR-48/FR-88: the check-in journey is exactly the alternative the
 * accuracy refusal offers, and its confidence strictly outranks the
 * cell. Both halves are compile-time constants; this guard makes them
 * runtime-assertable.
 */
export function checkinHonoursFr48(): boolean {
  return (
    ACCURACY_REFUSAL_ALTERNATIVE === "venue-checkin" &&
    PRESENCE_SOURCE_CONFIDENCE["venue-checkin"] >
      PRESENCE_SOURCE_CONFIDENCE.cell
  );
}
