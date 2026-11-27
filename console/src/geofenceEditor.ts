/**
 * AMD-CON-05 (GeoLibre geofence editor): the polygon-editing geometry
 * contract behind the console's geofence surface. Framework-free and
 * basemap-free BY DESIGN — the TR-44 tile surface lands with AMD-MAP
 * (batch 70); until then the editor works on geometry alone over an
 * equirectangular projection, and safety stays where it already lives:
 * the edge re-runs the density check at draft creation and Postgres
 * re-verifies density + overlap at publish. This module never improvises
 * validity — validateForSubmit is the only path to a submittable GeoJSON.
 */

export interface Vertex {
  lng: number;
  lat: number;
}

export interface EditorPolygon {
  vertices: Vertex[];
  closed: boolean;
}

export const MIN_POLYGON_VERTICES = 3;
/** Editor sanity cap — far beyond any real geofence, catches runaway input. */
export const MAX_POLYGON_VERTICES = 256;

export function emptyPolygon(): EditorPolygon {
  return { vertices: [], closed: false };
}

function isVertex(value: unknown): value is Vertex {
  const v = value as Vertex | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.lng === "number" &&
    typeof v.lat === "number" &&
    Number.isFinite(v.lng) &&
    Number.isFinite(v.lat) &&
    Math.abs(v.lng) <= 180 &&
    Math.abs(v.lat) <= 90
  );
}

/** Append a vertex. A closed polygon takes no new vertices — reopen first. */
export function addVertex(poly: EditorPolygon, vertex: Vertex): EditorPolygon {
  if (poly.closed || !isVertex(vertex)) return poly;
  if (poly.vertices.length >= MAX_POLYGON_VERTICES) return poly;
  return { ...poly, vertices: [...poly.vertices, vertex] };
}

export function moveVertex(poly: EditorPolygon, index: number, vertex: Vertex): EditorPolygon {
  if (index < 0 || index >= poly.vertices.length || !isVertex(vertex)) return poly;
  const vertices = poly.vertices.slice();
  vertices[index] = vertex;
  return { ...poly, vertices };
}

/** Delete a vertex — never below the closed-polygon minimum. */
export function deleteVertex(poly: EditorPolygon, index: number): EditorPolygon {
  if (index < 0 || index >= poly.vertices.length) return poly;
  if (poly.closed && poly.vertices.length <= MIN_POLYGON_VERTICES) return poly;
  return { ...poly, vertices: poly.vertices.filter((_, i) => i !== index) };
}

export function closePolygon(poly: EditorPolygon): EditorPolygon {
  if (poly.vertices.length < MIN_POLYGON_VERTICES) return poly;
  return { ...poly, closed: true };
}

export function reopenPolygon(poly: EditorPolygon): EditorPolygon {
  return { ...poly, closed: false };
}

/** The GeoJSON ring: vertices with the first repeated to close it. */
export function ringOf(poly: EditorPolygon): Vertex[] {
  if (poly.vertices.length === 0) return [];
  return [...poly.vertices, poly.vertices[0]];
}

// ----------------------------------------------------------- geometry -----

const METRES_PER_DEG_LAT = 110_540;
const METRES_PER_DEG_LNG_AT_EQUATOR = 111_320;

/** Shoelace area in m² under a local equirectangular approximation. */
export function shoelaceAreaM2(vertices: Vertex[]): number {
  if (vertices.length < MIN_POLYGON_VERTICES) return 0;
  const meanLat =
    (vertices.reduce<number>((sum, v) => sum + v.lat, 0) / vertices.length) * (Math.PI / 180);
  const mx = METRES_PER_DEG_LNG_AT_EQUATOR * Math.cos(meanLat);
  const my = METRES_PER_DEG_LAT;
  let area = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    area += a.lng * mx * (b.lat * my) - b.lng * mx * (a.lat * my);
  }
  return Math.abs(area) / 2;
}

export function centroid(vertices: Vertex[]): Vertex | null {
  if (vertices.length === 0) return null;
  return {
    lng: vertices.reduce<number>((sum, v) => sum + v.lng, 0) / vertices.length,
    lat: vertices.reduce<number>((sum, v) => sum + v.lat, 0) / vertices.length,
  };
}

export interface Bounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export function bounds(vertices: Vertex[]): Bounds | null {
  if (vertices.length === 0) return null;
  return {
    minLng: Math.min(...vertices.map((v) => v.lng)),
    minLat: Math.min(...vertices.map((v) => v.lat)),
    maxLng: Math.max(...vertices.map((v) => v.lng)),
    maxLat: Math.max(...vertices.map((v) => v.lat)),
  };
}

function orientation(a: Vertex, b: Vertex, c: Vertex): number {
  const cross = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  if (Math.abs(cross) < 1e-12) return 0;
  return cross > 0 ? 1 : -1;
}

function segmentsProperlyIntersect(p1: Vertex, p2: Vertex, p3: Vertex, p4: Vertex): boolean {
  const d1 = orientation(p3, p4, p1);
  const d2 = orientation(p3, p4, p2);
  const d3 = orientation(p1, p2, p3);
  const d4 = orientation(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Proper self-intersection over the CLOSED ring; only non-adjacent segment
 * pairs are tested, so shared endpoints of neighbours never count.
 */
export function selfIntersects(vertices: Vertex[]): boolean {
  const n = vertices.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    const a1 = vertices[i];
    const a2 = vertices[(i + 1) % n];
    for (let j = i + 1; j < n; j += 1) {
      // Skip adjacent segments (including the wrap-around pair).
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = vertices[j];
      const b2 = vertices[(j + 1) % n];
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

// --------------------------------------------------------- submit gate ----

export type SubmitValidation = { ok: true } | { ok: false; reason: string };

export function validateForSubmit(poly: EditorPolygon): SubmitValidation {
  if (!poly.closed) return { ok: false, reason: "polygon is not closed" };
  if (poly.vertices.length < MIN_POLYGON_VERTICES) {
    return { ok: false, reason: `a geofence needs at least ${MIN_POLYGON_VERTICES} vertices` };
  }
  if (poly.vertices.length > MAX_POLYGON_VERTICES) {
    return { ok: false, reason: `polygon exceeds the ${MAX_POLYGON_VERTICES}-vertex editor cap` };
  }
  if (selfIntersects(poly.vertices)) return { ok: false, reason: "polygon self-intersects" };
  if (!(shoelaceAreaM2(poly.vertices) > 0)) return { ok: false, reason: "polygon has no area" };
  return { ok: true };
}

/** The only path to a submittable GeoJSON — invalid input returns null. */
export function toGeoJSON(poly: EditorPolygon): { type: "Polygon"; coordinates: number[][][] } | null {
  if (!validateForSubmit(poly).ok) return null;
  return {
    type: "Polygon",
    coordinates: [ringOf(poly).map((v) => [v.lng, v.lat])],
  };
}

/** Parse a GeoJSON Polygon back into the editor; anything else → null. */
export function fromGeoJSON(json: unknown): EditorPolygon | null {
  const g = json as { type?: unknown; coordinates?: unknown } | null;
  if (g?.type !== "Polygon" || !Array.isArray(g.coordinates)) return null;
  const ring = g.coordinates[0];
  if (!Array.isArray(ring) || ring.length < MIN_POLYGON_VERTICES + 1) return null;
  const vertices: Vertex[] = [];
  // Drop the closing duplicate if present.
  const raw = ring as unknown[];
  const limit =
    raw.length > 1 &&
    Array.isArray(raw[0]) &&
    Array.isArray(raw[raw.length - 1]) &&
    (raw[0] as number[])[0] === (raw[raw.length - 1] as number[])[0] &&
    (raw[0] as number[])[1] === (raw[raw.length - 1] as number[])[1]
      ? raw.length - 1
      : raw.length;
  for (let i = 0; i < limit; i += 1) {
    const pair = raw[i] as unknown;
    if (!Array.isArray(pair) || pair.length < 2) return null;
    const vertex = { lng: Number(pair[0]), lat: Number(pair[1]) };
    if (!isVertex(vertex)) return null;
    vertices.push(vertex);
  }
  if (vertices.length < MIN_POLYGON_VERTICES) return null;
  return { vertices, closed: true };
}

// --------------------------------------------------------- projection -----

export interface Viewport {
  width: number;
  height: number;
  padding: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface Projector {
  toScreen(vertex: Vertex): ScreenPoint;
  toGeo(point: ScreenPoint): Vertex;
}

/**
 * Fit a bounds into a viewport with aspect preserved and the y axis
 * flipped (screen y grows downward, latitude grows upward). Degenerate
 * bounds (a point) fall back to a 1 km window so the editor still renders.
 */
export function projector(b: Bounds, viewport: Viewport): Projector {
  const pad = Math.max(0, viewport.padding);
  const innerW = Math.max(1, viewport.width - 2 * pad);
  const innerH = Math.max(1, viewport.height - 2 * pad);
  const spanLng = Math.max(b.maxLng - b.minLng, 0.01);
  const spanLat = Math.max(b.maxLat - b.minLat, 0.01);
  const scale = Math.min(innerW / spanLng, innerH / spanLng);
  const offsetX = pad + (innerW - spanLng * scale) / 2;
  const offsetY = pad + (innerH - spanLat * scale) / 2;
  return {
    toScreen: (v) => ({
      x: offsetX + (v.lng - b.minLng) * scale,
      y: offsetY + (b.maxLat - v.lat) * scale,
    }),
    toGeo: (p) => ({
      lng: b.minLng + (p.x - offsetX) / scale,
      lat: b.maxLat - (p.y - offsetY) / scale,
    }),
  };
}

/** Nearest vertex within radiusPx, else null. */
export function hitTestVertex(
  points: ScreenPoint[],
  p: ScreenPoint,
  radiusPx: number,
): number | null {
  let best: number | null = null;
  let bestDist = radiusPx;
  for (let i = 0; i < points.length; i += 1) {
    const d = Math.hypot(points[i].x - p.x, points[i].y - p.y);
    if (d <= bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

/** Nearest segment (by start index) within tolerancePx — midpoint insert. */
export function hitTestEdge(
  points: ScreenPoint[],
  p: ScreenPoint,
  tolerancePx: number,
): number | null {
  let best: number | null = null;
  let bestDist = tolerancePx;
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d <= bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

/** Insert a vertex AFTER the given segment start index. */
export function insertVertexAfter(
  poly: EditorPolygon,
  segmentStart: number,
  vertex: Vertex,
): EditorPolygon {
  if (segmentStart < 0 || segmentStart >= poly.vertices.length || !isVertex(vertex)) return poly;
  if (poly.vertices.length >= MAX_POLYGON_VERTICES) return poly;
  const vertices = poly.vertices.slice();
  vertices.splice(segmentStart + 1, 0, vertex);
  return { ...poly, vertices };
}
