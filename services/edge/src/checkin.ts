/**
 * Check-in tokens (PRS-SRS-001 §4.3, FR-100).
 *
 * A venue partner mints a short-lived, HMAC-SHA256-signed token per floor;
 * the venue prints it as a QR/NFC code. A user posts the token to
 * /v1/presence/checkin, the edge verifies it against the venue's secret and
 * returns the (venueId, floorId) pair the client then attributes its
 * presence to.
 *
 * Wire format:  pc1.<base64url(json claims)>.<base64url(hmac)>
 * Claims:       { vid, flr, exp, nonce }
 *
 * Verification is constant-time on the signature and strict on shape: a
 * malformed, tampered, or expired token is simply invalid — no oracle on
 * which part failed.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface CheckinClaims {
  vid: string;   // venue id
  flr: string;   // floor id
  exp: number;   // unix seconds
  nonce: string; // anti-grinding randomness
}

/** FR-100: tokens are short-lived; minting clamps the TTL to this ceiling. */
export const CHECKIN_TOKEN_TTL_MAX_S = 300;

const VERSION = "pc1";

export function newCheckinClaims(
  venueId: string,
  floorId: string,
  ttlSeconds: number,
  nowS: number = Math.floor(Date.now() / 1000),
): CheckinClaims {
  const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 1), CHECKIN_TOKEN_TTL_MAX_S);
  return {
    vid: venueId,
    flr: floorId,
    exp: nowS + ttl,
    nonce: randomBytes(12).toString("base64url"),
  };
}

export function mintCheckinToken(claims: CheckinClaims, secretHex: string): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const sig = createHmac("sha256", Buffer.from(secretHex, "hex")).update(body).digest("base64url");
  return `${VERSION}.${body}.${sig}`;
}

export function verifyCheckinToken(
  token: string,
  secretHex: string,
  nowS: number = Math.floor(Date.now() / 1000),
): CheckinClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const expected = createHmac("sha256", Buffer.from(secretHex, "hex")).update(parts[1]).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const c = claims as Record<string, unknown>;
  if (typeof c.vid !== "string" || typeof c.flr !== "string") return null;
  if (typeof c.exp !== "number" || typeof c.nonce !== "string") return null;
  if (c.exp <= nowS) return null; // expired — including zero/negative TTLs
  return { vid: c.vid, flr: c.flr, exp: c.exp, nonce: c.nonce };
}
