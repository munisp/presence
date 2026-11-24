/**
 * TR-31: BLE attestation codes — rotating, derived, never stable.
 *
 * When BLE attestation is enabled the phone advertises a code DERIVED
 * from the FR-16 presence session id — never the session id itself,
 * never the device id, never the account id. The code rotates on a fixed
 * window of {@link BLE_ROTATION_PERIOD_S} seconds (the SRS caps the
 * rotation period at 15 minutes; we run exactly at the cap), so a
 * captured advertisement has a bounded lifetime and cannot be tracked
 * across windows.
 *
 * Derivation: code = HMAC-SHA256(key = session id bytes,
 * msg = "presence-ble-v1" || windowIndex) truncated to 128 bits, hex
 * rendered. Both sides of a proximity exchange hold the same session
 * context, so a receiver re-derives and compares — no code table, no
 * server round trip. Advertising always uses the CURRENT window;
 * verification tolerates one lookback window to absorb clock skew at a
 * boundary, and never more.
 *
 * Framework-free by design: pure TypeScript over the in-repo SHA-256
 * (src/presence/sha256.ts — Hermes has no crypto), so the unit tests run
 * under plain node --test and the SEC-18 dependency surface stays flat.
 */

import { fromHex, hmacSha256, toHex, utf8 } from "./sha256.js";

/** TR-31: rotation period — the SRS maximum is 15 minutes. */
export const BLE_ROTATION_PERIOD_S = 900;

/** 128-bit codes: long enough to be unguessable, short enough to advertise. */
export const BLE_CODE_BYTES = 16;

/** Domain separator — BLE codes can never collide with another use. */
const CODE_INFO = "presence-ble-v1";

/** The only shape that may be advertised: a derived code, nothing else. */
export interface BleAdvertisement {
  readonly code: string;
}

/** Fields that must never appear in an advertisement (stable identifiers). */
const FORBIDDEN_IDENTIFIER_KEYS = ["sessionId", "deviceId", "userId", "accountId"] as const;

/** Which rotation window a timestamp falls in. */
export function bleWindowIndex(atS: number): number {
  return Math.floor(atS / BLE_ROTATION_PERIOD_S);
}

/** Seconds until the current code stops being advertised. */
export function secondsUntilRotation(atS: number): number {
  const into = atS % BLE_ROTATION_PERIOD_S;
  return into === 0 ? BLE_ROTATION_PERIOD_S : BLE_ROTATION_PERIOD_S - into;
}

/** Absolute timestamp of the next rotation boundary. */
export function nextRotationAtS(atS: number): number {
  return (bleWindowIndex(atS) + 1) * BLE_ROTATION_PERIOD_S;
}

/** The SRS cap, pinned: no longer than 15 minutes. */
export function rotationPeriodWithinLimit(periodS: number = BLE_ROTATION_PERIOD_S): boolean {
  return periodS > 0 && periodS <= 15 * 60;
}

function deriveForWindow(sessionId: string, windowIndex: number): string {
  const key = fromHex(sessionId);
  const msg = new Uint8Array(CODE_INFO.length + 8);
  msg.set(utf8(CODE_INFO));
  const dv = new DataView(msg.buffer);
  dv.setUint32(CODE_INFO.length, Math.floor(windowIndex / 0x100000000));
  dv.setUint32(CODE_INFO.length + 4, windowIndex >>> 0);
  return toHex(hmacSha256(key, msg).subarray(0, BLE_CODE_BYTES));
}

/**
 * Derive the rotating code for a presence session at a point in time.
 * The session id never leaves this function — only the derived code is
 * returned.
 */
export function deriveBleCode(sessionId: string, atS: number): string {
  return deriveForWindow(sessionId, bleWindowIndex(atS));
}

/**
 * Build the advertisement for broadcast. Carries exactly one field — the
 * derived code for the current window. Rotate by calling again after
 * {@link nextRotationAtS}.
 */
export function toAdvertisement(sessionId: string, atS: number): BleAdvertisement {
  return { code: deriveBleCode(sessionId, atS) };
}

/** Length-aware constant-time comparison for 32-char hex codes. */
function codesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Receiver side: does an observed code belong to this session around now?
 * Accepts the current window and at most {@link maxLookbackWindows} back
 * (boundary clock skew); anything older is rejected. Lookback beyond one
 * window would stretch a code's effective lifetime past the SRS intent.
 */
export function verifyBleCode(
  sessionId: string,
  code: string,
  atS: number,
  maxLookbackWindows = 1,
): boolean {
  if (!/^[0-9a-f]{32}$/.test(code)) return false;
  const current = bleWindowIndex(atS);
  for (let back = 0; back <= maxLookbackWindows; back++) {
    if (codesEqual(code, deriveForWindow(sessionId, current - back))) return true;
  }
  return false;
}

/**
 * Compile-time intent made runtime-explicit: the advertisement carries
 * only the derived code — no stable identifier, ever. Pinned by the unit
 * tests so a future field addition fails here, not in review.
 */
export function advertisementDiscardsIdentifiers(ad: BleAdvertisement): boolean {
  const keys = Object.keys(ad);
  return (
    keys.length === 1 &&
    keys[0] === "code" &&
    /^[0-9a-f]{32}$/.test(ad.code) &&
    FORBIDDEN_IDENTIFIER_KEYS.every((k) => !(k in ad))
  );
}
