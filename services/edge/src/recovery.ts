/**
 * SEC-09: account recovery phone — keyed-hash storage helpers.
 *
 * The recovery flow only ever needs an equality check ("is the number the
 * user just typed the one on file?"), so the database stores
 * HMAC-SHA256(key, e164) and nothing else. The plaintext digits are parsed,
 * normalised, hashed and discarded inside the request handler — they are
 * never logged, never persisted, and never returned.
 *
 * Why keyed: phone numbers are 10–15 digits, so an unkeyed hash column is a
 * phonebook waiting for one table dump to invert it. The HMAC key lives in
 * the edge environment (RECOVERY_HASH_KEY; presence-secrets in K8s,
 * clearly-marked dev value in compose per SEC-28) — a database leak alone
 * yields nothing enumerable.
 *
 * Normalisation to E.164 happens before hashing so formatting variants of
 * the same number collide on one hash; the UNIQUE index on phone_hash then
 * enforces one-number-one-account platform-wide.
 */

import { createHmac } from "node:crypto";

/** E.164: "+", non-zero leading digit, 7–15 digits total. */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * Normalise a user-typed number to E.164. Accepts the usual display
 * punctuation — spaces, dashes, dots, parentheses — and requires the
 * international "+" prefix (per-market SMS providers do the national
 * formatting; the account surface stores the international form only).
 * Returns null for anything that is not a plausible E.164 number.
 */
export function normalizePhone(raw: string): string | null {
  const stripped = raw.replace(/[\s().-]/g, "");
  if (!E164_PATTERN.test(stripped)) return null;
  return stripped;
}

/**
 * SEC-09: the keyed hash that is actually stored. The key comes from the
 * environment on every call so a rotation is a rolling restart, not a code
 * change; the dev fallback is a clearly-marked compose-only value (SEC-28).
 */
export function recoveryPhoneHash(e164: string, key = process.env.RECOVERY_HASH_KEY): string {
  return createHmac("sha256", key ?? "p0-dev-recovery-key-change-me").update(e164).digest("hex");
}

export type RecoveryBodyParse = { ok: true; e164: string } | { ok: false };

/**
 * Parse the PUT body. Validation and "number not available" share one
 * neutral 422 at the route — the distinction would let a caller probe
 * whether a number is registered on another account.
 */
export function parseRecoveryBody(body: unknown): RecoveryBodyParse {
  if (body === null || typeof body !== "object") return { ok: false };
  const phone = (body as Record<string, unknown>).phone;
  if (typeof phone !== "string") return { ok: false };
  const e164 = normalizePhone(phone);
  return e164 === null ? { ok: false } : { ok: true, e164 };
}
