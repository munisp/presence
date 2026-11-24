/**
 * FR-51/SEC-19: cryptographic device attestation.
 *
 * Protocol (docs/security/attestation.md):
 *   1. the client fetches a single-use challenge
 *      (POST /v1/devices/attestation-challenge, 120 s TTL, minted here);
 *   2. it signs sha256(`${challenge}:${userId}`) with its platform
 *      attestation key (App Attest / Play Integrity, P-256) and enrols with
 *      { platform, publicKey, counter, signature };
 *   3. the edge verifies the signature against the presented key and calls
 *      register_verified_attestation(), which enforces the monotonic
 *      counter and the FR-07 dedupe registry atomically.
 *
 * An account with a verified key (or an approved SEC-19 fallback) appears
 * in the attested_accounts view the match service gates discovery on.
 */

import { createHash, createVerify, randomBytes } from "node:crypto";

/** SEC-19: challenge lifetime — single-use, two minutes. */
export const ATTESTATION_CHALLENGE_TTL_S = 120;

export const ATTESTATION_PLATFORMS = ["app_attest", "play_integrity"] as const;
export type AttestationPlatform = (typeof ATTESTATION_PLATFORMS)[number];

/** Valkey key for the one outstanding challenge per account. */
export function challengeKey(userId: string): string {
  return `attest:ch:${userId}`;
}

/** 256-bit single-use challenge, base64url. */
export function mintChallenge(): string {
  return randomBytes(32).toString("base64url");
}

/** The exact message the client signs. */
export function assertionMessage(challenge: string, userId: string): string {
  return `${challenge}:${userId}`;
}

/**
 * Verify the assertion: ECDSA P-256 over sha256(challenge:userId), key is a
 * base64 SPKI. Any malformed input is simply an invalid assertion — the
 * verifier never throws into the route.
 */
export function verifyAssertion(
  publicKeyB64: string,
  challenge: string,
  userId: string,
  signatureB64: string,
): boolean {
  try {
    const signature = Buffer.from(signatureB64, "base64");
    const verify = createVerify("sha256");
    verify.update(assertionMessage(challenge, userId));
    return verify.verify(
      { key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki", dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    return false;
  }
}

/** FR-07: the registry hash — SHA-256 of the verified public key. */
export function attestedKeyHash(publicKeyB64: string): string {
  return createHash("sha256").update(publicKeyB64).digest("hex");
}

export type AttestationBodyParse =
  | { ok: true; value: { platform: AttestationPlatform; publicKey: string; counter: number; signature: string } }
  | { ok: false; error: string };

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parse the optional `attestation` object on the enrolment body. Strict:
 * every field is required, the counter a non-negative safe integer.
 */
export function parseAttestationBody(value: unknown): AttestationBodyParse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "attestation must be an object" };
  }
  const v = value as Record<string, unknown>;
  if (!(ATTESTATION_PLATFORMS as readonly string[]).includes(v.platform as string)) {
    return { ok: false, error: "attestation.platform must be app_attest or play_integrity" };
  }
  if (typeof v.publicKey !== "string" || v.publicKey.length < 64 || v.publicKey.length > 512 || !B64_RE.test(v.publicKey)) {
    return { ok: false, error: "attestation.publicKey must be a base64 SPKI" };
  }
  if (typeof v.counter !== "number" || !Number.isSafeInteger(v.counter) || v.counter < 0) {
    return { ok: false, error: "attestation.counter must be a non-negative integer" };
  }
  if (typeof v.signature !== "string" || v.signature.length < 64 || v.signature.length > 512 || !B64_RE.test(v.signature)) {
    return { ok: false, error: "attestation.signature must be base64" };
  }
  return {
    ok: true,
    value: {
      platform: v.platform as AttestationPlatform,
      publicKey: v.publicKey,
      counter: v.counter,
      signature: v.signature,
    },
  };
}
