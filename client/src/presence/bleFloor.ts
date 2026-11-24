/**
 * NFR-28: OS floors and graceful degradation below the BLE attestation
 * floor.
 *
 * The SRS: iOS 16 and Android 10 (API 29) are the supported floors;
 * below the BLE attestation floor the client degrades features
 * gracefully instead of failing.
 *
 * The OS floors are HARD and already pinned in client/app.json
 * (ios.deploymentTarget 16.0, android.minSdkVersion 29) — the stores
 * enforce them; this module pins the same numbers in code so the two
 * cannot drift apart (the CI invariant cross-checks both).
 *
 * The BLE floor is SOFT. BLE attestation (TR-31) needs two hardware
 * behaviours — advertising and scanning — and real devices lose them
 * independently: some chipsets scan but cannot advertise, some OS
 * builds restrict background advertising, and Bluetooth may simply be
 * absent. {@link resolveBlePlan} maps a capability reading to a feature
 * plan:
 *
 *   - advertise+scan → two-way attestation, the full TR-31 path;
 *   - scan-only      → witness-only: the device corroborates others'
 *      presence but cannot be witnessed; discovery continues over GPS
 *      cells and venue check-in;
 *   - none           → BLE attestation off; GPS cells and venue
 *      check-in carry presence.
 *
 * Graceful means NO DEAD ENDS: every supported plan keeps the TR-32
 * core journey satisfiable. {@link bleFloorHonoursNfr28} proves it by
 * running every OS/capability combination through the TR-32 resolver
 * and asserting the journey survives. Garbage readings fail closed to
 * the LEAST capability — the plan never claims a radio it cannot prove.
 */

import {
  assertNoDeadEnds,
  resolveCapabilities,
  type PermissionMatrix,
} from "./permissions.js";

/** NFR-28: the iOS floor (major version). Pinned in app.json too. */
export const IOS_FLOOR_MAJOR = 16;

/** NFR-28: the Android floor (API level — Android 10). Pinned in app.json too. */
export const ANDROID_FLOOR_API = 29;

export type OsName = "ios" | "android";

/** A device's OS reading: which platform and which version number. */
export interface OsReading {
  readonly os: OsName;
  /** iOS major version, or Android API level. */
  readonly version: number;
}

/** The BLE hardware/OS capability ladder, strongest first. */
export const BLE_CAPABILITIES = ["advertise+scan", "scan-only", "none"] as const;
export type BleCapability = (typeof BLE_CAPABILITIES)[number];

export type SupportTier = "full" | "degraded" | "unsupported";
export type AttestationMode = "two-way" | "witness-only" | "off";

/** Pinned user-facing explanations for each degraded tier. */
export const BLE_WITNESS_ONLY_NOTICE =
  "You can corroborate people nearby, but this device cannot broadcast — check in with a venue code to be discoverable.";
export const BLE_UNAVAILABLE_NOTICE =
  "Bluetooth presence is unavailable on this device — GPS cells and venue check-in keep working.";
export const UNSUPPORTED_OS_NOTICE =
  "This OS version is below the supported floor — update to continue using Presence.";

/** The feature plan a surface renders from one OS + capability reading. */
export interface BlePlan {
  readonly tier: SupportTier;
  readonly attestation: AttestationMode;
  /** User-facing explanation, null on the full tier. */
  readonly notice: string | null;
}

/** True when the OS reading is at or above the pinned floor. */
export function osIsSupported(reading: OsReading): boolean {
  if (!Number.isFinite(reading.version) || reading.version < 0) return false;
  if (reading.os === "ios") return reading.version >= IOS_FLOOR_MAJOR;
  if (reading.os === "android") return reading.version >= ANDROID_FLOOR_API;
  return false;
}

/**
 * Normalise a raw capability reading. Anything unrecognised — an
 * unknown string, garbage from a native probe — fails closed to the
 * least capability: the plan may under-claim a radio, never over-claim.
 */
export function normaliseCapability(raw: unknown): BleCapability {
  if (raw === "advertise+scan" || raw === "scan-only") return raw;
  return "none";
}

/**
 * Map an OS reading and a BLE capability to the feature plan. An
 * unsupported OS refuses with the pinned upgrade notice; a supported OS
 * degrades along the capability ladder, never past it.
 */
export function resolveBlePlan(
  reading: OsReading,
  rawCapability: unknown,
): BlePlan {
  if (!osIsSupported(reading)) {
    return { tier: "unsupported", attestation: "off", notice: UNSUPPORTED_OS_NOTICE };
  }
  const capability = normaliseCapability(rawCapability);
  if (capability === "advertise+scan") {
    return { tier: "full", attestation: "two-way", notice: null };
  }
  if (capability === "scan-only") {
    return { tier: "degraded", attestation: "witness-only", notice: BLE_WITNESS_ONLY_NOTICE };
  }
  return { tier: "degraded", attestation: "off", notice: BLE_UNAVAILABLE_NOTICE };
}

/**
 * The NFR-28 contract as an executable check:
 *
 *  - the floors are pinned (iOS 16, Android API 29) and boundary-exact:
 *    the floor itself is supported, one below is not;
 *  - every supported OS/capability combination produces a plan whose
 *    TR-32 journey survives — graceful degradation has no dead ends,
 *    with BLE denied the same way a permission denial degrades it;
 *  - the capability ladder is exactly the three registered levels, and
 *    garbage readings fail closed to the least of them;
 *  - the full tier carries no notice; every degraded tier carries the
 *    pinned explanation for its capability.
 */
export function bleFloorHonoursNfr28(): boolean {
  if (BLE_CAPABILITIES.length !== 3) return false;
  if (BLE_CAPABILITIES[0] !== "advertise+scan") return false;
  if (BLE_CAPABILITIES[2] !== "none") return false;

  // Boundary-exact floors.
  if (!osIsSupported({ os: "ios", version: IOS_FLOOR_MAJOR })) return false;
  if (osIsSupported({ os: "ios", version: IOS_FLOOR_MAJOR - 1 })) return false;
  if (!osIsSupported({ os: "android", version: ANDROID_FLOOR_API })) return false;
  if (osIsSupported({ os: "android", version: ANDROID_FLOOR_API - 1 })) return false;

  // Garbage readings fail closed.
  if (normaliseCapability("Advertise+Scan") !== "none") return false;
  if (normaliseCapability(undefined) !== "none") return false;
  if (normaliseCapability(42) !== "none") return false;
  if (osIsSupported({ os: "ios", version: Number.NaN })) return false;

  // Every supported combination keeps the journey alive. BLE degradation
  // is the same shape as a Bluetooth permission denial, so the TR-32
  // resolver is the arbiter: no plan may strand a journey step.
  const readings: readonly OsReading[] = [
    { os: "ios", version: IOS_FLOOR_MAJOR },
    { os: "ios", version: IOS_FLOOR_MAJOR + 2 },
    { os: "android", version: ANDROID_FLOOR_API },
    { os: "android", version: ANDROID_FLOOR_API + 5 },
  ];
  for (const reading of readings) {
    for (const capability of BLE_CAPABILITIES) {
      const plan = resolveBlePlan(reading, capability);
      if (plan.tier === "unsupported") return false;
      const matrix: PermissionMatrix = {
        bluetooth: plan.attestation === "off" ? "denied" : "granted",
        location: "denied",
        push: "denied",
      };
      if (!assertNoDeadEnds(resolveCapabilities(matrix))) return false;
      if (plan.tier === "degraded" && plan.notice === null) return false;
      if (plan.tier === "full" && plan.notice !== null) return false;
    }
  }

  // Unsupported OS refuses with the pinned notice and no attestation.
  const refused = resolveBlePlan({ os: "android", version: ANDROID_FLOOR_API - 1 }, "advertise+scan");
  return (
    refused.tier === "unsupported" &&
    refused.attestation === "off" &&
    refused.notice === UNSUPPORTED_OS_NOTICE
  );
}
