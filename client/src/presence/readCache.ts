/**
 * AMD-NET-02: the bounded read cache — last known state, never the truth.
 *
 * A member reopening the app in a dead zone should see their last scan,
 * their conversations, and nearby venues — not a blank screen. This is
 * the ONLY read-side persistence the client allows, and it is bounded
 * four ways:
 *
 *   - ALLOWLISTED — exactly four document kinds, nothing else compiles
 *     through review: the last scan result, the conversation list, page
 *     zero of each open conversation, and the nearby-venues list;
 *   - TIMESTAMPED — every entry carries cachedAtMs so the UI marks it
 *     stale ("last updated …"), and reads report fresh | stale | absent;
 *   - WHOLESALE — a refresh REPLACES the entry, never merges (a merge
 *     layer is a consistency bug farm);
 *   - CAPPED — 256 KiB total; corrupted JSON and schema-version drift
     read as absent.
 *
 * The cache persists under the single allowlisted key
 * "presence.cache.read" and is wiped on logout and duress exactly like
 * the session — by construction, via the TR-30 allowlist wipe.
 *
 * Framework-free: the clock is injected; storage is the caller's
 * KeyValueBackend. Unit tests run under plain node --test.
 */

export const READ_CACHE_SCHEMA_VERSION = 1;
export const READ_CACHE_MAX_BYTES = 256 * 1024;

/** Single persistence key, on the TR-30 allowlist (localState.ts). */
export const READ_CACHE_STORAGE_KEY = "presence.cache.read";

/** The static allowlisted documents. */
export const READ_CACHE_STATIC_KEYS = [
  "scan:last",
  "conversations:list",
  "venues:nearby",
] as const;

/**
 * Per-document TTL: how long an entry reads as "fresh" before the UI
 * must mark it stale. Tuned to each surface's server-side cadence —
 * scan results live on the 300 s publish cadence; nearby venues are
 * quasi-static; messaging moves fastest.
 */
export const READ_CACHE_TTLS_MS: Record<string, number> = {
  "scan:last": 300_000,
  "conversations:list": 120_000,
  "venues:nearby": 600_000,
  "messages:page0": 120_000,
};

/** The dynamic allowlisted shape: page zero of one conversation. */
const MESSAGES_PAGE0_PATTERN = /^messages:[0-9a-f-]{36}:page0$/;

/** Is this key on the read-cache allowlist? Anything else is refused. */
export function isReadCacheKey(key: string): boolean {
  return (
    (READ_CACHE_STATIC_KEYS as readonly string[]).includes(key) ||
    MESSAGES_PAGE0_PATTERN.test(key)
  );
}

function ttlFor(key: string): number {
  return MESSAGES_PAGE0_PATTERN.test(key)
    ? READ_CACHE_TTLS_MS["messages:page0"]!
    : (READ_CACHE_TTLS_MS[key] ?? 0);
}

export interface CachedDocument {
  schemaVersion: number;
  cachedAtMs: number;
  payload: unknown;
}

/** The whole cache: key → document. */
export type ReadCache = Record<string, CachedDocument>;

export type CacheRead =
  | { state: "fresh"; payload: unknown; cachedAtMs: number }
  | { state: "stale"; payload: unknown; cachedAtMs: number }
  | { state: "absent" };

/** Read a document — absent entries never resurrect as truth. */
export function readDocument(
  cache: ReadCache,
  key: string,
  nowMs: number,
): CacheRead {
  if (!isReadCacheKey(key)) return { state: "absent" };
  const doc = cache[key];
  if (!doc) return { state: "absent" };
  if (doc.schemaVersion !== READ_CACHE_SCHEMA_VERSION) return { state: "absent" };
  const ttl = ttlFor(key);
  const fresh = ttl > 0 && nowMs - doc.cachedAtMs <= ttl;
  return { state: fresh ? "fresh" : "stale", payload: doc.payload, cachedAtMs: doc.cachedAtMs };
}

export type PutResult =
  | { ok: true; cache: ReadCache }
  | { ok: false; reason: "key-not-allowlisted" | "document-too-large" };

/**
 * Write a document — WHOLESALE REPLACE, never merge. If the cache would
 * exceed the cap, the oldest entries are evicted first; a single entry
 * larger than the cap is refused (fail closed, never silently half-write).
 */
export function putDocument(
  cache: ReadCache,
  key: string,
  payload: unknown,
  nowMs: number,
): PutResult {
  if (!isReadCacheKey(key)) return { ok: false, reason: "key-not-allowlisted" };
  const doc: CachedDocument = {
    schemaVersion: READ_CACHE_SCHEMA_VERSION,
    cachedAtMs: nowMs,
    payload,
  };
  const next: ReadCache = { ...cache, [key]: doc };
  if (cacheBytes(next) <= READ_CACHE_MAX_BYTES) return { ok: true, cache: next };
  if (cacheBytes({ [key]: doc }) > READ_CACHE_MAX_BYTES) {
    return { ok: false, reason: "document-too-large" };
  }
  // Evict oldest-first until the wholesale replacement fits.
  const evictable = Object.entries(next)
    .filter(([k]) => k !== key)
    .sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs);
  const pruned: ReadCache = { ...next };
  for (const [k] of evictable) {
    if (cacheBytes(pruned) <= READ_CACHE_MAX_BYTES) break;
    delete pruned[k];
  }
  return { ok: true, cache: pruned };
}

function cacheBytes(cache: ReadCache): number {
  let total = 0;
  for (const [key, doc] of Object.entries(cache)) {
    total += key.length + JSON.stringify(doc).length;
  }
  return total;
}

/** Remove one document (e.g. a conversation the member deleted). */
export function dropDocument(cache: ReadCache, key: string): ReadCache {
  const next = { ...cache };
  delete next[key];
  return next;
}

// ------------------------------------------------------------ persistence --

export function serializeReadCache(cache: ReadCache): string {
  return JSON.stringify({ version: READ_CACHE_SCHEMA_VERSION, documents: cache });
}

/**
 * Load the persisted cache. Corrupt JSON, a shape mismatch, or a
 * schema-version drift is an EMPTY cache — the UI falls back to its
 * loading state, never to half-parsed data.
 */
export function loadReadCache(raw: string | null): ReadCache {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    if ((parsed as { version?: unknown }).version !== READ_CACHE_SCHEMA_VERSION) return {};
    const documents = (parsed as { documents?: unknown }).documents;
    if (typeof documents !== "object" || documents === null) return {};
    const out: ReadCache = {};
    for (const [key, value] of Object.entries(documents)) {
      if (isReadCacheKey(key) && isCachedDocument(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function isCachedDocument(value: unknown): value is CachedDocument {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    d.schemaVersion === READ_CACHE_SCHEMA_VERSION &&
    typeof d.cachedAtMs === "number" &&
    "payload" in d
  );
}
