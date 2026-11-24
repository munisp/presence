/**
 * TR-32: clean degradation on denied permissions — no dead ends.
 *
 * The three device capabilities the app would LIKE are Bluetooth (BLE
 * attestation, TR-31), location (GPS cell presence, TR-29) and push
 * (FR-56 notifications). None of them may become a hard gate: a user who
 * denies any — or all — must still complete the core journey.
 *
 * The escape hatches are architectural, not cosmetic:
 *  - presence falls back to manual check-in (FR-99/FR-100 check-in
 *    tokens), which needs no OS permission at all;
 *  - notifications fall back to the in-app realtime channel (Centrifugo,
 *    TECH-06), which is already the primary transport while the app is
 *    open;
 *  - consent and chat are server-driven (FR-29 lifecycle), so they never
 *    depend on a device permission in the first place.
 *
 * This module is the framework-free planner: it maps a permission matrix
 * to the capability profile the surfaces render, and {@link assertNoDeadEnds}
 * proves — at runtime, under test — that every core journey step keeps at
 * least one satisfier. A future change that introduces a dead end fails
 * here, not in an app-store review.
 */

export type PermissionName = "bluetooth" | "location" | "push";
export type PermissionState = "granted" | "denied";
export type PermissionMatrix = Readonly<Record<PermissionName, PermissionState>>;

export type PresenceMode = "gps-cell" | "ble-attestation" | "manual-checkin";
export type NotificationChannel = "push" | "in-app";

/** The core journey the SRS protects: check-in → discover → connect → chat. */
export const CORE_JOURNEY = ["check-in", "discover", "connect", "chat"] as const;
export type JourneyStep = (typeof CORE_JOURNEY)[number];

export interface Degradation {
  readonly capability: PermissionName;
  readonly impact: string;
  readonly recovery: string;
}

export interface CapabilityProfile {
  /** Presence publish modes currently usable — never empty (check-in floor). */
  readonly presenceModes: readonly PresenceMode[];
  /** How notifications reach the user — never absent (in-app floor). */
  readonly notificationChannel: NotificationChannel;
  readonly degraded: boolean;
  /** User-facing explanation + recovery for each denied capability. */
  readonly degradations: readonly Degradation[];
  /** Per journey step, the satisfiers that keep it reachable. */
  readonly journey: Readonly<Record<JourneyStep, readonly string[]>>;
}

const DEGRADATIONS: Readonly<Record<PermissionName, Degradation>> = {
  location: {
    capability: "location",
    impact: "GPS cell presence is unavailable",
    recovery: "Enable Location in system settings, or check in with a venue code",
  },
  bluetooth: {
    capability: "bluetooth",
    impact: "BLE proximity attestation is off",
    recovery: "Enable Bluetooth in system settings — presence continues without it",
  },
  push: {
    capability: "push",
    impact: "Notifications arrive in-app only",
    recovery: "Enable notifications in system settings for alerts when the app is closed",
  },
};

/**
 * Map a permission matrix to the capability profile. Denials degrade the
 * experience; they never end the journey — manual check-in and in-app
 * realtime are unconditional.
 */
export function resolveCapabilities(matrix: PermissionMatrix): CapabilityProfile {
  const presenceModes: PresenceMode[] = [];
  if (matrix.location === "granted") presenceModes.push("gps-cell");
  if (matrix.bluetooth === "granted") presenceModes.push("ble-attestation");
  // FR-99/FR-100: check-in tokens need no OS permission — this is the
  // floor that makes "no dead ends" a construction, not a hope.
  presenceModes.push("manual-checkin");

  const notificationChannel: NotificationChannel = matrix.push === "granted" ? "push" : "in-app";

  const degradations = (Object.keys(DEGRADATIONS) as PermissionName[])
    .filter((name) => matrix[name] === "denied")
    .map((name) => DEGRADATIONS[name]);

  // Every step's satisfiers: check-in and discovery run off any presence
  // mode; consent is the server-side lifecycle (FR-29); chat rides the
  // notification channel, which always has the in-app floor.
  const journey: Record<JourneyStep, readonly string[]> = {
    "check-in": presenceModes,
    discover: presenceModes,
    connect: ["server-consent"],
    chat: [notificationChannel],
  };

  return {
    presenceModes,
    notificationChannel,
    degraded: degradations.length > 0,
    degradations,
    journey,
  };
}

/**
 * The TR-32 contract as an executable check: every core journey step has
 * at least one satisfier, and at least one presence mode exists. Returns
 * true when the profile is dead-end-free. The unit tests run this over
 * every permission combination.
 */
export function assertNoDeadEnds(profile: CapabilityProfile): boolean {
  if (profile.presenceModes.length === 0) return false;
  return CORE_JOURNEY.every((step) => profile.journey[step].length > 0);
}
