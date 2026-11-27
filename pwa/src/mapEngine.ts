/**
 * AMD-MAP-05: the member PWA's map engine — a zero-dependency mirror of
 * the client's AMD-MAP-03 contract (cross-pinned in mapSurface.test.ts).
 * The explore map renders the static basemap (TR-44), nearby partner
 * venues as their published geofences (projectPolygon), and the member's
 * own presence halo as the r9 cell boundary (projectCellBoundary) —
 * never a coordinate dot. The fetch discipline is the LINK_SURFACE_MAP
 * contract made concrete: on a degraded link the map runs from the tile
 * cache without nagging; offline it runs cache-only with the pinned
 * notice; a tile that was never cached is a styled placeholder, not a
 * broken image.
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
/** Bounded tile cache: 320 tiles ≈ 20 zoom-14 viewports. */
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

export function prefetchZoomRadius(_link: ConnectivityState): number {
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

// --------------------------------------------------------- member-specific --

/**
 * AMD-MAP-05: centre the explore map on the member's own presence — the
 * r9 cell boundary's centroid, so the map opens on what the member
 * already disclosed, never on a raw fix.
 */
export function centroidOfBoundary(
  boundary: Array<[number, number]>,
): LonLat | null {
  if (boundary.length < 3) return null;
  let lng = 0;
  let lat = 0;
  for (const [x, y] of boundary) {
    lng += x;
    lat += y;
  }
  return { lng: lng / boundary.length, lat: lat / boundary.length };
}
