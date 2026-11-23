/**
 * Offer lifecycle (PRS-SRS-001 §5.4): windows, masking and block keys.
 *
 * Pure helpers + constants live here so the contract is testable without a
 * database; the SQL tick itself lives in db/migrations/0002 (lifecycle_tick,
 * SECURITY DEFINER) and is driven by startLifecycleJob().
 *
 *   FR-32  silent decline — maskCloseReason maps 'declined' → 'expired'
 *   FR-33  offers expire OFFER_TTL_MS after the last action
 *   FR-34  blockKey is the permanent (no-TTL) discovery-suppression key
 *   FR-37  conversations close CONVERSATION_TTL_MS after OPEN unless both keep
 */

import Postgres from "pg";

export const OFFER_TTL_MS = 30 * 60 * 1000;               // FR-33
export const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;   // FR-37
export const PURGE_AFTER_CLOSE_MS = 24 * 60 * 60 * 1000;  // NFR-20
export const LIFECYCLE_TICK_MS = 60 * 1000;

export type CloseReason = "expired" | "declined" | "blocked" | "lapsed";

/** FR-34 block key — canonical ordering, permanent (no TTL, unlike FR-23). */
export function blockKey(a: string, b: string): string {
  return a < b ? `block:${a}:${b}` : `block:${b}:${a}`;
}

/**
 * What the viewing user is allowed to see (FR-32/34):
 *  - 'declined' is presented as 'expired' — the counterpart never learns the
 *    offer was actively declined;
 *  - 'blocked' pairs are hidden entirely (silent, permanent removal);
 *  - 'expired' / 'lapsed' pass through unchanged.
 */
export function maskCloseReason(reason: CloseReason): "expired" | "lapsed" | null {
  if (reason === "blocked") return null;
  if (reason === "declined") return "expired";
  return reason;
}

/** A pair accepts offers/waves only while open and inside its window. */
export function isOfferLive(state: string, closedAt: unknown, expiresAt: unknown): boolean {
  return state !== "OPEN" && closedAt == null && (expiresAt == null || new Date(expiresAt as string) > new Date());
}

/** Run one lifecycle tick (expiry → lapse → purge). Returns the row counts. */
export async function lifecycleTick(pg: Postgres.Pool): Promise<{
  offersExpired: number;
  conversationsLapsed: number;
  envelopesPurged: number;
}> {
  const r = await pg.query("SELECT * FROM lifecycle_tick()");
  const row = r.rows[0];
  return {
    offersExpired: row.offers_expired,
    conversationsLapsed: row.conversations_lapsed,
    envelopesPurged: row.envelopes_purged,
  };
}

/** Drive the tick once a minute. Returns a stop function (for tests/shutdown). */
export function startLifecycleJob(pg: Postgres.Pool, intervalMs = LIFECYCLE_TICK_MS): () => void {
  const timer = setInterval(() => {
    lifecycleTick(pg).catch((err) => console.error("lifecycle tick failed", err));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
