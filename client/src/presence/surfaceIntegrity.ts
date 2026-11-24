/**
 * FR-87 + FR-77: the surface-prohibition registry.
 *
 * FR-87 bans engagement mechanics outright: infinite or auto-loading
 * scroll on any surface, typing indicators, read receipts, streaks,
 * daily-login rewards, like or view counts, and a photo shown at the
 * point of match. FR-77 bans proximity displays: no map, directional
 * indicator, distance value, radius, heat-map, or any arrangement of
 * users by proximity.
 *
 * Server-side these patterns are structural (no endpoint serves the
 * data); this module is the client half of the contract — ONE registry
 * every surface descriptor is checked against, so a surface cannot
 * accidentally grow a banned affordance. The discovery-surface modules
 * (matchSurface, presenceHalo, offerWindow, discoverySkeleton) run their
 * descriptors through {@link descriptorViolations}; the conversation
 * surfaces land in a later batch and inherit the same registry, which is
 * where the typing-indicator / read-receipt bans bind.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

/** FR-87: engagement mechanics that MUST NOT exist on any surface. */
export const PROHIBITED_ENGAGEMENT_PATTERNS = [
  "infinite-scroll",
  "auto-loading-scroll",
  "typing-indicator",
  "read-receipt",
  "streak",
  "daily-login-reward",
  "like-count",
  "view-count",
  "photo-at-match",
] as const;

export type ProhibitedEngagementPattern =
  (typeof PROHIBITED_ENGAGEMENT_PATTERNS)[number];

/** FR-77: proximity displays that MUST NOT exist on any surface. */
export const PROHIBITED_PROXIMITY_ELEMENTS = [
  "map",
  "direction-indicator",
  "distance-value",
  "radius",
  "heat-map",
  "proximity-arrangement",
] as const;

export type ProhibitedProximityElement =
  (typeof PROHIBITED_PROXIMITY_ELEMENTS)[number];

/**
 * A declarative surface descriptor: everything the native layer needs to
 * render one surface, and nothing else. Surfaces are described — never
 * handed live data channels — so what a surface can show is auditable
 * against the registries above before a single pixel exists.
 */
export interface SurfaceDescriptor {
  /** Surface kind, e.g. "match", "presence-halo", "offer-window". */
  kind: string;
  /** Interaction affordances the surface exposes. */
  affordances: readonly string[];
  /** Named fields the surface renders. */
  fields: Record<string, unknown>;
}

const PROHIBITED: readonly string[] = [
  ...PROHIBITED_ENGAGEMENT_PATTERNS,
  ...PROHIBITED_PROXIMITY_ELEMENTS,
];

/**
 * Audit one descriptor against both registries. A violation is any
 * affordance or field key on a prohibited list; the returned strings
 * name the offending entries. An empty result means the surface is
 * renderable under FR-77 and FR-87.
 */
export function descriptorViolations(
  descriptor: SurfaceDescriptor,
): string[] {
  const violations: string[] = [];
  for (const affordance of descriptor.affordances) {
    if (PROHIBITED.includes(affordance)) violations.push(affordance);
  }
  for (const key of Object.keys(descriptor.fields)) {
    if (PROHIBITED.includes(key)) violations.push(key);
  }
  return violations;
}

/**
 * The guard a surface asserts before rendering: no FR-87 engagement
 * mechanic and no FR-77 proximity element anywhere in its descriptor.
 */
export function honoursSurfaceProhibitions(
  descriptor: SurfaceDescriptor,
): boolean {
  return descriptorViolations(descriptor).length === 0;
}
