/**
 * Next-gen maps — the edge contract (SRS Addendum 001: AMD-MAP-02/05).
 *
 * TR-44 serving is STATIC: nginx hands out pre-rendered XYZ PNGs and the
 * manifest/vector bundle (AMD-MAP-06); this module governs DISCOVERY —
 * which bundle the platform serves — and the member read model.
 *
 *   - The manifest a client receives is the published registry row
 *     (AMD-MAP-02), normalised here to a stable wire shape. A missing
 *     bundle is a first-class answer ({available:false}) — clients keep
 *     their last cached manifest or stay geometry-only, never broken.
 *   - venues-near-cell is keyed on the member's own r9 presence cell —
 *     the exact token they already publish (TR-29). Coordinates never
 *     enter this surface: the request carries a cell, the response
 *     carries venue geometry that is already member-visible through
 *     check-in, and the logscrub treats `cell` as sensitive (SEC-08
 *     discipline — no coordinates, cells only).
 *   - Registration/publish are venue-ops only and DB-final: the edge
 *     validates SHAPE, the definer enforces the gate, monotonicity and
 *     the one-published invariant (AMD-MAP-02).
 */

import { isValidCell } from "h3-js";

/** The only cell resolution the member map accepts (TR-12 floor). */
export const MAP_CELL_RESOLUTION = 9;
/** Hard cap mirrored in the definer — a member cannot widen the fan-out. */
export const MAP_VENUES_LIMIT_MAX = 40;

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const BUNDLE_VERSION_RE = /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/;

/** Parse the ?cell= query: an h3 index string at exactly r9, else null. */
export function parseMapCell(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cell = value.trim().toLowerCase();
  if (!/^[0-9a-f]{15}$/.test(cell)) return null;
  if (!isValidCell(cell)) return null;
  // h3-js validates the index; the resolution pin lives in the definer's
  // domain knowledge (r9 is the platform presence resolution, TR-12), and
  // the client only ever publishes r9 (TR-29) — but the leading nibble of
  // a v4+ h3 index encodes the mode/resolution, so pin it directly:
  // bits 52-55 hold the resolution; r9 => second hex char is '9'.
  if (cell[1] !== "9") return null;
  return cell;
}

/** Parse the ?limit= query: 1..MAP_VENUES_LIMIT_MAX, default 40. */
export function parseMapLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return MAP_VENUES_LIMIT_MAX;
  }
  const n = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n)) return -1;
  if (n < 1 || n > MAP_VENUES_LIMIT_MAX) return -1;
  return n;
}

export interface MapManifest {
  available: true;
  bundleId: string;
  version: string;
  label: string;
  bbox: { west: number; south: number; east: number; north: number };
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  tilesSha256: string;
  attribution: string;
  urlTemplate: string;
  vectorsUrl: string;
  publishedAt: string;
}

export type MapManifestAnswer = MapManifest | { available: false };

/**
 * Normalise the definer's manifest row to the wire shape. The bbox arrives
 * as a GeoJSON polygon (ST_AsGeoJSON); the wire wants the four scalars the
 * client's viewport math consumes. Anything unexpected collapses to
 * {available:false} — a malformed registry row must not crash the map.
 */
export function normalizeManifest(row: unknown): MapManifestAnswer {
  if (typeof row !== "object" || row === null) return { available: false };
  const r = row as Record<string, unknown>;
  const bboxGeo = r.bbox as
    | { type?: string; coordinates?: number[][][] }
    | undefined;
  const ring = bboxGeo?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) return { available: false };
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const bbox = {
    west: Math.min(...lngs),
    east: Math.max(...lngs),
    south: Math.min(...lats),
    north: Math.max(...lats),
  };
  if (
    typeof r.bundleId !== "string" ||
    typeof r.version !== "string" ||
    !BUNDLE_VERSION_RE.test(r.version) ||
    typeof r.label !== "string" ||
    typeof r.minZoom !== "number" ||
    typeof r.maxZoom !== "number" ||
    r.minZoom > r.maxZoom ||
    typeof r.tileCount !== "number" ||
    typeof r.tilesSha256 !== "string" ||
    !SHA256_RE.test(r.tilesSha256) ||
    typeof r.attribution !== "string" ||
    typeof r.urlTemplate !== "string" ||
    typeof r.vectorsUrl !== "string"
  ) {
    return { available: false };
  }
  return {
    available: true,
    bundleId: r.bundleId,
    version: r.version,
    label: r.label,
    bbox,
    minZoom: r.minZoom,
    maxZoom: r.maxZoom,
    tileCount: r.tileCount,
    tilesSha256: r.tilesSha256,
    attribution: r.attribution,
    urlTemplate: r.urlTemplate,
    vectorsUrl: r.vectorsUrl,
    publishedAt:
      typeof r.publishedAt === "string" ? r.publishedAt : "",
  };
}

/**
 * The venues projection is definer-shaped already (AMD-MAP-05); the edge
 * re-validates the envelope so a definer bug degrades to an empty map,
 * never to malformed payloads reaching the client.
 */
export function normalizeVenues(payload: unknown): unknown[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter((v): v is Record<string, unknown> => {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Record<string, unknown>;
    return (
      typeof r.venueId === "string" &&
      typeof r.label === "string" &&
      typeof r.geofence === "object" &&
      r.geofence !== null
    );
  });
}

/** The venue-ops registration body: shape validation for the definer call. */
export interface BundleRegistration {
  version: string;
  label: string;
  bbox: { west: number; south: number; east: number; north: number };
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  tilesSha256: string;
  attribution: string;
}

export function parseBundleRegistration(body: unknown): BundleRegistration | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const bbox = b.bbox as Record<string, unknown> | undefined;
  if (
    typeof b.version !== "string" ||
    !BUNDLE_VERSION_RE.test(b.version) ||
    typeof b.label !== "string" ||
    b.label.length < 1 ||
    b.label.length > 120 ||
    typeof bbox !== "object" ||
    bbox === null ||
    typeof bbox.west !== "number" ||
    typeof bbox.south !== "number" ||
    typeof bbox.east !== "number" ||
    typeof bbox.north !== "number" ||
    !(bbox.west < bbox.east) ||
    !(bbox.south < bbox.north) ||
    Math.abs(bbox.west) > 180 ||
    Math.abs(bbox.east) > 180 ||
    Math.abs(bbox.south) > 90 ||
    Math.abs(bbox.north) > 90 ||
    typeof b.minZoom !== "number" ||
    typeof b.maxZoom !== "number" ||
    !Number.isInteger(b.minZoom) ||
    !Number.isInteger(b.maxZoom) ||
    b.minZoom < 0 ||
    b.maxZoom > 22 ||
    b.minZoom > b.maxZoom ||
    typeof b.tileCount !== "number" ||
    !Number.isInteger(b.tileCount) ||
    b.tileCount < 1 ||
    typeof b.tilesSha256 !== "string" ||
    !SHA256_RE.test(b.tilesSha256) ||
    typeof b.attribution !== "string" ||
    b.attribution.length < 1 ||
    b.attribution.length > 240
  ) {
    return null;
  }
  return {
    version: b.version,
    label: b.label,
    bbox: {
      west: bbox.west,
      south: bbox.south,
      east: bbox.east,
      north: bbox.north,
    },
    minZoom: b.minZoom,
    maxZoom: b.maxZoom,
    tileCount: b.tileCount,
    tilesSha256: b.tilesSha256,
    attribution: b.attribution,
  };
}

/** The registration bbox as a GeoJSON polygon literal for the definer. */
export function bboxToPolygonGeoJSON(b: BundleRegistration["bbox"]): string {
  return JSON.stringify({
    type: "Polygon",
    coordinates: [[
      [b.west, b.south],
      [b.east, b.south],
      [b.east, b.north],
      [b.west, b.north],
      [b.west, b.south],
    ]],
  });
}
