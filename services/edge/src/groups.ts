/**
 * Group surface constants and pure helpers (PRS-SRS-001 §4 group features).
 *
 *   FR-66  tables seat at most six; the cap below mirrors the data-layer
 *          trigger (SEC-33) so the edge can reject early with a clean 409.
 *   FR-67  conversation cards are built from the join-time interest
 *          snapshot and are always labelled generated — they are icebreaker
 *          material, never member-authored content.
 *   FR-68  slots are 1:1 and time-boxed; booking is the consent act.
 *   FR-69  exactly one host; the directory exposes name+role only.
 *
 * Everything here is pure so the route layer stays thin and the rules are
 * unit-testable without a database.
 */

/** FR-66/SEC-33: seats per group table. Keep in sync with the trigger. */
export const TABLE_MEMBER_CAP = 6;

/** FR-66: table display name bounds (mirrors varchar(80)). */
export const TABLE_NAME_MAX_LEN = 80;

/** FR-68: slot duration bounds (mirror the CHECK constraint). */
export const SLOT_MIN_MINUTES = 5;
export const SLOT_MAX_MINUTES = 60;
export const SLOT_DEFAULT_MINUTES = 15;

/** FR-67: at most this many cards per table per fetch. */
export const CARD_LIMIT = 5;

/** FR-67: a card needs at least this many members sharing the node. */
export const CARD_MIN_SHARED = 2;

export interface ParsedSlot {
  startsAt: Date;
  durationMinutes: number;
}

/** Trim and bound a table name; null when unusable (FR-66). */
export function parseTableName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > TABLE_NAME_MAX_LEN) return null;
  return name;
}

/**
 * Parse a slot offer (FR-68). The start must be a valid future timestamp;
 * the duration falls back to the default and is clamped to the CHECK range.
 * Returns null on any violation — the route turns that into a 422.
 */
export function parseSlot(
  startsAt: unknown,
  durationMinutes: unknown,
  now: Date = new Date(),
): ParsedSlot | null {
  if (typeof startsAt !== "string") return null;
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return null;
  if (start.getTime() <= now.getTime()) return null;
  let duration = SLOT_DEFAULT_MINUTES;
  if (durationMinutes !== undefined) {
    if (
      typeof durationMinutes !== "number" ||
      !Number.isInteger(durationMinutes) ||
      durationMinutes < SLOT_MIN_MINUTES ||
      durationMinutes > SLOT_MAX_MINUTES
    ) {
      return null;
    }
    duration = durationMinutes;
  }
  return { startsAt: start, durationMinutes: duration };
}

export interface SharedNodeRow {
  nodeId: string;
  label: string;
  members: string[];
}

export interface ConversationCard {
  nodeId: string;
  label: string;
  memberCount: number;
  members: string[];
  /** FR-67: cards are machine-derived icebreakers, labelled as such. */
  generated: true;
}

/**
 * FR-67: build conversation cards from shared declared interests. Input
 * rows are pre-aggregated by SQL (>= CARD_MIN_SHARED members per node);
 * output is ranked by reach then id, capped at CARD_LIMIT, and every card
 * carries the generated label.
 */
export function buildCards(rows: SharedNodeRow[]): ConversationCard[] {
  return rows
    .filter((r) => r.members.length >= CARD_MIN_SHARED)
    .map((r) => ({
      nodeId: r.nodeId,
      label: r.label,
      memberCount: r.members.length,
      members: [...r.members].sort(),
      generated: true as const,
    }))
    .sort((a, b) => b.memberCount - a.memberCount || a.nodeId.localeCompare(b.nodeId))
    .slice(0, CARD_LIMIT);
}
