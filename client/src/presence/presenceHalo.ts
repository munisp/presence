/**
 * FR-77 + FR-78: the presence halo — density as a field, never a map.
 *
 * FR-77 bans proximity displays outright: no map, directional
 * indicator, distance value, radius, heat-map, or arrangement of users
 * by proximity; density may be conveyed only as an undirected
 * aggregate. FR-78 then says what density SHOULD look like: a texture
 * or field whose intensity varies with the number of compatible users
 * in scope, with no positional or directional component.
 *
 * This module is that field. Its input is a single scalar — the count
 * of compatible users in scope, which the server already serves only as
 * a k-anonymised aggregate — and its output is an intensity plus a
 * qualitative level. The descriptor has no key a position, bearing, or
 * distance could occupy: the field set is fixed at {intensity, level},
 * and the level label is forbidden from carrying digits, so the raw
 * count cannot leak through the label.
 *
 * Fail closed: an invalid or suppressed count renders the calmest
 * field, never an inflated one.
 *
 * Imports are pinned by tests/test_batch39.py: surfaceIntegrity.js
 * only, so the halo is audited against the same FR-77 registry every
 * other surface uses. No network, no platform APIs.
 */

import {
  honoursSurfaceProhibitions,
  type SurfaceDescriptor,
} from "./surfaceIntegrity.js";

/** FR-78: qualitative density levels — words, never numbers. */
export const HALO_LEVELS = ["calm", "stirring", "lively", "buzzing"] as const;

export type HaloLevel = (typeof HALO_LEVELS)[number];

/**
 * The count at which the field reads as fully intense. Intensity rises
 * linearly to this scale and clamps beyond it; the scale is pinned so
 * client and tests agree on the texture mapping.
 */
export const HALO_FULL_SCALE = 20;

/**
 * The undirected density field. `intensity` is 0..1; `level` is the
 * qualitative reading of it. No positional or directional component
 * exists anywhere in the type — that absence IS the FR-77 compliance.
 */
export interface PresenceHalo {
  kind: "presence-halo";
  /** 0..1 — the texture's intensity. */
  intensity: number;
  /** Qualitative label; carries no digits by guard. */
  level: HaloLevel;
  /** The halo is ambient: it exposes no interaction affordances. */
  affordances: readonly [];
}

/** Map an intensity to its qualitative level (equal quarters of 0..1). */
export function haloLevel(intensity: number): HaloLevel {
  if (intensity < 0.25) return "calm";
  if (intensity < 0.5) return "stirring";
  if (intensity < 0.75) return "lively";
  return "buzzing";
}

/**
 * Build the halo from the aggregate compatible-user count. Monotonic
 * non-decreasing in the count, clamped to 0..1; NaN, negative, or
 * infinite input fails closed to the calmest field.
 */
export function haloFromCount(compatibleCount: number): PresenceHalo {
  const sane =
    Number.isFinite(compatibleCount) && compatibleCount > 0
      ? compatibleCount
      : 0;
  const intensity = Math.min(1, sane / HALO_FULL_SCALE);
  return {
    kind: "presence-halo",
    intensity,
    level: haloLevel(intensity),
    affordances: [],
  };
}

/** The generic descriptor view of the halo, for the FR-77 audit. */
export function haloDescriptor(halo: PresenceHalo): SurfaceDescriptor {
  return {
    kind: halo.kind,
    affordances: halo.affordances,
    fields: { intensity: halo.intensity, level: halo.level },
  };
}

/**
 * The guard the surface asserts before rendering: no FR-77 proximity
 * element, a field set of exactly {intensity, level}, and a level label
 * that carries no digits — density as an undirected aggregate, full
 * stop.
 */
export function haloHonoursFr77(halo: PresenceHalo): boolean {
  const descriptor = haloDescriptor(halo);
  const keys = Object.keys(descriptor.fields);
  return (
    honoursSurfaceProhibitions(descriptor) &&
    keys.length === 2 &&
    keys.includes("intensity") &&
    keys.includes("level") &&
    !/\d/.test(halo.level)
  );
}
