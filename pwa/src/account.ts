/**
 * AMD-PWA-06 (privacy self-service): the member's own data and devices,
 * manageable from the lite client — consents, visibility, devices, the
 * DSAR export, and account deletion. This is the NDPR/GDPR surface:
 * everything reads through the member's own authenticated endpoints and
 * every destructive action is gated.
 *
 * Account deletion requires the member to TYPE the confirmation phrase —
 * a button alone is never enough for an irreversible act. Sign-out and
 * deletion both run the wipe contract: every key the PWA persists (the
 * PKCE transaction, the read cache, the outbox) is removed, so a shared
 * handset keeps nothing.
 */

import { PKCE_STORAGE_KEY } from "./oidc.js";
import { READ_CACHE_STORAGE_KEY } from "./readCache.js";
import { OUTBOX_STORAGE_KEY } from "./outbox.js";

/** The typed phrase that arms account deletion. */
export const DELETE_CONFIRMATION_PHRASE = "DELETE";

/** Every storage key the PWA persists — the wipe iterates exactly this. */
export const PERSISTED_KEYS = [PKCE_STORAGE_KEY, READ_CACHE_STORAGE_KEY, OUTBOX_STORAGE_KEY] as const;

export interface DeviceSummary {
  deviceId: string;
  platform: string;
  lastSeenAt: string | null;
}

interface DevicesWire {
  devices?: unknown;
}

interface DeviceWire {
  deviceId?: unknown;
  deviceIdAlias?: unknown;
  platform?: unknown;
  lastSeenAt?: unknown;
  last_seen_at?: unknown;
}

function parseDevices(wire: unknown): DeviceSummary[] {
  const raw = Array.isArray(wire) ? wire : (wire as DevicesWire).devices;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d): DeviceSummary | null => {
      const w = d as DeviceWire & { device_id?: unknown };
      const id =
        typeof w.deviceId === "string"
          ? w.deviceId
          : typeof w.device_id === "string"
            ? w.device_id
            : null;
      if (!id) return null;
      const seen =
        typeof w.lastSeenAt === "string"
          ? w.lastSeenAt
          : typeof w.last_seen_at === "string"
            ? w.last_seen_at
            : null;
      return {
        deviceId: id,
        platform: typeof w.platform === "string" ? w.platform : "unknown",
        lastSeenAt: seen,
      };
    })
    .filter((d): d is DeviceSummary => d !== null);
}

export { parseDevices };

/** Typed-confirmation gate — exact phrase, case-sensitive, trimmed. */
export function deleteConfirmed(typed: string): boolean {
  return typed.trim() === DELETE_CONFIRMATION_PHRASE;
}

/** Minimal storage shapes — the wipe works on both Web Storage objects. */
export interface RemovableStorage {
  removeItem(key: string): void;
}

/**
 * The wipe contract: every persisted key removed from every storage the
 * PWA touches. Idempotent — removing an absent key is a no-op.
 */
export function wipeAll(storages: RemovableStorage[]): void {
  for (const storage of storages) {
    for (const key of PERSISTED_KEYS) storage.removeItem(key);
  }
}
