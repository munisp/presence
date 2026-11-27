/**
 * AMD-MAP-03: the map surface's rendering engine — Web Mercator math,
 * the tile-fetch discipline, and the bounded tile cache. Framework-free
 * pure TypeScript: the unit tests run under plain node --test, and the
 * console and member PWA carry byte-for-byte mirrors of this contract
 * (cross-pinned) so every surface answers the same questions the same
 * way.
 *
 * Three contracts live here:
 *
 *   1. Projection — Web Mercator (EPSG:3857) world-pixel math. One
 *      canonical implementation of lonLat<->world, tile cover, and the
 *      zoom clamp against the serving bundle's declared range. Tiles
 *      are 256px XYZ PNGs rendered OFFLINE (AMD-MAP-01) and served
 *      statically (TR-44) — there is no runtime tile server to fall
 *      back to, so a viewport outside the bundle bbox is a first-class
 *      state ({outsideBounds}), never a broken grid.
 *
 *   2. The fetch discipline — LINK_SURFACE_MAP made concrete for map
 *      imagery (AMD-NET-04). planTileFetch turns the connectivity
 *      classifier's verdict into an explicit per-tile plan: full link
 *      fetches and prefetches the cover; reduced keeps the map alive
 *      from cache only (no prefetch, no new network); offline is
 *      cache-only with the pinned offline notice. A tile NEVER fetched
 *      is a styled placeholder with the bundle's attribution, not an
 *      empty hole.
 *
 *   3. The cache budget — a bounded LRU over decoded tile keys. The cap
 *      is a count, not bytes (tiles are uniform 256px PNGs, so count is
 *      a tight byte proxy); the whole cache invalidates wholesale when
 *      the serving bundle VERSION changes — a stale tile from bundle
 *      1.0.0 must never render beside a fresh one from 1.1.0. The
 *      manifest itself is revalidated per AMD-MAP-05's no-cache header;
 *      this cache holds TILES only.
 *
 * Overlays are geometry the platform already governs: venue geofence
 * polygons (member-visible through check-in) and the member's own
 * presence halo as an r9 cell boundary — never a coordinate dot
 * (TR-15/SEC-08). projectPolygon and projectCellBoundary turn both into
 * screen space; the halo polygon comes from h3-js (the governed library
 * the match service shares), which this module deliberately does not
 * import — callers pass the boundary ring in, keeping this engine
 * dependency-free.
 */

import type { ConnectivityState } from "./connectivity.js";

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
/** Bounded tile cache: 320 tiles ≈ 20 zoom-14 viewports — deep enough to
 * pan the launch market, shallow enough for a 2G handset (AMD-NET-04). */
export const TILE_CACHE_CAPACITY = 320;

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

/** The serving bundle's declared footprint (AMD-MAP-02 wire shape). */
export interface BundleFootprint {
  bbox: { west: number; south: number; east: number; north: number };
  minZoom: number;
  maxZoom: number;
}

export function clampLatitude(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

/** Degrees -> world pixels at zoom, NW origin. The projection primitive. */
export function lonLatToWorld(p: LonLat, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const x = ((p.lng + 180) / 360) * scale;
  const siny = Math.sin((clampLatitude(p.lat) * Math.PI) / 180);
  const y =
    (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * scale;
  return { x, y };
}

/** World pixels at zoom -> degrees. Exact inverse of lonLatToWorld. */
export function worldToLonLat(
  w: { x: number; y: number },
  zoom: number,
): LonLat {
  const scale = TILE_SIZE * 2 ** zoom;
  const lng = (w.x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * w.y) / scale;
  return { lng, lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) };
}

/** Clamp a zoom request into the serving bundle's declared range. */
export function clampZoom(footprint: BundleFootprint, zoom: number): number {
  return Math.max(footprint.minZoom, Math.min(footprint.maxZoom, Math.round(zoom)));
}

/** Is the viewport's centre inside the serving bundle's bbox? */
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

/** The tiles covering a viewport at its (clamped) zoom, NW-to-SE order. */
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

/** Screen position of a world point inside the viewport (CSS px). */
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

/** The tile a screen position renders from, and the offset inside it. */
export function tilePlacement(
  tile: TileRef,
  viewport: MapViewport,
): { left: number; top: number } {
  const world = { x: tile.x * TILE_SIZE, y: tile.y * TILE_SIZE };
  const screen = worldToScreen(world, viewport);
  return { left: screen.x, top: screen.y };
}

/** Fill the manifest's URL template for a tile. */
export function tileUrl(template: string, tile: TileRef): string {
  return template
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}

// ------------------------------------------------------------ overlays ---

/**
 * A polygon ring (GeoJSON order: [lng, lat][]) -> screen-space points.
 * Used for venue geofences (AMD-MAP-05) and the console's estate
 * overlays (AMD-MAP-04).
 */
export function projectPolygon(
  ring: Array<[number, number]>,
  viewport: MapViewport,
): Array<{ x: number; y: number }> {
  return ring.map(([lng, lat]) =>
    worldToScreen(lonLatToWorld({ lng, lat }, viewport.zoom), viewport));
}

/**
 * The member's presence halo: the r9 cell boundary ring -> screen space.
 * The cell IS the disclosure (TR-29); drawing its boundary shows the
 * member exactly what the platform knows — never a coordinate dot.
 */
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
  /** Present on cache-only/placeholder: the pinned copy the surface shows. */
  notice: string | null;
}

/**
 * LINK_SURFACE_MAP for map imagery (AMD-NET-04): full fetches; reduced
 * and offline are cache-only. Reduced carries NO notice (the map keeps
 * working silently from cache — degradation must not nag); offline
 * carries the pinned notice. The placeholder branch exists for tiles
 * absent from cache under cache-only — the surface draws the styled
 * placeholder, never a broken-image hole.
 */
export function planTileFetch(
  link: ConnectivityState,
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

/**
 * Prefetch budget per link state: how far BEYOND the viewport's own
 * cover the surface may prefetch, in zoom levels. The answer is zero
 * on every link — LINK_SURFACE_MAP's imageryPrefetch entitlement on a
 * full link is spent on the visible cover itself (the launch bundle is
 * a single market; adjacent-zoom prefetch on a metered link is exactly
 * the waste AMD-NET-04 forbids), and reduced/offline prefetch nothing.
 * The function exists so the budget is a pinned decision, not an
 * accident of the renderer.
 */
export function prefetchZoomRadius(_link: ConnectivityState): number {
  return 0;
}

// ------------------------------------------------------------ tile cache --

/**
 * The bounded tile LRU. Keys are "z/x/y" strings; the payload is opaque
 * to the engine (an ImageBitmap in the PWAs, a decoded buffer in the RN
 * client). Version-keyed: setBundleVersion with a DIFFERENT version
 * wipes the cache wholesale — cross-bundle mixing is the one rendering
 * bug a cache can cause, and it is unrepresentable here.
 */
export class TileCache<T> {
  private readonly capacity: number;
  private bundleVersion: string | null = null;
  private readonly entries = new Map<string, T>();

  constructor(capacity: number = TILE_CACHE_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  /** Returns true when the version change wiped the cache. */
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

  /** LRU touch: a hit re-inserts at the recency head. */
  get(tile: TileRef): T | undefined {
    const key = TileCache.key(tile);
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  /** Insert at the recency head; evict the coldest entry past capacity. */
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
