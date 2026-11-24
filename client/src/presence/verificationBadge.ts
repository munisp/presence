/**
 * FR-70: verification status is shown at the moment identity is revealed.
 *
 * The requirement: verification status MUST be displayed at the moment
 * identity is revealed — on the offer, the table roster and the booked
 * slot — and not only within account settings.
 *
 * The status itself is produced server-side: FR-51 verified attestation
 * decides whether an account is "verified", and FR-52 trust scoring keeps
 * the moderation queue honest behind it. This module is the client half
 * of the contract — the three identity-reveal surfaces are a pinned
 * registry, and every reveal descriptor must carry a verification badge
 * whose label cannot be forged:
 *
 *   1. Registry — {@link IDENTITY_REVEAL_SURFACES} is exactly the three
 *      surfaces the SRS names. {@link buildIdentityReveal} refuses to
 *      build a reveal for any other surface, so identity cannot leak
 *      onto an unaudited surface by construction.
 *   2. Badge by construction — the caller supplies the attestation
 *      STATE, never the label: {@link VERIFICATION_LABELS} is pinned
 *      here, so a surface cannot invent a friendlier status string.
 *      Account settings is deliberately absent from the registry — the
 *      badge exists at the moment of reveal, not only behind settings.
 *   3. Fail closed — an unknown surface, an empty display name, or a
 *      garbage verification state produces null, not a render.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

/** FR-70: the verification states FR-51 attestation data can produce. */
export const VERIFICATION_STATES = ["verified", "unverified"] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];

/**
 * FR-70: the pinned badge labels. The label is part of the contract —
 * a surface renders the pinned string for the state it was given and
 * can never substitute its own.
 */
export const VERIFICATION_LABELS: Record<VerificationState, string> = {
  verified: "Verified",
  unverified: "Not verified",
};

/**
 * FR-70: the surfaces where identity is revealed — exactly the three the
 * SRS names. Account settings is NOT an identity-reveal surface: the
 * requirement is that the status appears at the moment of reveal, not
 * only within settings.
 */
export const IDENTITY_REVEAL_SURFACES = [
  "offer",
  "table-roster",
  "booked-slot",
] as const;

export type IdentityRevealSurface = (typeof IDENTITY_REVEAL_SURFACES)[number];

/** One identity reveal: a name, on a surface, with its badge. */
export interface IdentityReveal {
  surface: IdentityRevealSurface;
  displayName: string;
  verification: { state: VerificationState; label: string };
}

function isRevealSurface(surface: string): surface is IdentityRevealSurface {
  return (IDENTITY_REVEAL_SURFACES as readonly string[]).includes(surface);
}

function isVerificationState(state: string): state is VerificationState {
  return (VERIFICATION_STATES as readonly string[]).includes(state);
}

/**
 * Build one identity reveal, or refuse. The verification label is taken
 * from the pinned registry — the caller supplies the state and nothing
 * else. Garbage in any position returns null.
 */
export function buildIdentityReveal(
  surface: string,
  displayName: string,
  state: string,
): IdentityReveal | null {
  if (!isRevealSurface(surface)) return null;
  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    return null;
  }
  if (!isVerificationState(state)) return null;
  return {
    surface,
    displayName,
    verification: { state, label: VERIFICATION_LABELS[state] },
  };
}

/**
 * Audit a reveal descriptor: the surface is registered, the name is
 * present, the state is known, and the label is exactly the pinned one
 * for the state — a forged label is a violation.
 */
export function identityRevealViolations(reveal: IdentityReveal): string[] {
  const violations: string[] = [];
  if (!isRevealSurface(reveal.surface)) violations.push("surface");
  if (
    typeof reveal.displayName !== "string" ||
    reveal.displayName.trim().length === 0
  ) {
    violations.push("display-name");
  }
  if (!isVerificationState(reveal.verification.state)) {
    violations.push("verification-state");
  } else if (
    reveal.verification.label !== VERIFICATION_LABELS[reveal.verification.state]
  ) {
    violations.push("verification-label");
  }
  return violations;
}

/**
 * The FR-70 guard: the registry holds exactly the three moment-of-reveal
 * surfaces the SRS names, and account settings is not among them — the
 * status lives where identity is revealed, not only behind settings.
 */
export function revealHonoursFr70(): boolean {
  return (
    IDENTITY_REVEAL_SURFACES.length === 3 &&
    isRevealSurface("offer") &&
    isRevealSurface("table-roster") &&
    isRevealSurface("booked-slot") &&
    !isRevealSurface("account-settings")
  );
}
