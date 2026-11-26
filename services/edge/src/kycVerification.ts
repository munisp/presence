/**
 * OpenKYC verification contracts (SRS Addendum 001 — AMD-KYC-06..10).
 *
 * This module mirrors the pipeline constants (services/openkyc/openkyc)
 * and owns the two things the edge must do itself:
 *
 *   1. AMD-KYC-07: build the randomized liveness challenge (3 of 5
 *      actions, shuffled, per-action windows), pin its sha256 digest in
 *      kyc_sessions, and sign the single-use upload token the pipeline
 *      verifies before it decodes a frame.
 *   2. AMD-KYC-09: verify the pipeline's signed verdict callback —
 *      timestamp freshness BEFORE the signature (the AMD-PAY-22
 *      discipline), canonical field order cross-pinned with
 *      openkyc/pipeline.py (tests/test_batch63.py).
 *
 * Minimisation (AMD-KYC-02/08): the edge never sees a capture. The
 * upload goes to the OpenKYC service directly; the database holds the
 * digest, the state machine and the derived facts only.
 */

import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const CHALLENGE_ACTIONS = ["blink", "turn_left", "turn_right", "smile", "nod"] as const;
export type ChallengeAction = (typeof CHALLENGE_ACTIONS)[number];
export const CHALLENGE_COUNT = 3;
export const ACTION_WINDOW_MS = 4000;
export const SESSION_TTL_SECONDS = 600;
export const SESSION_TTL_MIN_SECONDS = 60;
export const SESSION_TTL_MAX_SECONDS = 900;

export const CREDENTIAL_KINDS = ["id_card", "driving_permit", "travel_document"] as const;
export const VERDICT_OUTCOMES = ["verified", "rejected", "review"] as const;

/** Pinned fusion thresholds — mirrored from openkyc/pipeline.py. */
export const ACCEPT_MIN = 0.8;
export const REVIEW_FLOOR = 0.5;

/** AMD-KYC-09: freshness window — the AMD-PAY-22 skew discipline. */
export const KYC_SIGNATURE_SKEW_S = 300;

export const DIGEST_RE = /^[0-9a-f]{64}$/;
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ChallengeStep {
  action: ChallengeAction;
  windowMs: number;
}

/** 3 distinct actions, shuffled; randomness injected for tests. */
export function buildChallenge(rand: (n: number) => number = randomInt): ChallengeStep[] {
  const pool: ChallengeAction[] = [...CHALLENGE_ACTIONS];
  const picked: ChallengeAction[] = [];
  for (let i = 0; i < CHALLENGE_COUNT; i += 1) {
    const at = rand(pool.length);
    const [action] = pool.splice(at, 1);
    picked.push(action);
  }
  return picked.map((action) => ({ action, windowMs: ACTION_WINDOW_MS }));
}

/**
 * Canonical wire form — byte-identical to
 * openkyc.liveness.canonical_challenge (compact JSON, keys sorted;
 * "action" sorts before "windowMs", so the literal order here is the
 * sorted order).
 */
export function canonicalChallenge(challenge: ChallengeStep[]): string {
  const steps = challenge.map(
    (s) => `{"action":${JSON.stringify(s.action)},"windowMs":${s.windowMs}}`,
  );
  return `[${steps.join(",")}]`;
}

export function challengeDigest(challenge: ChallengeStep[]): string {
  return createHash("sha256").update(canonicalChallenge(challenge), "utf8").digest("hex");
}

/**
 * The single-use upload token: HMAC over session:digest:expiry — the
 * pipeline recomputes it before decoding a frame. Cross-pinned with
 * openkyc.liveness.verify_challenge_token.
 */
export function challengeToken(
  secret: string,
  sessionId: string,
  digest: string,
  expiresAtEpoch: number,
): string {
  return createHmac("sha256", secret)
    .update(`${sessionId}:${digest}:${expiresAtEpoch}`, "utf8")
    .digest("hex");
}

export interface VerdictCallback {
  sessionId: string;
  challengeDigest: string;
  outcome: (typeof VERDICT_OUTCOMES)[number];
  credentialKind: (typeof CREDENTIAL_KINDS)[number];
  over18: boolean;
  credentialValid: boolean;
  authenticityScore: number;
  livenessScore: number;
  providerRef: string;
}

/** Fail-closed verdict parser — the nine pinned fields, nothing else. */
export function parseVerdictCallback(body: unknown): VerdictCallback | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.sessionId !== "string" || !UUID_RE.test(b.sessionId)) return null;
  if (typeof b.challengeDigest !== "string" || !DIGEST_RE.test(b.challengeDigest)) return null;
  if (typeof b.outcome !== "string" || !(VERDICT_OUTCOMES as readonly string[]).includes(b.outcome)) {
    return null;
  }
  if (
    typeof b.credentialKind !== "string" ||
    !(CREDENTIAL_KINDS as readonly string[]).includes(b.credentialKind)
  ) {
    return null;
  }
  if (typeof b.over18 !== "boolean" || typeof b.credentialValid !== "boolean") return null;
  if (
    typeof b.authenticityScore !== "number" ||
    typeof b.livenessScore !== "number" ||
    b.authenticityScore < 0 || b.authenticityScore > 1 ||
    b.livenessScore < 0 || b.livenessScore > 1
  ) {
    return null;
  }
  if (
    typeof b.providerRef !== "string" ||
    b.providerRef.length < 8 || b.providerRef.length > 128
  ) {
    return null;
  }
  return {
    sessionId: b.sessionId,
    challengeDigest: b.challengeDigest,
    outcome: b.outcome as VerdictCallback["outcome"],
    credentialKind: b.credentialKind as VerdictCallback["credentialKind"],
    over18: b.over18,
    credentialValid: b.credentialValid,
    authenticityScore: b.authenticityScore,
    livenessScore: b.livenessScore,
    providerRef: b.providerRef,
  };
}

/**
 * The canonical signed string — timestamp first, fields in the pinned
 * order (cross-pinned with openkyc.pipeline.CALLBACK_FIELD_ORDER).
 */
export function verdictSignaturePayload(at: string, verdict: VerdictCallback): string {
  return [
    at,
    verdict.sessionId,
    verdict.challengeDigest,
    verdict.outcome,
    verdict.authenticityScore.toFixed(4),
    verdict.livenessScore.toFixed(4),
    verdict.providerRef,
  ].join("|");
}

/** Constant-time signature check; a malformed header refuses. */
export function verdictSignatureValid(
  secret: string,
  payload: string,
  signature: unknown,
): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
}

/** Freshness: the stamped epoch must sit within the skew window. */
export function verdictTimestampFresh(header: unknown, nowS: number): number | null {
  const at = typeof header === "string" && /^[0-9]{9,12}$/.test(header) ? Number(header) : NaN;
  if (!Number.isInteger(at)) return null;
  if (Math.abs(nowS - at) > KYC_SIGNATURE_SKEW_S) return null;
  return at;
}
