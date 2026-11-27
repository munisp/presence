/**
 * AMD-MAP-04: the console's map engine — a zero-dependency mirror of the
 * client's AMD-MAP-03 contract (cross-pinned in mapSurface.test.ts), so
 * the estate map and the geofence editor's basemap backdrop answer the
 * projection, fetch-discipline and cache questions byte-for-byte the way
 * the member surfaces do. The connectivity state is a local structural
 * type: the console is a workforce surface on a known link, so "online"
 * is its steady state — but the SAME plan function governs what happens
 * when the office link degrades, and the answer is the same as the
 * member's: cache-only, no nagging.
 *
 * The estate overlays are venue geofence polygons (projectPolygon) and
 * the density/overlap QA styling the AMD-CON-05 surface already knows;
 * the editor gains a basemap BACKDROP (tiles under the polygon, pan and
 * zoom in world space) — the polygon math itself is unchanged, so the
 * submit contract (closed, >=3 vertices, no self-intersection, positive
 * shoelace) cannot drift with the backdrop.
 */

// ------------------------------------------------------------ constants --

export const TILE_SIZE = 256;
/** Web Mercator's hard pole limit — beyond this the projection is void. */
export const MAX_MERCATOR_LAT = 85.05112878;
/** The offline placeholder copy, pinned (AMD-NET-04 discipline). */
export const MAP_OFFLINE_NOTICE =
  "Map is offline — showing what's already on this device." as const;
/** The outside-coverage copy, pinned. */
export const MAP_OUTSIDE_NOTICE =
  "Map coverage for your city's launch market is on the way." as const;
/** Bounded tile cache: 320 tiles ≈ 20 zoom-14 viewports. */
export const TILE_CACHE_CAPACITY = 320;

/** The console's link taxonomy — structurally the client's. */
export type MapLinkState = "online" | "degraded" | "offline";

// ------------------------------------------------------------ viewport ---

export interface LonLat {
  lng: number;
  lat: number;
}

export interface MapViewport {
  center: LonLat;
  zoom: number;
  width: number;
  height: number;
}

export interface BundleFootprint {
  bbox: { west: number; south: number; east: number; north: number };
  minZoom: number;
  maxZoom: number;
}

export function clampLatitude(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

export function lonLatToWorld(p: LonLat, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const x = ((p.lng + 180) / 360) * scale;
  const siny = Math.sin((clampLatitude(p.lat) * Math.PI) / 180);
  const y =
    (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * scale;
  return { x, y };
}

export function worldToLonLat(
  w: { x: number; y: number },
  zoom: number,
): LonLat {
  const scale = TILE_SIZE * 2 ** zoom;
  const lng = (w.x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * w.y) / scale;
  return { lng, lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) };
}

export function clampZoom(footprint: BundleFootprint, zoom: number): number {
  return Math.max(footprint.minZoom, Math.min(footprint.maxZoom, Math.round(zoom)));
}

export function insideFootprint(footprint: BundleFootprint, center: LonLat): boolean {
  const b = footprint.bbox;
  return (
    center.lng >= b.west &&
    center.lng <= b.east &&
    center.lat >= b.south &&
    center.lat <= b.north
  );
}

export interface TileRef {
  z: number;
  x: number;
  y: number;
}

export function tileCover(
  footprint: BundleFootprint,
  viewport: MapViewport,
): TileRef[] {
  const z = clampZoom(footprint, viewport.zoom);
  const c = lonLatToWorld(viewport.center, z);
  const x0 = Math.floor((c.x - viewport.width / 2) / TILE_SIZE);
  const x1 = Math.floor((c.x + viewport.width / 2) / TILE_SIZE);
  const y0 = Math.floor((c.y - viewport.height / 2) / TILE_SIZE);
  const y1 = Math.floor((c.y + viewport.height / 2) / TILE_SIZE);
  const max = 2 ** z - 1;
  const out: TileRef[] = [];
  for (let y = Math.max(0, y0); y <= Math.min(max, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(max, x1); x++) {
      out.push({ z, x, y });
    }
  }
  return out;
}

export function worldToScreen(
  w: { x: number; y: number },
  viewport: MapViewport,
): { x: number; y: number } {
  const z = viewport.zoom;
  const c = lonLatToWorld(viewport.center, z);
  return {
    x: w.x - c.x + viewport.width / 2,
    y: w.y - c.y + viewport.height / 2,
  };
}

export function tilePlacement(
  tile: TileRef,
  viewport: MapViewport,
): { left: number; top: number } {
  const world = { x: tile.x * TILE_SIZE, y: tile.y * TILE_SIZE };
  const screen = worldToScreen(world, viewport);
  return { left: screen.x, top: screen.y };
}

export function tileUrl(template: string, tile: TileRef): string {
  return template
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}

// ------------------------------------------------------------ overlays ---

export function projectPolygon(
  ring: Array<[number, number]>,
  viewport: MapViewport,
): Array<{ x: number; y: number }> {
  return ring.map(([lng, lat]) =>
    worldToScreen(lonLatToWorld({ lng, lat }, viewport.zoom), viewport));
}

export function projectCellBoundary(
  boundary: Array<[number, number]>,
  viewport: MapViewport,
): Array<{ x: number; y: number }> {
  return projectPolygon(boundary, viewport);
}

// ------------------------------------------------------ fetch discipline --

export type TileFetchAction = "fetch" | "cache-only" | "placeholder";

export interface TileFetchPlan {
  action: TileFetchAction;
  notice: string | null;
}

export function planTileFetch(
  link: MapLinkState,
  cached: boolean,
): TileFetchPlan {
  switch (link) {
    case "online":
      return { action: "fetch", notice: null };
    case "degraded":
      return cached
        ? { action: "cache-only", notice: null }
        : { action: "placeholder", notice: null };
    case "offline":
      return cached
        ? { action: "cache-only", notice: MAP_OFFLINE_NOTICE }
        : { action: "placeholder", notice: MAP_OFFLINE_NOTICE };
  }
}

export function prefetchZoomRadius(_link: MapLinkState): number {
  return 0;
}

// ------------------------------------------------------------ tile cache --

export class TileCache<T> {
  private readonly capacity: number;
  private bundleVersion: string | null = null;
  private readonly entries = new Map<string, T>();

  constructor(capacity: number = TILE_CACHE_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  setBundleVersion(version: string): boolean {
    if (this.bundleVersion === version) return false;
    this.bundleVersion = version;
    const had = this.entries.size > 0;
    this.entries.clear();
    return had;
  }

  get version(): string | null {
    return this.bundleVersion;
  }

  get size(): number {
    return this.entries.size;
  }

  static key(tile: TileRef): string {
    return `${tile.z}/${tile.x}/${tile.y}`;
  }

  has(tile: TileRef): boolean {
    return this.entries.has(TileCache.key(tile));
  }

  get(tile: TileRef): T | undefined {
    const key = TileCache.key(tile);
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  put(tile: TileRef, value: T): void {
    const key = TileCache.key(tile);
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

// ------------------------------------------------------ console-specific --

/**
 * AMD-MAP-04: fit a viewport to a geofence ring — the editor's basemap
 * backdrop needs the polygon centred with margin at a zoom the bundle
 * serves. Pure: returns the viewport the canvas should adopt.
 */
export function fitViewportToRing(
  footprint: BundleFootprint,
  ring: Array<[number, number]>,
  width: number,
  height: number,
): MapViewport | null {
  if (ring.length < 3) return null;
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  if (!(west < east) || !(south < north)) return null;
  const center = { lng: (west + east) / 2, lat: (south + north) / 2 };
  // Largest zoom whose world-pixel span of the ring fits the viewport
  // with a 20% margin, clamped to the bundle.
  let zoom = footprint.maxZoom;
  for (; zoom > footprint.minZoom; zoom--) {
    const nw = lonLatToWorld({ lng: west, lat: north }, zoom);
    const se = lonLatToWorld({ lng: east, lat: south }, zoom);
    if (se.x - nw.x <= width * 0.8 && se.y - nw.y <= height * 0.8) break;
  }
  return { center, zoom: clampZoom(footprint, zoom), width, height };
}
