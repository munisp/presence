/**
 * FR-58: per-category notification switches. Every category defaults on;
 * the safety category is exempt — safety notices cannot be switched off,
 * and an attempt to disable them is rejected, not silently ignored.
 */

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
  | { ok: true; prefs: Record<NotificationCategory, boolean> }
  | { ok: false; error: string };

/**
 * Apply a partial patch to the stored prefs. Unknown categories and a
 * safety:false attempt are rejected with a 422-level explanation.
 */
export function applyPrefsPatch(stored: unknown, patch: unknown): PrefsPatchResult {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "prefs must be an object keyed by category" };
  }
  const merged = mergePrefs(stored);
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
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
