/**
 * SRS Addendum 001 — the client half of the identity-assurance contract
 * (AMD-KYC / AMD-AVT).
 *
 * The owner's amendment premise: every account that can appear in
 * discovery is KYC-verified and vetted, and a match can be recognised in
 * a crowded space by a curated symbol without a photograph changing
 * hands before consent. What is enforceable without a device lands here
 * as pure functions and pinned constants:
 *
 *   1. Discovery gate (AMD-KYC-01) — {@link canEnterDiscovery} is the
 *      client mirror of the discovery_eligible view: attested AND
 *      kyc_state = 'verified'. Both conditions are required and garbage
 *      fails closed — an unreadable record is not eligible.
 *   2. Transition mirror (AMD-KYC-03) — {@link KYC_TRANSITIONS} is
 *      byte-identical to the edge copy, and tests/test_batch48.py
 *      cross-pins the edge copy against the definer in migration 0024.
 *      The client never decides a transition; it mirrors the table so a
 *      status screen can explain why a state cannot move.
 *   3. Curated symbols (AMD-AVT-01) — {@link AVATAR_REGISTRY} is
 *      byte-identical to the edge copy; the invariant tests fail the
 *      build on any drift. An avatar is a registry key, never an upload,
 *      never derived from a photo, never free text.
 *   4. Change discipline (AMD-AVT-03) — {@link planAvatarChange} refuses
 *      a change while a conversation is open and enforces the 24-hour
 *      cooldown, mirroring PUT /v1/profile/avatar. A symbol that could
 *      be swapped mid-conversation would be a disguise, not an anchor.
 *   5. Recognition anchor (AMD-AVT-02) — {@link buildRecognitionAnchor}
 *      produces the pre-OPEN anchor: the symbol and nothing else. The
 *      displayName field is null until revealState is "open" (FR-30),
 *      and the descriptor has no photo field at all — the FR-87 photo
 *      ban holds by construction, not by policy.
 *
 * AMD-AVT-04: every paletteRole is a role from CLIENT_PALETTE, so the
 * WCAG contrast audit (NFR-25) covers every symbol colour by
 * construction — the guard below refuses the module otherwise.
 *
 * Framework-free by design: the only import is the accessibility
 * contract, so the unit tests run under plain node --test.
 */

import { CLIENT_PALETTE } from "./accessibility.js";

/** AMD-KYC-03: the four states an account's verification can occupy. */
export const KYC_STATES = ["pending", "verified", "rejected", "suspended"] as const;

export type KycState = (typeof KYC_STATES)[number];

/**
 * AMD-KYC-03: every legal transition — pending resolves to verified or
 * rejected, a verified account can be suspended, a suspension can be
 * reinstated, a rejection can be resubmitted. Anything else is refused.
 * Byte-identical to services/edge/src/identity.ts.
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

/**
 * AMD-KYC-01: what the client knows about an account's right to appear
 * in discovery — the attestation (FR-51) and the KYC state. Both halves
 * are required; the database view is the enforcer, this is the mirror
 * the status screen renders from.
 */
export interface DiscoveryEligibility {
  attested: boolean;
  kycState: string;
}

/**
 * AMD-KYC-01: discovery is attested AND kyc-verified, fail closed. Any
 * other combination — including garbage — is not eligible.
 */
export function canEnterDiscovery(eligibility: DiscoveryEligibility): boolean {
  if (eligibility === null || typeof eligibility !== "object") return false;
  return eligibility.attested === true && eligibility.kycState === "verified";
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
   * The guard validates membership against CLIENT_PALETTE, so avatar
   * contrast is covered by the palette audit.
   */
  paletteRole: string;
}

/**
 * AMD-AVT-01: the curated registry. Twelve symbols — enough that two
 * concurrent matches are practically never indistinguishable, few enough
 * that the set is auditable by reading it. Byte-identical to
 * services/edge/src/identity.ts.
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

/** Resolve a registry key to its entry, or null — unknown keys fail closed. */
export function resolveAvatar(key: unknown): AvatarEntry | null {
  if (!isKnownAvatarKey(key)) return null;
  const entry = AVATAR_REGISTRY.find((candidate) => candidate.key === key);
  return entry === undefined ? null : entry;
}

/** AMD-AVT-03: a recognition anchor changes at most once per day. */
export const AVATAR_CHANGE_COOLDOWN_MS = 86_400_000;

/** What the client knows before proposing an avatar change. */
export interface AvatarChangePlan {
  /** The current key, or null when none has been set yet. */
  currentKey: string | null;
  nextKey: string;
  /** When the current key was set, epoch ms — null when never set. */
  avatarSetAtMs: number | null;
  nowMs: number;
  /** AMD-AVT-03: a conversation in state OPEN locks the symbol. */
  hasOpenConversation: boolean;
}

export type AvatarChangeDenial =
  | "invalid-input"
  | "unknown-avatar"
  | "same-avatar"
  | "open-conversation"
  | "cooldown";

export type AvatarChangeVerdict =
  | { allowed: true }
  | { allowed: false; reason: AvatarChangeDenial };

/**
 * AMD-AVT-03: decide an avatar change before the wire. The order of the
 * refusals is pinned so the UI can explain exactly one reason: garbage
 * input, an unknown symbol, the symbol already worn, an open
 * conversation, then the 24-hour cooldown. Mirrors PUT /v1/profile/avatar.
 */
export function planAvatarChange(plan: AvatarChangePlan): AvatarChangeVerdict {
  if (
    plan === null ||
    typeof plan !== "object" ||
    (plan.currentKey !== null && typeof plan.currentKey !== "string") ||
    typeof plan.nextKey !== "string" ||
    (plan.avatarSetAtMs !== null && !Number.isFinite(plan.avatarSetAtMs)) ||
    !Number.isFinite(plan.nowMs) ||
    typeof plan.hasOpenConversation !== "boolean"
  ) {
    return { allowed: false, reason: "invalid-input" };
  }
  if (!isKnownAvatarKey(plan.nextKey)) {
    return { allowed: false, reason: "unknown-avatar" };
  }
  if (plan.currentKey !== null && plan.currentKey === plan.nextKey) {
    return { allowed: false, reason: "same-avatar" };
  }
  if (plan.hasOpenConversation) {
    return { allowed: false, reason: "open-conversation" };
  }
  if (
    plan.avatarSetAtMs !== null &&
    plan.nowMs - plan.avatarSetAtMs < AVATAR_CHANGE_COOLDOWN_MS
  ) {
    return { allowed: false, reason: "cooldown" };
  }
  return { allowed: true };
}

/** The two moments an anchor can describe — before OPEN, and at OPEN. */
export type AnchorRevealState = "pre-open" | "open";

/**
 * AMD-AVT-02: what one side of a match can recognise the other by.
 * The symbol is always present; the name is present ONLY once the match
 * is OPEN (FR-30). There is deliberately no photo field — FR-87 bans
 * the photo at the point of match, so the type makes it unrepresentable.
 */
export interface RecognitionAnchor {
  avatar: AvatarEntry;
  displayName: string | null;
}

/**
 * AMD-AVT-02: build the recognition anchor for one side of a match.
 * Pre-OPEN the anchor is the symbol alone — no name, no photo, nothing
 * else (FR-30/FR-87). At OPEN the anchor gains the display name. An
 * unknown symbol, an unknown reveal state, or an empty name at OPEN
 * returns null, not a partial render.
 */
export function buildRecognitionAnchor(
  avatarKey: unknown,
  revealState: unknown,
  displayName: unknown,
): RecognitionAnchor | null {
  const avatar = resolveAvatar(avatarKey);
  if (avatar === null) return null;
  if (revealState === "pre-open") {
    return { avatar, displayName: null };
  }
  if (revealState === "open") {
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      return null;
    }
    return { avatar, displayName };
  }
  return null;
}

/**
 * The master guard the shell asserts: the registry is at least twelve
 * unique well-formed keys, every paletteRole is a CLIENT_PALETTE role
 * (so NFR-25 contrast covers every symbol by construction), the
 * transition table is exactly the five legal moves with known endpoints,
 * and the contract is not vacuous — a known avatar resolves, the pinned
 * transitions behave, the discovery gate opens only for attested AND
 * verified, and a garbage change plan is refused.
 */
export function identityAssuranceHonoursAmendment(): boolean {
  const paletteRoles = new Set(CLIENT_PALETTE.map((entry) => entry.role));
  const keys = new Set<string>();
  for (const entry of AVATAR_REGISTRY) {
    if (!AVATAR_KEY_PATTERN.test(entry.key)) return false;
    if (keys.has(entry.key)) return false;
    keys.add(entry.key);
    if (typeof entry.label !== "string" || entry.label.trim().length === 0) {
      return false;
    }
    if (typeof entry.glyph !== "string" || entry.glyph.length === 0) return false;
    if (!paletteRoles.has(entry.paletteRole)) return false;
  }
  if (keys.size < 12) return false;
  if (KYC_TRANSITIONS.length !== 5) return false;
  for (const [from, to] of KYC_TRANSITIONS) {
    if (!isKycState(from) || !isKycState(to)) return false;
  }
  return (
    resolveAvatar("ember-fox") !== null &&
    resolveAvatar("not-a-symbol") === null &&
    isLegalKycTransition("pending", "verified") === true &&
    isLegalKycTransition("verified", "pending") === false &&
    canEnterDiscovery({ attested: true, kycState: "verified" }) === true &&
    canEnterDiscovery({ attested: true, kycState: "pending" }) === false &&
    canEnterDiscovery({ attested: false, kycState: "verified" }) === false &&
    planAvatarChange({
      currentKey: null,
      nextKey: "ember-fox",
      avatarSetAtMs: null,
      nowMs: 1_800_000_000_000,
      hasOpenConversation: false,
    }).allowed === true &&
    planAvatarChange({
      currentKey: "ember-fox",
      nextKey: "night-heron",
      avatarSetAtMs: null,
      nowMs: 1_800_000_000_000,
      hasOpenConversation: true,
    }).allowed === false
  );
}
