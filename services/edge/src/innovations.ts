/**
 * Core-platform innovations (SRS Addendum 001 — AMD-INN-01..10).
 *
 * Pinned constants cross-checked against db/migrations/0030_innovations.sql
 * by tests/test_batch56.py — a change here without a matching migration
 * change fails the suite.
 *
 * AMD-INN-09 attestations are stateless HMAC tokens, wire format mirroring
 * the FR-100 check-in token:  pp1.<base64url(json claims)>.<base64url(hmac)>
 * Claims: { sub, claims, iat, exp } — sub is an HMAC pseudonym of the
 * account, so a verifier learns the claims and never the identity.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** AMD-INN-01: the one and only presence-bond amount, in minor units. */
export const BOND_AMOUNT_MINOR = 100_000;
/** AMD-INN-02: reciprocal co-attestation window, seconds. */
export const MET_WINDOW_S = 900;
/** AMD-INN-03: escrow caps — total and milestone count. */
export const ESCROW_MAX_TOTAL_MINOR = 5_000_000;
export const ESCROW_MAX_MILESTONES = 12;
/** AMD-INN-04: pinned group-stake amount and the no-show TTL. */
export const STAKE_AMOUNT_MINOR = 50_000;
export const STAKE_TTL_H = 24;
/** AMD-INN-06: single-use disclosure grant TTL and claim vocabulary. */
export const DISCLOSURE_TTL_S = 900;
export const DISCLOSURE_CLAIMS = ["over_18", "kyc_verified"] as const;
export type DisclosureClaim = (typeof DISCLOSURE_CLAIMS)[number];
/** AMD-INN-08: at most four active serendipity windows per account. */
export const SERENDIPITY_MAX_ACTIVE = 4;
/** AMD-INN-10: unanswered introductions expire after 72 h. */
export const INTRO_TTL_H = 72;
/** AMD-INN-09: attestation TTL, one hour. */
export const ATTESTATION_TTL_S = 3600;

const ATTESTATION_VERSION = "pa1";

export interface AttestationClaims {
  sub: string;      // HMAC pseudonym of the account — never the uuid
  claims: string[]; // subset of DISCLOSURE_CLAIMS
  iat: number;
  exp: number;
}

/** AMD-INN-09: pseudonymous subject — the verifier cannot reverse it. */
export function attestationSubject(userId: string, secretHex: string): string {
  return createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(`presence-attestation:${userId}`)
    .digest("hex");
}

export function mintAttestationToken(
  userId: string,
  claims: string[],
  secretHex: string,
  nowS: number = Math.floor(Date.now() / 1000),
): string {
  const payload: AttestationClaims = {
    sub: attestationSubject(userId, secretHex),
    claims: [...claims].sort(),
    iat: nowS,
    exp: nowS + ATTESTATION_TTL_S,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", Buffer.from(secretHex, "hex")).update(body).digest("base64url");
  return `${ATTESTATION_VERSION}.${body}.${sig}`;
}

/**
 * Verify an attestation. Returns the claims on success, the string 'expired'
 * for a well-formed but stale token, or null for anything malformed or
 * tampered — the route answers valid | expired | invalid and nothing else.
 */
export function verifyAttestationToken(
  token: string,
  secretHex: string,
  nowS: number = Math.floor(Date.now() / 1000),
): AttestationClaims | "expired" | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== ATTESTATION_VERSION) return null;
  const expected = createHmac("sha256", Buffer.from(secretHex, "hex")).update(parts[1]).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.sub !== "string" || !/^[0-9a-f]{64}$/.test(p.sub)) return null;
  if (!Array.isArray(p.claims) || p.claims.some((c) => typeof c !== "string")) return null;
  if (typeof p.iat !== "number" || typeof p.exp !== "number") return null;
  const claims: AttestationClaims = {
    sub: p.sub,
    claims: p.claims as string[],
    iat: p.iat,
    exp: p.exp,
  };
  if (claims.exp <= nowS) return "expired";
  return claims;
}

// ------------------------------------------------------- strict parsers ---

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

/** AMD-INN-02: {peer: uuid} only. */
export function parseMetReceiptBody(body: unknown): { peer: string } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || typeof body.peer !== "string" || !UUID_RE.test(body.peer)) return null;
  return { peer: body.peer };
}

/** AMD-INN-03: {payee: uuid, milestones: bigint[1..12]} only. */
export function parseEscrowBody(
  body: unknown,
): { payee: string; milestones: number[] } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || typeof body.payee !== "string" || !UUID_RE.test(body.payee)) {
    return null;
  }
  if (!Array.isArray(body.milestones)) return null;
  const amounts = body.milestones as unknown[];
  if (amounts.length < 1 || amounts.length > ESCROW_MAX_MILESTONES) return null;
  if (amounts.some((a) => typeof a !== "number" || !Number.isSafeInteger(a) || a <= 0)) {
    return null;
  }
  const total = (amounts as number[]).reduce((s, a) => s + a, 0);
  if (total > ESCROW_MAX_TOTAL_MINOR) return null;
  return { payee: body.payee, milestones: amounts as number[] };
}

/** AMD-INN-03: {decision: 'refund' | 'release'} only. */
export function parseEscrowResolution(body: unknown): { decision: "refund" | "release" } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || (body.decision !== "refund" && body.decision !== "release")) {
    return null;
  }
  return { decision: body.decision };
}

/** AMD-INN-01: {reportId: uuid} only. */
export function parseBondForfeitBody(body: unknown): { reportId: string } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || typeof body.reportId !== "string" || !UUID_RE.test(body.reportId)) {
    return null;
  }
  return { reportId: body.reportId };
}

/** AMD-INN-04: {stakeId: uuid, checkinToken: string} only. */
export function parseStakeRefundBody(
  body: unknown,
): { stakeId: string; checkinToken: string } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (
    keys.length !== 2 ||
    typeof body.stakeId !== "string" ||
    !UUID_RE.test(body.stakeId) ||
    typeof body.checkinToken !== "string" ||
    body.checkinToken.length < 16 ||
    body.checkinToken.length > 1024
  ) {
    return null;
  }
  return { stakeId: body.stakeId, checkinToken: body.checkinToken };
}

/** AMD-INN-06: {claim} over the pinned vocabulary. */
export function parseDisclosureIssueBody(body: unknown): { claim: DisclosureClaim } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || typeof body.claim !== "string") return null;
  if (!(DISCLOSURE_CLAIMS as readonly string[]).includes(body.claim)) return null;
  return { claim: body.claim as DisclosureClaim };
}

/** AMD-INN-06: {grantId: uuid, secret: hex} only. */
export function parseDisclosureVerifyBody(
  body: unknown,
): { grantId: string; secret: string } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (
    keys.length !== 2 ||
    typeof body.grantId !== "string" ||
    !UUID_RE.test(body.grantId) ||
    typeof body.secret !== "string" ||
    !/^[0-9a-f]{48}$/.test(body.secret)
  ) {
    return null;
  }
  return { grantId: body.grantId, secret: body.secret };
}

/** AMD-INN-08: {weekday 0-6, hourStart 0-23, hourEnd 1-24, market 1..64}. */
export function parseSerendipityWindowBody(
  body: unknown,
): { weekday: number; hourStart: number; hourEnd: number; market: string } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 4) return null;
  const { weekday, hourStart, hourEnd, market } = body;
  if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return null;
  }
  if (typeof hourStart !== "number" || !Number.isInteger(hourStart) || hourStart < 0 || hourStart > 23) {
    return null;
  }
  if (typeof hourEnd !== "number" || !Number.isInteger(hourEnd) || hourEnd < 1 || hourEnd > 24) {
    return null;
  }
  if (hourEnd <= hourStart) return null;
  if (typeof market !== "string" || market.length < 1 || market.length > 64) return null;
  return { weekday, hourStart, hourEnd, market };
}

/** AMD-INN-08: {state: 'active' | 'paused'} only. */
export function parseSerendipityStateBody(
  body: unknown,
): { state: "active" | "paused" } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || (body.state !== "active" && body.state !== "paused")) return null;
  return { state: body.state };
}

/** AMD-INN-10: {partyA: uuid, partyB: uuid} only. */
export function parseIntroductionBody(body: unknown): { partyA: string; partyB: string } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (
    keys.length !== 2 ||
    typeof body.partyA !== "string" ||
    !UUID_RE.test(body.partyA) ||
    typeof body.partyB !== "string" ||
    !UUID_RE.test(body.partyB)
  ) {
    return null;
  }
  return { partyA: body.partyA, partyB: body.partyB };
}

/** AMD-INN-10: {decision: 'accept' | 'decline'} only. */
export function parseIntroductionAnswerBody(
  body: unknown,
): { decision: "accept" | "decline" } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || (body.decision !== "accept" && body.decision !== "decline")) {
    return null;
  }
  return { decision: body.decision };
}

/** AMD-INN-09: {token: string} only. */
export function parseAttestationVerifyBody(body: unknown): { token: string } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (
    keys.length !== 1 ||
    typeof body.token !== "string" ||
    body.token.length < 16 ||
    body.token.length > 2048
  ) {
    return null;
  }
  return { token: body.token };
}
