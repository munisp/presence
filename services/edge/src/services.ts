/**
 * Service bookings (SRS Addendum 001 — AMD-SVC-01..05).
 *
 * Pinned constants cross-checked against db/migrations/0036_service_bookings.sql
 * by tests/test_batch61.py — a change here without a matching migration
 * change fails the suite.
 *
 * A service booking is a structured record and nothing else: a service
 * listing, an agreed total, a milestone count. There is no description, no
 * scheduling free text, no address field — the wire shape has no field
 * that could carry one (FR-87/FR-96/SEC-37 unchanged). The agreed value
 * moves exclusively through the AMD-INN-03 milestone escrow definers
 * inside the AMD-PAY-15 settlement gate — no new value machinery.
 */

/** AMD-SVC-02: the agreed total rides the AMD-PAY-05 ceiling. */
export const SERVICE_MAX_AMOUNT_MINOR = 5_000_000;
/** AMD-SVC-02: 1..12 milestones per booking (the escrow array bound). */
export const SERVICE_MAX_MILESTONES = 12;
/** AMD-SVC-04: an unstarted booking auto-refunds after 168 h. */
export const SERVICE_START_TTL_SECONDS = 604_800;
/** AMD-SVC-04: an in-progress booking escalates to disputed after 30 d. */
export const SERVICE_STALE_SECONDS = 2_592_000;
/** AMD-SVC-02: NGN is the launch currency (AMD-PAY-10). */
export const SERVICE_CURRENCY = "NGN";

/** AMD-SVC-01: the booking state machine. */
export const SERVICE_BOOKING_STATES = [
  "accepted", "in_progress", "completed", "cancelled", "disputed",
] as const;
export type ServiceBookingState = (typeof SERVICE_BOOKING_STATES)[number];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

export interface ServiceBookingDraft {
  listingId: string;
  agreedMinor: number;
  milestones: number;
}

/** AMD-SVC-02: {listingId, agreedMinor, milestones} only. */
export function parseServiceBookingBody(body: unknown): ServiceBookingDraft | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 3) return null;
  const { listingId, agreedMinor, milestones } = body;
  if (typeof listingId !== "string" || !UUID_RE.test(listingId)) return null;
  if (typeof agreedMinor !== "number" || !Number.isSafeInteger(agreedMinor)
      || agreedMinor <= 0 || agreedMinor > SERVICE_MAX_AMOUNT_MINOR) {
    return null;
  }
  if (typeof milestones !== "number" || !Number.isSafeInteger(milestones)
      || milestones < 1 || milestones > SERVICE_MAX_MILESTONES) {
    return null;
  }
  return { listingId, agreedMinor, milestones };
}

/** AMD-SVC-03: {decision} only — the moderation resolution. */
export function parseServiceResolutionBody(
  body: unknown,
): { decision: "refund" | "release" } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1) return null;
  if (body.decision !== "refund" && body.decision !== "release") return null;
  return { decision: body.decision };
}
