/**
 * TR-33: certificate pinning that ops can switch off without an app update.
 *
 * Pinning is a MAY in the SRS with one hard condition: it MUST be
 * removable by configuration, so a bad pin or a forced certificate
 * rotation can never brick every installed client at once. This module is
 * the policy half of that contract:
 *
 *  - the pin set is NOT compiled in — it resolves from the remote client
 *    config (GET /v1/client/config, served by the edge from server-side
 *    configuration only), cached for {@link PINNING_CONFIG_TTL_S};
 *  - the config carries a monotonic version (TR-20 discipline): a client
 *    never applies an older config over a newer one;
 *  - every failure mode fails OPEN to the OS trust store — fetch errors
 *    and malformed configs unpin rather than block, because availability
 *    outranks pinning. That is the SRS's anti-bricking clause made code.
 *
 * Removing pinning = clearing the pins server-side and bumping the
 * version. Clients pick it up on the next resolve — no app update, no
 * store review. The actual TLS-layer enforcement lives in the native
 * networking stack; this module decides what that layer is told to do.
 */

/** How long a fetched config may be served from cache before re-resolve. */
export const PINNING_CONFIG_TTL_S = 86_400;

/** sha256/SPKI pin, base64 — the same shape `openssl s_client` reports. */
export const PIN_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/** The remote config payload (mirrors GET /v1/client/config). */
export interface RemotePinningConfig {
  readonly enabled: boolean;
  readonly pins: readonly string[];
  readonly configVersion: number;
}

export type PinningSource =
  | "remote" // freshly fetched and applied
  | "cache" // served within the TTL
  | "stale-refused" // an older config was offered and refused
  | "fallback-unavailable" // fetch failed — OS trust governs
  | "fallback-invalid"; // malformed config — OS trust governs

export interface PinningDecision {
  /** Whether the TLS layer must enforce pins at all. */
  readonly pinned: boolean;
  /** The active pin set (empty when unpinned). */
  readonly pins: readonly string[];
  /** The newest config version this client has applied. */
  readonly appliedVersion: number;
  readonly source: PinningSource;
}

export interface PinningPolicyDeps {
  /** Fetches the remote config — GET /v1/client/config in the app. */
  readonly fetchConfig: () => Promise<RemotePinningConfig>;
  /** Wall clock in seconds (injected for tests — TECH-15 discipline). */
  readonly nowS: () => number;
}

function isValid(config: RemotePinningConfig): boolean {
  if (!Number.isInteger(config.configVersion) || config.configVersion < 1) return false;
  if (!Array.isArray(config.pins)) return false;
  if (!config.pins.every((p) => typeof p === "string" && PIN_PATTERN.test(p))) return false;
  // Enabled with no pins is not a config, it is a self-DoS — refuse it.
  if (config.enabled && config.pins.length === 0) return false;
  return true;
}

const UNPINNED: Omit<PinningDecision, "appliedVersion" | "source"> = {
  pinned: false,
  pins: [],
};

/**
 * Create the pinning policy. Resolves the remote config, applies it
 * monotonically, caches within the TTL, and fails open on every error
 * path — the client can never be bricked by its own pin set.
 */
export function createPinningPolicy(deps: PinningPolicyDeps) {
  let appliedVersion = 0;
  let current: PinningDecision = { ...UNPINNED, appliedVersion, source: "fallback-unavailable" };
  let cachedAtS: number | null = null;

  async function resolve(): Promise<PinningDecision> {
    if (cachedAtS !== null && deps.nowS() - cachedAtS < PINNING_CONFIG_TTL_S) {
      return { ...current, source: "cache" };
    }

    let remote: RemotePinningConfig;
    try {
      remote = await deps.fetchConfig();
    } catch {
      // Fail OPEN: the OS trust store governs. A pinning outage must
      // never take the app down with it (TR-33's whole point).
      return { ...current, ...UNPINNED, source: "fallback-unavailable" };
    }

    // Monotonic versions: never apply an OLDER config over a newer one.
    if (remote.configVersion < appliedVersion) {
      return { ...current, source: "stale-refused" };
    }
    if (remote.configVersion === appliedVersion) {
      // Same version re-validated after the TTL — nothing new to apply;
      // refresh the cache window and keep the current decision.
      cachedAtS = deps.nowS();
      return { ...current, source: "cache" };
    }

    if (!isValid(remote)) {
      // A malformed config unpins rather than blocks — but it still
      // advances the version, so it is not re-fetched in a loop.
      appliedVersion = remote.configVersion;
      current = { ...UNPINNED, appliedVersion, source: "fallback-invalid" };
      cachedAtS = deps.nowS();
      return current;
    }

    appliedVersion = remote.configVersion;
    current = {
      pinned: remote.enabled,
      pins: remote.enabled ? [...remote.pins] : [],
      appliedVersion,
      source: "remote",
    };
    cachedAtS = deps.nowS();
    return current;
  }

  return { resolve };
}

/**
 * The TLS-layer question: given the active decision and the pins
 * presented by the certificate chain, may the connection proceed?
 * Unpinned → always (OS trust governs). Pinned → at least one presented
 * pin must be in the active set (any match in the chain, per HPKP
 * convention).
 */
export function pinChainMatches(decision: PinningDecision, presentedPins: readonly string[]): boolean {
  if (!decision.pinned) return true;
  return presentedPins.some((pin) => decision.pins.includes(pin));
}
