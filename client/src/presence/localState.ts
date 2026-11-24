/**
 * TR-30: minimum local state.
 *
 * The client persists only what a session strictly needs, from an
 * explicit allowlist — there is no analytics blob, no contact cache, no
 * location history on this device. Everything on the allowlist is wiped
 * by {@link clearLocalState} on logout or the uninstall signal, and the
 * wipe covers every allowlisted key by construction: adding a key to the
 * allowlist adds it to the wipe.
 *
 * Framework-free: the KV backend is injected, so the unit tests run under
 * plain node --test. The Expo SecureStore adapter lives in
 * src/platform/secureStore.ts (native side, typechecked, not executed
 * here).
 */

/**
 * What the client may persist, and why. Keys are namespaced; the wipe
 * iterates this list, so the allowlist IS the retention policy.
 */
export const LOCAL_STATE_ALLOWLIST = [
  // Refresh token for the consumer session (Keycloak) — secure store only.
  "presence.session.refreshToken",
  // The registered device id (FR-05) — needed to resume the session.
  "presence.device.id",
  // Notification preferences (FR-58) — user-set, safety-exempt server-side.
  "presence.notifications.prefs",
  // Taxonomy snapshot version for offline pickers (TR-20/TR-34).
  "presence.taxonomy.version",
] as const;

export type LocalStateKey = (typeof LOCAL_STATE_ALLOWLIST)[number];

/** Minimal KV surface the platform adapters implement. */
export interface KeyValueBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

/**
 * Type-safe local state: only allowlisted keys compile. Values are small
 * strings — anything bigger belongs on the server.
 */
export function createLocalState(backend: KeyValueBackend) {
  return {
    get: (key: LocalStateKey) => backend.getItem(key),
    set: (key: LocalStateKey, value: string) => backend.setItem(key, value),
    remove: (key: LocalStateKey) => backend.deleteItem(key),
  };
}

/**
 * TR-30 wipe: logout or the uninstall signal clears every allowlisted
 * key. The list comes from the allowlist itself, so retention and wipe
 * can never drift apart.
 */
export async function clearLocalState(backend: KeyValueBackend): Promise<void> {
  await Promise.all(LOCAL_STATE_ALLOWLIST.map((key) => backend.deleteItem(key)));
}

/** In-memory backend — tests and ephemeral sessions. */
export function createMemoryBackend(): KeyValueBackend & { keys(): string[] } {
  const map = new Map<string, string>();
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => void map.set(key, value),
    deleteItem: async (key) => void map.delete(key),
    keys: () => [...map.keys()],
  };
}
