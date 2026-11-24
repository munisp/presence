/**
 * FR-58: per-category notification switches. Every category defaults on;
 * the safety category is exempt — safety notices cannot be switched off,
 * and an attempt to disable them is rejected, not silently ignored.
 *
 * FR-57: the stored jsonb may also carry a `quiet` window ({start,end}
 * "HH:MM" UTC) during which non-safety realtime notifications — nudges in
 * particular — are suppressed. Equal start/end disables the window.
 *
 * Delivery: every realtime notification to a user channel goes through
 * notifyUser(), which gates on shouldNotify() — safety always passes,
 * anything else respects the category switch and the quiet window.
 */

import { EdgeContext, publishRealtime } from "./context.js";

export const NOTIFICATION_CATEGORIES = [
  "matches",
  "messages",
  "announcements",
  "offers",
  "nudges",
  "safety",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** FR-58: safety notices are exempt from user switches. */
export const SAFETY_CATEGORY: NotificationCategory = "safety";

/** Stored jsonb merged over the default-on state. */
export function mergePrefs(stored: unknown): Record<NotificationCategory, boolean> {
  const bag = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const out = {} as Record<NotificationCategory, boolean>;
  for (const c of NOTIFICATION_CATEGORIES) {
    out[c] = typeof bag[c] === "boolean" ? (bag[c] as boolean) : true;
  }
  out[SAFETY_CATEGORY] = true; // always on, whatever was stored
  return out;
}

export type PrefsPatchResult =
  | { ok: true; prefs: StoredPrefs }
  | { ok: false; error: string };

/** FR-57: quiet window — {start,end} "HH:MM" UTC. Equal start/end disables it. */
export interface QuietWindow {
  start: string;
  end: string;
}

/** What actually lands in users.notification_prefs: categories plus optional quiet. */
export type StoredPrefs = Record<NotificationCategory, boolean> & { quiet?: QuietWindow };

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Parse a patch-side quiet value: object → window, null/undefined → clear, else invalid. */
export function parseQuietWindow(value: unknown): QuietWindow | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const v = value as Record<string, unknown>;
  if (typeof v.start !== "string" || typeof v.end !== "string") return "invalid";
  if (!HH_MM.test(v.start) || !HH_MM.test(v.end)) return "invalid";
  return { start: v.start, end: v.end };
}

/** Extract the stored quiet window (jsonb key `quiet`), if any. */
export function getQuietWindow(stored: unknown): QuietWindow | null {
  const bag = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const parsed = parseQuietWindow(bag.quiet);
  return parsed === "invalid" || parsed === null ? null : parsed;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * FR-57: is `now` inside the quiet window? Windows are UTC and may wrap
 * midnight (22:00–07:00). Equal start/end means the window is disabled.
 */
export function inQuietWindow(window: QuietWindow | null, now: Date): boolean {
  if (!window || window.start === window.end) return false;
  const t = now.getUTCHours() * 60 + now.getUTCMinutes();
  const s = toMinutes(window.start);
  const e = toMinutes(window.end);
  if (s < e) return t >= s && t < e;
  return t >= s || t < e;
}

/**
 * Apply a partial patch to the stored prefs. Unknown categories and a
 * safety:false attempt are rejected with a 422-level explanation. The FR-57
 * `quiet` key accepts {start,end} "HH:MM" UTC or null to clear.
 */
export function applyPrefsPatch(stored: unknown, patch: unknown): PrefsPatchResult {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "prefs must be an object keyed by category" };
  }
  const merged = mergePrefs(stored) as StoredPrefs;
  const existingQuiet = getQuietWindow(stored);
  if (existingQuiet) merged.quiet = existingQuiet;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key === "quiet") {
      const parsed = parseQuietWindow(value);
      if (parsed === "invalid") {
        return { ok: false, error: "quiet must be {start,end} HH:MM UTC or null" };
      }
      if (parsed === null) {
        delete merged.quiet;
      } else {
        merged.quiet = parsed;
      }
      continue;
    }
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown notification category: ${key}` };
    }
    if (typeof value !== "boolean") {
      return { ok: false, error: `pref ${key} must be a boolean` };
    }
    if (key === SAFETY_CATEGORY && value === false) {
      // FR-58: safety notices are exempt — they cannot be switched off.
      return { ok: false, error: "safety notices cannot be switched off (FR-58)" };
    }
    merged[key as NotificationCategory] = value;
  }
  merged[SAFETY_CATEGORY] = true;
  return { ok: true, prefs: merged };
}

/**
 * FR-58: the delivery-side half of the contract. Whether a realtime
 * notification may leave the server for a given stored prefs blob:
 *   - safety notices always pass — the user's own-account safety notices are
 *     exempt from both the switch and the quiet window;
 *   - any other category is suppressed when its switch is off, or when the
 *     FR-57 quiet window covers `now`.
 */
export function shouldNotify(
  stored: unknown,
  category: NotificationCategory,
  now: Date = new Date(),
): boolean {
  if (category === SAFETY_CATEGORY) return true;
  const prefs = mergePrefs(stored);
  if (prefs[category] === false) return false;
  if (inQuietWindow(getQuietWindow(stored), now)) return false;
  return true;
}

/**
 * Publish one notification event to a user's realtime channel, gated by
 * their stored preferences. Returns true when the event was published.
 * Load-cheap: one indexed row read per notification.
 */
export async function notifyUser(
  ctx: EdgeContext,
  userId: string,
  category: NotificationCategory,
  event: Record<string, unknown>,
): Promise<boolean> {
  const row = await ctx.pg.query(
    "SELECT notification_prefs FROM users WHERE user_id = $1",
    [userId],
  );
  const stored = row.rows[0]?.notification_prefs;
  if (!shouldNotify(stored, category)) return false;
  await publishRealtime(ctx, `user:${userId}`, event);
  return true;
}
