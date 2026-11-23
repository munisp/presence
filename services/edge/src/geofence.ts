/**
 * TR-41: geofence authoring helpers — GeoJSON validation and the density
 * gate mirrored in TypeScript.
 *
 * The mirror exists so the GeoLibre authoring console gets immediate,
 * precise feedback while drawing; the final authority is
 * geofence_density_check() in migration 0017, re-run inside
 * publish_geofence_draft() in the publish transaction. The two
 * implementations must agree — the acceptance tests pin the constants and
 * the decision boundary in both layers.
 *
 * The gate: a valid ring of at least four vertices (first == last), area
 * between 10 m² and 1 km², and no edge longer than 25 m — chord error
 * stays far under one presence cell (ADR-0008: geometry is PostGIS'
 * concern; presence cells never mix in).
 */

export const GEOFENCE_MIN_VERTICES = 4;
export const GEOFENCE_MIN_AREA_M2 = 10;
export const GEOFENCE_MAX_AREA_M2 = 1_000_000;
export const GEOFENCE_MAX_SEGMENT_M = 25;

const EARTH_RADIUS_M = 6_371_008.8;

export type Ring = ReadonlyArray<readonly [number, number]>; // [lon, lat]

export type GeofenceParse =
  | { ok: true; ring: Ring }
  | { ok: false; error: string };

/**
 * Parse the polygon the console submits: GeoJSON { type: "Polygon",
 * coordinates: [ring] } with a single exterior ring of [lon, lat] pairs.
 * Holes are rejected at P0 — a geofence with a courtyard cut-out is two
 * drafts, not one polygon with a hole the review must reason about.
 */
export function parseGeofencePolygon(body: unknown): GeofenceParse {
  if (body === null || typeof body !== "object") return { ok: false, error: "polygon must be an object" };
  const b = body as Record<string, unknown>;
  if (b.type !== "Polygon") return { ok: false, error: "polygon must be GeoJSON type Polygon" };
  const coords = b.coordinates;
  if (!Array.isArray(coords) || coords.length !== 1) {
    return { ok: false, error: "polygon must carry exactly one ring" };
  }
  const ring = coords[0];
  if (!Array.isArray(ring) || ring.length < GEOFENCE_MIN_VERTICES) {
    return { ok: false, error: `polygon needs at least ${GEOFENCE_MIN_VERTICES} vertices` };
  }
  const out: Array<readonly [number, number]> = [];
  for (const p of ring) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "number" || typeof p[1] !== "number") {
      return { ok: false, error: "polygon vertices must be [lon, lat] pairs" };
    }
    if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) {
      return { ok: false, error: "polygon vertices must be valid lon/lat" };
    }
    out.push([p[0], p[1]]);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return { ok: false, error: "polygon ring must be closed (first vertex equals last)" };
  }
  return { ok: true, ring: out };
}

/** Great-circle distance in metres (haversine). */
export function segmentLengthM(a: readonly [number, number], b: readonly [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Spherical excess area of a ring in m² (Chamberlain–Duquette). */
export function ringAreaM2(ring: Ring): number {
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i].map((d) => (d * Math.PI) / 180);
    const [lon2, lat2] = ring[i + 1].map((d) => (d * Math.PI) / 180);
    total += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

export type DensityCheck = { ok: true } | { ok: false; error: string };

/**
 * The density gate (TR-41): mirrors geofence_density_check() — same
 * bounds, same edge-length rule. Long-edge feedback names the segment so
 * the editor can zoom straight to it.
 */
export function densityCheck(ring: Ring): DensityCheck {
  if (ring.length < GEOFENCE_MIN_VERTICES) {
    return { ok: false, error: "polygon needs at least 4 vertices" };
  }
  const area = ringAreaM2(ring);
  if (area < GEOFENCE_MIN_AREA_M2 || area > GEOFENCE_MAX_AREA_M2) {
    return { ok: false, error: "polygon area must be between 10 m² and 1 km²" };
  }
  for (let i = 0; i < ring.length - 1; i++) {
    const len = segmentLengthM(ring[i], ring[i + 1]);
    if (len > GEOFENCE_MAX_SEGMENT_M) {
      return {
        ok: false,
        error: `polygon edges must be at most 25 m (segment ${i + 1} is ${Math.round(len)} m — densify the outline)`,
      };
    }
  }
  return { ok: true };
}
