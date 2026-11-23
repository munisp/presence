/**
 * FR-17/FR-71: time-boxed intents and the recurrence signal.
 *
 * An intent is a small, governed word a live user declares ("here for
 * coffee") that expires with their presence or after sixty minutes,
 * whichever comes first. When two surfaced users share an active intent the
 * scan marks the result — a match signal the client can render without the
 * numeric score contract moving an inch.
 *
 * The recurrence signal counts the distinct days a pair has been surfaced:
 * a day ordinal (never a timestamp), at most one bump per day, keyed by the
 * hash of the canonical pair so the store never names the users.
 */

import { createHash } from "node:crypto";

/** FR-17: the governed intent vocabulary — closed, edge-owned. */
export const INTENT_VOCABULARY = [
  "coffee",
  "food",
  "chat",
  "walk",
  "dance",
  "network",
  "explore",
  "quiet",
] as const;
export type Intent = (typeof INTENT_VOCABULARY)[number];

/** FR-17: hard cap from declaration; earlier presence purge still wins. */
export const INTENT_TTL_S = 3600;

export function parseIntent(body: unknown): { ok: true; intent: Intent } | { ok: false } {
  if (body === null || typeof body !== "object") return { ok: false };
  const value = (body as Record<string, unknown>).intent;
  return typeof value === "string" && (INTENT_VOCABULARY as readonly string[]).includes(value)
    ? { ok: true, intent: value as Intent }
    : { ok: false };
}

/** FR-71: days since the epoch — an ordinal, never a timestamp. */
export function dayOrdinal(now: Date): number {
  return Math.floor(now.getTime() / 86_400_000);
}

/** FR-71: the pair is hashed; the store never names the users. */
export function recurrenceKey(lo: string, hi: string): string {
  const digest = createHash("sha256").update(`${lo}:${hi}`).digest("hex");
  return `recur:${digest.slice(0, 24)}`;
}

/** FR-71: retention for the day counter — ninety days, then it fades. */
export const RECURRENCE_TTL_S = 7_776_000;

export interface Recurrence {
  days: number;
  lastDay: number;
}

/**
 * FR-71: advance the counter for today's surfacing. At most one bump per
 * day — a second surfacing on the same day changes nothing.
 */
export function bumpRecurrence(stored: Recurrence | null, today: number): { next: Recurrence; bumped: boolean } {
  if (stored === null) return { next: { days: 1, lastDay: today }, bumped: true };
  if (stored.lastDay === today) return { next: stored, bumped: false };
  return { next: { days: stored.days + 1, lastDay: today }, bumped: true };
}

export function parseRecurrence(raw: string | null): Recurrence | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Recurrence;
    if (typeof v.days !== "number" || typeof v.lastDay !== "number") return null;
    return v;
  } catch {
    return null;
  }
}
