/**
 * SRS Addendum 001 — identity assurance validators (AMD-KYC / AMD-AVT).
 * Pure functions, unit-tested; the routes in routes/identity.ts do the I/O.
 *
 *   AMD-KYC-03 — KYC_TRANSITIONS is the legal-transition table the
 *     record_kyc_decision definer enforces in the database; this mirror
 *     lets the route refuse garbage before touching the wire. Both must
 *     agree — tests/test_batch48.py cross-pins them.
 *   AMD-AVT-01 — AVATAR_REGISTRY is the curated symbol set. An avatar is
 *     never user-uploaded, never derived from a photo, never free text.
 *     The client mirrors this registry byte-for-byte; the invariant tests
 *     fail the build on any drift between the two copies.
 *   AMD-AVT-03 — AVATAR_CHANGE_COOLDOWN_MS and the open-conversation lock
 *     are enforced by the route; the constants live here so the client
 *     contract can cross-check them.
 */

/** AMD-KYC-03: the four states an account's verification can occupy. */
export const KYC_STATES = ["pending", "verified", "rejected", "suspended"] as const;

export type KycState = (typeof KYC_STATES)[number];

/**
 * AMD-KYC-03: every legal transition — pending resolves to verified or
 * rejected, a verified account can be suspended, a suspension can be
 * reinstated, a rejection can be resubmitted. Anything else is refused.
 */
export const KYC_TRANSITIONS: ReadonlyArray<readonly [KycState, KycState]> = [
  ["pending", "verified"],
  ["pending", "rejected"],
  ["verified", "suspended"],
  ["suspended", "verified"],
  ["rejected", "pending"],
];

export function isKycState(raw: unknown): raw is KycState {
  return typeof raw === "string" && (KYC_STATES as readonly string[]).includes(raw);
}

/** Legal per AMD-KYC-03; unknown states or illegal pairs fail closed. */
export function isLegalKycTransition(from: unknown, to: unknown): boolean {
  if (!isKycState(from) || !isKycState(to)) return false;
  return KYC_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** AMD-AVT-01: the column shape — mirrored in migration 0024. */
export const AVATAR_KEY_PATTERN = /^[a-z][a-z0-9-]{2,39}$/;

export interface AvatarEntry {
  /** Registry key — the only thing stored or transmitted. */
  key: string;
  /** Pinned display label. */
  label: string;
  /** Abstract glyph — a shape, never a face, never a photo. */
  glyph: string;
  /**
   * AMD-AVT-04: a role from the WCAG-audited client palette (NFR-25).
   * The client validates membership against CLIENT_PALETTE at guard
   * time, so avatar contrast is covered by the palette audit.
   */
  paletteRole: string;
}

/**
 * AMD-AVT-01: the curated registry. Twelve symbols — enough that two
 * concurrent matches are practically never indistinguishable, few enough
 * that the set is auditable by reading it. Mirrored byte-for-byte in
 * client/src/presence/identityAssurance.ts.
 */
export const AVATAR_REGISTRY: readonly AvatarEntry[] = [
  { key: "ember-fox", label: "Ember Fox", glyph: "◆", paletteRole: "title" },
  { key: "night-heron", label: "Night Heron", glyph: "▲", paletteRole: "subtitle" },
  { key: "brass-antelope", label: "Brass Antelope", glyph: "●", paletteRole: "note" },
  { key: "cedar-crane", label: "Cedar Crane", glyph: "■", paletteRole: "title" },
  { key: "harbour-seal", label: "Harbour Seal", glyph: "✦", paletteRole: "subtitle" },
  { key: "juniper-hare", label: "Juniper Hare", glyph: "✚", paletteRole: "note" },
  { key: "saffron-ibis", label: "Saffron Ibis", glyph: "◈", paletteRole: "title" },
  { key: "tidal-otter", label: "Tidal Otter", glyph: "⬢", paletteRole: "subtitle" },
  { key: "copper-falcon", label: "Copper Falcon", glyph: "⬟", paletteRole: "note" },
  { key: "moss-badger", label: "Moss Badger", glyph: "✺", paletteRole: "title" },
  { key: "dusk-lynx", label: "Dusk Lynx", glyph: "❖", paletteRole: "subtitle" },
  { key: "aurora-wolf", label: "Aurora Wolf", glyph: "◉", paletteRole: "note" },
];

export function isKnownAvatarKey(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    AVATAR_KEY_PATTERN.test(raw) &&
    AVATAR_REGISTRY.some((entry) => entry.key === raw)
  );
}

/** AMD-AVT-03: a recognition anchor changes at most once per day. */
export const AVATAR_CHANGE_COOLDOWN_MS = 86_400_000;

/** TR-23: strict body — {avatarKey} only, unknown fields refuse. */
export function parseAvatarChoice(raw: unknown): { avatarKey: string } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "avatarKey") return null;
  const { avatarKey } = raw as { avatarKey: unknown };
  if (!isKnownAvatarKey(avatarKey)) return null;
  return { avatarKey };
}

/** AMD-KYC-03: strict body for a review decision — {decision} only. */
export function parseKycDecision(raw: unknown): { decision: KycState } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "decision") return null;
  const { decision } = raw as { decision: unknown };
  if (!isKycState(decision)) return null;
  return { decision };
}
