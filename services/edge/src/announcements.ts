/**
 * Announcement rules (PRS-SRS-001 §4.10): publish caps, categories and the
 * inverted-consent response flow. Pure helpers; the routes enforce them.
 *
 *   FR-93  publish path with a trust floor and a four-hour TTL cap
 *   FR-95  one live announcement per account, one publish per 24 h,
 *          one response per account per announcement, <=5 shown
 *   FR-96  fixed category set; bodies screened (screening.ts, SEC-37)
 *   FR-97  'work' requires a verified-organisation token claim (BR-33)
 *   FR-94  responses are anonymous until the publisher accepts
 *   SEC-38 response listing is capped and identity-free pre-acceptance
 */

export const ANNOUNCEMENT_CATEGORIES = ["social", "work", "lost_found", "notice"] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];

export const ANNOUNCEMENT_MAX_TTL_MINUTES = 240;   // FR-93: four-hour cap
export const ANNOUNCEMENT_MIN_ACCOUNT_AGE_H = 24;  // FR-93: trust floor
export const ANNOUNCEMENT_PUBLISH_COOLDOWN_H = 24; // FR-95: one publish per day
export const RESPONSES_SHOWN_MAX = 5;              // FR-95/SEC-38

/** FR-93: requested TTL clamped into (0, 240] minutes. */
export function effectiveTtlMinutes(requested: number | undefined): number {
  if (requested === undefined) return ANNOUNCEMENT_MAX_TTL_MINUTES;
  return Math.min(Math.max(Math.floor(requested), 1), ANNOUNCEMENT_MAX_TTL_MINUTES);
}

/**
 * FR-93 trust floor: the publisher must be a declared, unblocked account at
 * least ANNOUNCEMENT_MIN_ACCOUNT_AGE_H hours old. Announcements are a
 * broadcast surface — brand-new accounts never get it.
 */
export function isTrustedPublisher(
  account: {
    createdAt: Date;
    ageDeclaredAt: Date | null;
    ageBlocked: boolean;
    deletedAt: Date | null;
  },
  now = new Date(),
): boolean {
  if (account.ageBlocked || account.deletedAt || !account.ageDeclaredAt) return false;
  return now.getTime() - account.createdAt.getTime() >= ANNOUNCEMENT_MIN_ACCOUNT_AGE_H * 3_600_000;
}

/** FR-97: the work category is reserved for verified organisations (BR-33). */
export function canPublishCategory(category: string, verifiedOrg: boolean): boolean {
  if (!(ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(category)) return false;
  if (category === "work" && !verifiedOrg) return false;
  return true;
}

/**
 * FR-94/SEC-38: what a response looks like leaving the server. The responder
 * id is present only after the publisher accepted — before that the row is
 * body + timestamps, nothing else.
 */
export function publicResponse(row: {
  responseId: string;
  body: string;
  createdAt: unknown;
  acceptedAt: unknown;
  responder: string;
}): {
  responseId: string;
  body: string;
  createdAt: unknown;
  accepted: boolean;
  responder: string | null;
} {
  return {
    responseId: row.responseId,
    body: row.body,
    createdAt: row.createdAt,
    accepted: row.acceptedAt != null,
    responder: row.acceptedAt != null ? row.responder : null,
  };
}
