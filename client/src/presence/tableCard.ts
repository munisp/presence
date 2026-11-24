/**
 * FR-66 / FR-67 (+FR-75, SEC-33): the TableCard.
 *
 * Per the SRS component inventory: "Scheduled gathering: time, place,
 * head count, one generated prompt." A table is a planned meet-up at a
 * venue; the card is what a prospective joiner sees, and what a member
 * sees once seated.
 *
 * The contract pins five things:
 *
 *   1. The field set — {@link TABLE_CARD_FIELDS} is exactly time,
 *      place, head count, and prompt. The prompt is singular in the
 *      type: one generated prompt per card, and {@link generatedPrompt}
 *      refuses anything not carrying the generated label — cards are
 *      icebreaker suggestions, never user-authored text.
 *
 *   2. The prompt mirrors the server's buildCards contract
 *      (services/edge/src/groups.ts): shared-interest nodes with at
 *      least CARD_MIN_SHARED members, capped at CARD_LIMIT, members
 *      sorted, generated: true. {@link TABLE_CARD_MIN_SHARED} and
 *      {@link TABLE_CARD_LIMIT} cross-pin those constants.
 *
 *   3. Joining is self-serve while open — and bounded. SEC-33: the
 *      seventh join is refused, so a table seats at most
 *      {@link TABLE_SEAT_MAX}. {@link planJoin} mirrors the route:
 *      open with a free seat joins (and refreshes the shared-interest
 *      snapshot, FR-67); a full or closed table refuses with the
 *      pinned reason; garbage fails closed.
 *
 *   4. The pre-join probe reveals only venue and headcount (FR-75).
 *      {@link PROBE_FIELDS} is the pinned pair and
 *      {@link probeRevealsOnlyVenueAndHeadcount} proves no other key
 *      can ride along.
 *
 *   5. FR-87 applies here too: the card descriptor runs through the
 *      surface-integrity registry — no like counts, no infinite
 *      scroll, no photos.
 *
 * Imports are pinned by tests/test_batch41.py: surfaceIntegrity.js
 * only. No network, no platform APIs.
 */

import {
  honoursSurfaceProhibitions,
  type SurfaceDescriptor,
} from "./surfaceIntegrity.js";

/** SEC-33: a table seats six; the seventh join is refused. */
export const TABLE_SEAT_MAX = 6;

/** Mirror of CARD_MIN_SHARED in services/edge/src/groups.ts. */
export const TABLE_CARD_MIN_SHARED = 2;

/** Mirror of CARD_LIMIT in services/edge/src/groups.ts. */
export const TABLE_CARD_LIMIT = 5;

/** FR-66: the pinned card field set — nothing else may render. */
export const TABLE_CARD_FIELDS = [
  "time",
  "place",
  "headCount",
  "prompt",
] as const;

export type TableCardField = (typeof TABLE_CARD_FIELDS)[number];

/**
 * FR-67: one generated prompt — the client mirror of the buildCards
 * row. `generated` is the literal true: cards are suggestions the
 * system makes, never user-authored content.
 */
export interface GeneratedPrompt {
  nodeId: string;
  label: string;
  memberCount: number;
  members: readonly string[];
  generated: true;
}

/** What the TableCard renders — exactly the pinned field set. */
export interface TableCardData {
  tableId: string;
  /** Scheduled gathering time, ISO-8601. */
  time: string;
  /** The venue. */
  place: string;
  headCount: number;
  /** ONE generated prompt (FR-66 inventory: singular). */
  prompt: GeneratedPrompt;
}

/**
 * FR-67: the prompt is valid iff it carries the generated label, at
 * least {@link TABLE_CARD_MIN_SHARED} members (the buildCards filter),
 * and a sorted member list — the server ships members sorted, and the
 * client asserts rather than re-sorting.
 */
export function generatedPrompt(prompt: GeneratedPrompt): boolean {
  if (prompt.generated !== true) return false;
  if (
    !Number.isInteger(prompt.memberCount) ||
    prompt.memberCount < TABLE_CARD_MIN_SHARED ||
    prompt.memberCount !== prompt.members.length
  ) {
    return false;
  }
  const sorted = [...prompt.members].sort();
  return prompt.members.every((member, index) => member === sorted[index]);
}

/** The join decision the surface renders. */
export type JoinPlan =
  | {
      readonly action: "join";
      /** FR-67: (re-)joining refreshes the shared-interest snapshot. */
      readonly refreshesSnapshot: true;
    }
  | {
      readonly action: "refuse";
      readonly reason: "table-full" | "table-closed" | "invalid";
    };

/**
 * FR-66/SEC-33: plan a join. An open table with a free seat joins and
 * refreshes the snapshot (FR-67); the seventh seat is refused, as is a
 * closed table; non-integer or negative seat counts fail closed.
 */
export function planJoin(open: boolean, seatedCount: number): JoinPlan {
  if (!Number.isInteger(seatedCount) || seatedCount < 0) {
    return { action: "refuse", reason: "invalid" };
  }
  if (!open) return { action: "refuse", reason: "table-closed" };
  if (seatedCount >= TABLE_SEAT_MAX) {
    return { action: "refuse", reason: "table-full" };
  }
  return { action: "join", refreshesSnapshot: true };
}

/** FR-75: the pre-join probe reveals only venue and headcount. */
export const PROBE_FIELDS = ["venue", "headCount"] as const;

export type JoinProbe = Record<(typeof PROBE_FIELDS)[number], unknown>;

/**
 * FR-75: the probe carries exactly the pinned pair of keys — no member
 * identities, no interest labels, nothing else.
 */
export function probeRevealsOnlyVenueAndHeadcount(
  probe: Record<string, unknown>,
): boolean {
  const keys = Object.keys(probe);
  return (
    keys.length === PROBE_FIELDS.length &&
    PROBE_FIELDS.every((field) => keys.includes(field))
  );
}

/** The card's affordances, pinned: view, join, leave. */
export const TABLE_CARD_AFFORDANCES = [
  "view-card",
  "join-table",
  "leave-table",
] as const;

/** The generic descriptor view of the card, for the FR-87 audit. */
export function tableCardDescriptor(card: TableCardData): SurfaceDescriptor {
  return {
    kind: "table-card",
    affordances: TABLE_CARD_AFFORDANCES,
    fields: {
      time: card.time,
      place: card.place,
      headCount: card.headCount,
      prompt: card.prompt.label,
      generated: card.prompt.generated,
    },
  };
}

/** The guard a renderer asserts: the card carries no FR-87 violation. */
export function tableCardHonoursFr87(card: TableCardData): boolean {
  return honoursSurfaceProhibitions(tableCardDescriptor(card));
}
