/**
 * AMD-PWA-04 (the bounded read cache): last known state, never the truth.
 *
 * A member reopening the lite client in a dead zone should see their
 * profile, their pairs, and their wallet — not a blank screen. This is
 * the ONLY read-side persistence the PWA allows, and it is bounded four
 * ways, mirroring the native client's AMD-NET-02:
 *
 *   - ALLOWLISTED — exactly five document kinds, nothing else compiles
 *     through review: the member's identity, KYC status, consent pairs,
 *     wallet list, and account visibility;
 *   - TIMESTAMPED — every entry carries cachedAtMs so the UI marks it
 *     stale ("last updated …"), and reads report fresh | stale | absent;
 *   - WHOLESALE — a refresh REPLACES the entry, never merges (a merge
 *     layer is a consistency bug farm);
 *   - CAPPED — 128 KiB total (tighter than the native 256 KiB: the lite
 *     client targets the cheapest devices); corrupted JSON and
 *     schema-version drift read as absent.
 *
 * The cache persists under the single allowlisted key
 * "presence.pwa.readcache" and is wiped on sign-out exactly like the
 * outbox — by construction, via the AMD-PWA-06 wipe contract.
 *
 * Framework-free: the clock and storage are injected. Unit tests run
 * under plain node --test.
 */

export const READ_CACHE_SCHEMA_VERSION = 1;
export const READ_CACHE_MAX_BYTES = 128 * 1024;

/** Single persistence key, on the AMD-PWA-06 wipe contract. */
export const READ_CACHE_STORAGE_KEY = "presence.pwa.readcache";

/** The complete allowlist of cacheable documents. */
export const READ_CACHE_KEYS = [
  "identity:self",
  "identity:kyc",
  "consent:pairs",
  "wallets:list",
  "account:visibility",
] as const;

export type ReadCacheKey = (typeof READ_CACHE_KEYS)[number];

/**
 * Per-document TTL: how long an entry reads as "fresh" before the UI
 * must mark it stale. Tuned to each surface's server-side cadence —
 * pairs move fastest; identity and visibility are quasi-static.
 */
export const READ_CACHE_TTLS_MS: Record<ReadCacheKey, number> = {
  "identity:self": 600_000,
  "identity:kyc": 300_000,
  "consent:pairs": 120_000,
  "wallets:list": 300_000,
  "account:visibility": 600_000,
};

/** Is this key on the read-cache allowlist? Anything else is refused. */
export function isReadCacheKey(key: string): key is ReadCacheKey {
  return (READ_CACHE_KEYS as readonly string[]).includes(key);
}

export interface CacheEntry {
  cachedAtMs: number;
  document: unknown;
}

interface CacheFile {
  schemaVersion: number;
  entries: Record<string, CacheEntry>;
}

/** Minimal storage shape — localStorage in the shell, a Map in tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ReadResult =
  | { kind: "fresh"; document: unknown; cachedAtMs: number }
  | { kind: "stale"; document: unknown; cachedAtMs: number }
  | { kind: "absent" };

function load(storage: KeyValueStorage): CacheFile {
  const raw = storage.getItem(READ_CACHE_STORAGE_KEY);
  if (raw === null) return { schemaVersion: READ_CACHE_SCHEMA_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.schemaVersion !== READ_CACHE_SCHEMA_VERSION || typeof parsed.entries !== "object") {
      return { schemaVersion: READ_CACHE_SCHEMA_VERSION, entries: {} };
    }
    return parsed;
  } catch {
    // Corrupted JSON reads as absent — never a throw into the UI.
    return { schemaVersion: READ_CACHE_SCHEMA_VERSION, entries: {} };
  }
}

function persist(storage: KeyValueStorage, file: CacheFile): void {
  const serialized = JSON.stringify(file);
  if (serialized.length > READ_CACHE_MAX_BYTES) {
    // Over the cap: drop the OLDEST entries until it fits — never grow
    // unboundedly on a cheap device.
    const byAge = Object.entries(file.entries).sort(
      (a, b) => a[1].cachedAtMs - b[1].cachedAtMs,
    );
    const shrunk: CacheFile = { schemaVersion: READ_CACHE_SCHEMA_VERSION, entries: {} };
    for (const [, [key, entry]] of byAge.entries()) {
      const candidate = { ...shrunk.entries, [key]: entry };
      if (JSON.stringify({ schemaVersion: READ_CACHE_SCHEMA_VERSION, entries: candidate }).length <= READ_CACHE_MAX_BYTES) {
        shrunk.entries = candidate;
      }
    }
    storage.setItem(READ_CACHE_STORAGE_KEY, JSON.stringify(shrunk));
    return;
  }
  storage.setItem(READ_CACHE_STORAGE_KEY, serialized);
}

/** Wholesale replace: a refresh REPLACES the document, never merges. */
export function writeDocument(
  storage: KeyValueStorage,
  key: ReadCacheKey,
  document: unknown,
  nowMs: number,
): void {
  if (!isReadCacheKey(key)) throw new Error(`refusing to cache non-allowlisted key: ${key}`);
  const file = load(storage);
  file.entries[key] = { cachedAtMs: nowMs, document };
  persist(storage, file);
}

export function readDocument(
  storage: KeyValueStorage,
  key: ReadCacheKey,
  nowMs: number,
): ReadResult {
  const file = load(storage);
  const entry = file.entries[key];
  if (!entry) return { kind: "absent" };
  const ageMs = nowMs - entry.cachedAtMs;
  return ageMs <= READ_CACHE_TTLS_MS[key]
    ? { kind: "fresh", document: entry.document, cachedAtMs: entry.cachedAtMs }
    : { kind: "stale", document: entry.document, cachedAtMs: entry.cachedAtMs };
}

/** Sign-out and the AMD-PWA-06 wipe both land here. */
export function wipeReadCache(storage: KeyValueStorage): void {
  storage.removeItem(READ_CACHE_STORAGE_KEY);
}
