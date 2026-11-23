/**
 * FR-05/FR-07: device enrolment and attestation-key dedupe helpers.
 *
 * FR-05 — a user may keep at most three concurrently enrolled devices. The
 * hard cap lives in the database (device_cap trigger under a row lock), so
 * concurrent enrolments cannot race past it; this module owns the client-
 * visible constant and the enrolment payload parsing.
 *
 * FR-07 — every enrolment carries the app-attestation assertion. Its SHA-256
 * is the attestation key hash registered with register_attestation_key():
 * a hash already bound to another account is a duplicate signal, recorded
 * silently and surfaced to moderators — the enrolling client always gets the
 * same neutral success, so the check cannot be probed. P0 uses the assertion
 * hash as the key stand-in; cryptographic App Attest verification replaces
 * the hash input, not the registry flow, when that milestone lands.
 */

import { createHash } from "node:crypto";

/** FR-05: concurrent device cap — enforced by the device_cap trigger. */
export const DEVICE_LIMIT = 3;

/** FR-05: device labels stay short; they render in the enrolment e-mail. */
export const DEVICE_LABEL_MAX_LEN = 60;

/** FR-07: the attestation key hash is the SHA-256 of the assertion. */
export function attestationKeyHash(assertion: string): string {
  return createHash("sha256").update(assertion).digest("hex");
}

/**
 * FR-05: a stable fingerprint for the device row — distinct from the
 * attestation key hash so a re-enrolment of the same key on the same
 * account refreshes rather than collides with a live device row.
 */
export function deviceFingerprint(userId: string, assertion: string): string {
  return createHash("sha256").update(`${userId}:${assertion}`).digest("hex");
}

export type DeviceBodyParse =
  | { ok: true; label: string | null }
  | { ok: false; error: string };

/**
 * FR-05: parse the enrolment body. The label is optional free text, so it
 * passes the same screening as other user-authored strings (SEC-26 idiom) —
 * a device label is rendered back to the user in the enrolment notice and
 * must not carry links or contact details.
 */
export function parseDeviceBody(
  body: unknown,
  screen: (text: string) => readonly unknown[],
): DeviceBodyParse {
  if (body === null || body === undefined) return { ok: true, label: null };
  if (typeof body !== "object") return { ok: false, error: "body must be an object" };
  const label = (body as Record<string, unknown>).label;
  if (label === undefined || label === null) return { ok: true, label: null };
  if (typeof label !== "string") return { ok: false, error: "label must be a string" };
  const trimmed = label.trim();
  if (trimmed.length === 0) return { ok: true, label: null };
  if (trimmed.length > DEVICE_LABEL_MAX_LEN) {
    return { ok: false, error: `label must be 1-${DEVICE_LABEL_MAX_LEN} characters` };
  }
  if (screen(trimmed).length > 0) {
    return { ok: false, error: "label contains content the community rules prohibit" };
  }
  return { ok: true, label: trimmed };
}
