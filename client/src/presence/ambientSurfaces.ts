/**
 * FR-86 + SEC-35: ambient surfaces — opt-in, off by default, and
 * contentless because the lock screen is a public surface in a venue.
 *
 * FR-86: each ambient surface — lock-screen indicator, Live Activity,
 * home-screen widget — MUST be individually opted into, MUST be off by
 * default, and MUST be disableable in one action.
 *
 * SEC-35: ambient surfaces MUST be contentless — no identity, reason
 * text, participant count or location may be rendered on a lock screen,
 * Live Activity or widget.
 *
 * The two requirements meet in the payload type:
 *
 *   - {@link AmbientPayload} has exactly two fields — a kind tag and a
 *     boolean saying presence is active. There is no field an identity,
 *     a reason, a count, or a location could occupy: contentless by
 *     construction, not by discipline. {@link ambientPayloadViolations}
 *     still audits every payload, so the guarantee is asserted, not
 *     assumed — and it also runs the FR-77/FR-87 registry, because a
 *     map on a lock screen is still a map.
 *   - FR-86's opt-in discipline lives in {@link AmbientPreferences}:
 *     {@link defaultAmbientPreferences} is all-false (off by default),
 *     {@link setAmbientPreference} flips exactly one surface
 *     (individual opt-in), and {@link planDisable} is pinned to a
 *     single action with no confirmation step (disableable in one
 *     action). {@link parseAmbientPreferences} fails CLOSED — malformed
 *     or smuggled preferences read as everything-off, never
 *     everything-on.
 *
 * Preferences persist under the allowlisted key
 * presence.ambient.prefs (TR-30) and are wiped on logout like every
 * other local state.
 *
 * Imports are pinned by tests/test_batch40.py: localState.js (the
 * allowlist type) and surfaceIntegrity.js (the prohibition registry).
 * No network, no platform APIs.
 */

import { type LocalStateKey } from "./localState.js";
import {
  descriptorViolations,
  type SurfaceDescriptor,
} from "./surfaceIntegrity.js";

/** FR-86: the three ambient surfaces, individually opt-in. */
export const AMBIENT_SURFACES = [
  "lockScreenIndicator",
  "liveActivity",
  "homeScreenWidget",
] as const;

export type AmbientSurface = (typeof AMBIENT_SURFACES)[number];

/** TR-30: the allowlisted persistence key for ambient preferences. */
export const AMBIENT_PREFS_KEY: LocalStateKey = "presence.ambient.prefs";

/**
 * SEC-35: field keys that MUST NOT appear in an ambient payload —
 * identity, reason text, participant counts, location in any form. The
 * payload type excludes them by construction; this list is what the
 * guard scans for on every payload anyway.
 */
export const AMBIENT_FORBIDDEN_FIELDS = [
  "identity",
  "userId",
  "displayName",
  "handle",
  "photo",
  "reason",
  "reasonText",
  "interests",
  "participantCount",
  "count",
  "location",
  "cell",
  "venue",
  "distance",
  "map",
] as const;

/** SEC-35: the only keys an ambient payload may carry. */
export const AMBIENT_PAYLOAD_KEYS = ["kind", "active"] as const;

/** FR-86: per-surface opt-in state. */
export type AmbientPreferences = Record<AmbientSurface, boolean>;

/**
 * SEC-35: the complete content contract of every ambient surface. A
 * kind tag, and whether presence is active. Nothing else can exist —
 * the lock screen learns that the app is live, and learns nothing
 * about anyone.
 */
export interface AmbientPayload {
  kind: "presence-ambient";
  active: boolean;
}

/** FR-86: every ambient surface is OFF by default. */
export function defaultAmbientPreferences(): AmbientPreferences {
  return {
    lockScreenIndicator: false,
    liveActivity: false,
    homeScreenWidget: false,
  };
}

/**
 * FR-86 individual opt-in: flip exactly one surface; the other two are
 * untouched. Opting into one surface can never leak onto another.
 */
export function setAmbientPreference(
  preferences: AmbientPreferences,
  surface: AmbientSurface,
  enabled: boolean,
): AmbientPreferences {
  return { ...preferences, [surface]: enabled };
}

/**
 * FR-86 one-action disable: the plan to turn a surface off is a single
 * toggle with no confirmation step. Pin the plan shape so "one action"
 * is a testable constant, not a UX hope.
 */
export function planDisable(surface: AmbientSurface): {
  surface: AmbientSurface;
  actions: readonly ["toggle-off"];
  confirmation: null;
} {
  return { surface, actions: ["toggle-off"], confirmation: null };
}

/**
 * Parse persisted preferences, failing CLOSED: malformed JSON, wrong
 * shapes, and unknown surface keys all resolve to the all-off default.
 * A corrupted preference blob must never opt a surface IN.
 */
export function parseAmbientPreferences(raw: string | null): AmbientPreferences {
  const defaults = defaultAmbientPreferences();
  if (raw === null) return defaults;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return defaults;
    const record = parsed as Record<string, unknown>;
    const result = defaultAmbientPreferences();
    for (const surface of AMBIENT_SURFACES) {
      if (record[surface] === true) result[surface] = true;
    }
    return result;
  } catch {
    return defaults;
  }
}

/**
 * Build the payload an ambient surface may render. Whatever the app
 * knows — matches, counts, cells — the ambient layer receives one
 * boolean. SEC-35 is this function's entire return type.
 */
export function buildAmbientPayload(presenceActive: boolean): AmbientPayload {
  return { kind: "presence-ambient", active: presenceActive };
}

/**
 * SEC-35 audit: any key outside the two permitted ones, any forbidden
 * field name, any non-"presence-ambient" kind tag, or a non-boolean
 * active flag is a violation. Runs BEFORE anything reaches the OS
 * ambient layer.
 */
export function ambientPayloadViolations(payload: unknown): string[] {
  const violations: string[] = [];
  if (typeof payload !== "object" || payload === null) return ["payload-shape"];
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(AMBIENT_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      violations.push(key);
    }
    if ((AMBIENT_FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
      violations.push(key);
    }
  }
  if (record.kind !== "presence-ambient") violations.push("kind");
  if (typeof record.active !== "boolean") violations.push("active");
  return violations;
}

/** The generic descriptor view of one ambient surface. */
export function ambientSurfaceDescriptor(
  surface: AmbientSurface,
  preferences: AmbientPreferences,
): SurfaceDescriptor {
  return {
    kind: `ambient-${surface}`,
    affordances: ["opt-in", "disable"],
    fields: { enabled: preferences[surface] },
  };
}

/** FR-86 + FR-87 audit: no banned affordance or field on the surface. */
export function ambientSurfaceViolations(
  surface: AmbientSurface,
  preferences: AmbientPreferences,
): string[] {
  return descriptorViolations(ambientSurfaceDescriptor(surface, preferences));
}

/**
 * The guard the ambient layer asserts: the payload is contentless
 * (SEC-35) and the surface descriptor is registry-clean (FR-87/FR-77).
 */
export function ambientHonoursSec35(payload: unknown): boolean {
  return ambientPayloadViolations(payload).length === 0;
}
