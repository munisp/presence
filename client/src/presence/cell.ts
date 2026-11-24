/**
 * TR-29: on-device presence cell computation.
 *
 * The phone — never the server — turns a location fix into a coarse H3
 * cell. Raw coordinates are function-scoped and dropped before any
 * network call: the only thing that can leave this device is the cell id
 * carried by {@link toPublishPayload}. The server mirrors the discipline
 * by rejecting coordinate-shaped fields with 422 (TR-15/FR-15); this
 * module is the client half of that contract.
 *
 * Framework-free by design: pure TypeScript over h3-js so the unit tests
 * run under plain node --test without a React Native runtime.
 */

import { latLngToCell } from "h3-js";

/** TR-12: cells are computed at the venue resolution; the server descends. */
export const PRESENCE_H3_RESOLUTION = 9;

/** A raw fix exists only inside this module's call scopes. */
export interface LocationFix {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyM: number;
}

/** The only shape that may travel: a cell id, never coordinates. */
export interface PresencePublishPayload {
  readonly cell: string;
}

const COORDINATE_KEYS = ["latitude", "longitude", "lat", "lng", "lon", "accuracyM"] as const;

/** FR-88: an approximate-only fix may not publish presence. */
export const MAX_FIX_ACCURACY_M = 100;

/**
 * Compute the presence cell for a fix. The fix itself is consumed here
 * and never returned, stored, or logged — after this call the device
 * holds the cell id only.
 */
export function computePresenceCell(fix: LocationFix): string {
  return latLngToCell(fix.latitude, fix.longitude, PRESENCE_H3_RESOLUTION);
}

/**
 * Build the publish payload for a fix. Returns null when the fix is too
 * coarse to honour FR-88 (the caller surfaces the accuracy prompt instead
 * of publishing).
 */
export function toPublishPayload(fix: LocationFix): PresencePublishPayload | null {
  if (!(fix.accuracyM > 0) || fix.accuracyM > MAX_FIX_ACCURACY_M) return null;
  return { cell: computePresenceCell(fix) };
}

/**
 * Compile-time intent made runtime-explicit: the publish payload carries
 * no coordinate-shaped field. Used by the unit tests to pin TR-29 — if a
 * future change leaks a coordinate into the payload, the tests fail here
 * rather than in review.
 */
export function payloadDiscardsCoordinates(payload: PresencePublishPayload): boolean {
  const keys = Object.keys(payload);
  return keys.length === 1 && COORDINATE_KEYS.every((k) => !(k in payload));
}
