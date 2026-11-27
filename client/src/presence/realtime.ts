/**
 * AMD-CRT-04: the realtime adapter — Centrifugo, gated by the link.
 *
 * Live surfaces (pair lifecycle, messaging, presence ticks) ride a
 * Centrifugo websocket; this module is the client-side contract:
 *
 *   - CONFIGURED OR OFF — the websocket URL arrives in the bootstrap
 *     config (GET /v1/client/config, realtime.wsUrl). An empty URL
 *     means the deployment has no realtime tier and the adapter stays
 *     OFF — fail closed, never a guessed endpoint;
 *   - TOKEN-BOUND — the connection token comes from the edge's
 *     POST /v1/realtime/token (HS256, 600 s, channels claim scoped to
 *     the member's own pair and user channels). The adapter refreshes
 *     the token REALTIME_TOKEN_REFRESH_MARGIN_S before expiry, and it
 *     subscribes ONLY to channels the token granted — the server-side
 *     allowlist is the privacy boundary, the client enforces it too;
 *   - LINK-GATED — the AMD-NET-03 classifier decides: offline
 *     disconnects IMMEDIATELY (a dead link must not burn reconnect
 *     attempts), degraded keeps the socket but suppresses resubscribe
 *     churn (LINK_SURFACE_MAP.reduced.realtimeRefresh), online is full;
 *   - BOUNDED RECONNECT — full-jitter exponential backoff, base 1 s,
 *     cap 60 s, so a recovering edge is not thundered;
 *   - SINGLE-FLIGHT — concurrent connect requests join one attempt.
 *
 * Framework-free: the centrifuge-compatible client is injected as a
 * factory, so the unit tests run under plain node --test and the app
 * shell binds the real `centrifuge` package (admitted via TECH-16).
 */

import type { ConnectivitySample } from "./connectivity.js";
import { featureGateForLink } from "./connectivity.js";

/** Server-minted connection token lifetime (edge realtimeToken.ts). */
export const REALTIME_TOKEN_LIFESPAN_S = 600;
/** Refresh the token this far before expiry — mid-session never lapses. */
export const REALTIME_TOKEN_REFRESH_MARGIN_S = 60;
export const REALTIME_RECONNECT_BASE_MS = 1_000;
export const REALTIME_RECONNECT_CAP_MS = 60_000;

/** The realtime block of the bootstrap config; empty wsUrl = tier off. */
export interface RealtimeBootstrap {
  wsUrl: string;
}

export type RealtimeMode =
  /** No realtime tier configured — the adapter never connects. */
  | "disabled"
  /** Link is offline — disconnect immediately, do not retry. */
  | "offline"
  /** Link is degraded — keep the socket, suppress resubscribe churn. */
  | "degraded"
  /** Full operation. */
  | "active";

/**
 * The operating mode for a config + link sample. Offline beats
 * degraded beats active; an empty wsUrl beats everything.
 */
export function realtimeMode(
  config: RealtimeBootstrap,
  connectivity: ConnectivitySample,
): RealtimeMode {
  if (config.wsUrl.trim().length === 0) return "disabled";
  const features = featureGateForLink(connectivity.state);
  if (features === "none") return "offline";
  if (features === "reduced") return "degraded";
  return "active";
}

/** Full-jitter reconnect backoff: base 1 s doubling, capped at 60 s. */
export function reconnectDelayMs(consecutiveFailures: number, random: () => number): number {
  const exponential = REALTIME_RECONNECT_BASE_MS * 2 ** Math.max(0, consecutiveFailures);
  const capped = Math.min(exponential, REALTIME_RECONNECT_CAP_MS);
  return Math.floor(random() * capped);
}

export interface ConnectionToken {
  token: string;
  /** Server-allowlisted channels — the ONLY channels the client may join. */
  channels: string[];
  /** When the edge minted the token (epoch ms). */
  issuedAtMs: number;
}

/** The wall-clock moment the adapter must refresh the connection token. */
export function tokenRefreshDueAtMs(issuedAtMs: number): number {
  return issuedAtMs + (REALTIME_TOKEN_LIFESPAN_S - REALTIME_TOKEN_REFRESH_MARGIN_S) * 1000;
}

export function tokenUsable(token: ConnectionToken, nowMs: number): boolean {
  return nowMs < token.issuedAtMs + REALTIME_TOKEN_LIFESPAN_S * 1000;
}

/** Privacy boundary, enforced client-side too: granted channels only. */
export function channelAllowed(channel: string, granted: readonly string[]): boolean {
  return granted.includes(channel);
}

export interface SubscriptionPlan {
  subscribe: string[];
  unsubscribe: string[];
}

/**
 * Reconcile current subscriptions against the token's grant. On a
 * degraded link the plan may only ADD the initial join — it never
 * unsubscribes: the socket stays up and a flapping link must not churn
 * leave/rejoin cycles; the server replays what matters on recovery.
 */
export function subscriptionPlan(
  current: readonly string[],
  granted: readonly string[],
  mode: RealtimeMode,
): SubscriptionPlan {
  if (mode === "disabled" || mode === "offline") {
    return { subscribe: [], unsubscribe: [...current] };
  }
  const desired = granted.filter((c) => channelAllowed(c, granted));
  if (mode === "degraded") {
    return {
      subscribe: desired.filter((c) => !current.includes(c)),
      unsubscribe: [],
    };
  }
  return {
    subscribe: desired.filter((c) => !current.includes(c)),
    unsubscribe: current.filter((c) => !desired.includes(c)),
  };
}

// ---------------------------------------------------------------- adapter --

/** The centrifuge-compatible handle the app shell binds. */
export interface RealtimeClientHandle {
  connect(): void;
  disconnect(): void;
  subscribe(channel: string): void;
  unsubscribe(channel: string): void;
}

export interface RealtimeAdapterEffects {
  nowMs(): number;
  /** Uniform [0, 1) — full-jitter source. */
  random(): number;
  /** POST /v1/realtime/token via the AMD-CRT-01 chokepoint. */
  fetchToken(): Promise<ConnectionToken>;
  /** Builds the centrifuge client for a fresh token. */
  createClient(wsUrl: string, token: string): RealtimeClientHandle;
}

export interface RealtimeAdapter {
  /**
   * Reconcile the adapter with the current config + link. Connects when
   * the mode is active/degraded and no connection exists; disconnects
   * immediately when the mode flips to offline/disabled. Joins an
   * in-flight connect.
   */
  sync(config: RealtimeBootstrap, connectivity: ConnectivitySample): Promise<RealtimeMode>;
  /** Current subscriptions (allowlist-enforced). */
  subscriptions(): string[];
  /** True while a connect attempt is in flight. */
  connecting(): boolean;
}

export function createRealtimeAdapter(effects: RealtimeAdapterEffects): RealtimeAdapter {
  let handle: RealtimeClientHandle | null = null;
  let token: ConnectionToken | null = null;
  let current: string[] = [];
  let pending: Promise<RealtimeMode> | null = null;

  async function connect(config: RealtimeBootstrap, mode: RealtimeMode): Promise<RealtimeMode> {
    if (token === null || !tokenUsable(token, effects.nowMs())) {
      token = await effects.fetchToken();
    }
    if (handle === null) {
      handle = effects.createClient(config.wsUrl, token.token);
      handle.connect();
    }
    const plan = subscriptionPlan(current, token.channels, mode);
    for (const channel of plan.subscribe) {
      handle.subscribe(channel);
    }
    for (const channel of plan.unsubscribe) {
      handle.unsubscribe(channel);
    }
    current = current.filter((c) => !plan.unsubscribe.includes(c)).concat(plan.subscribe);
    return mode;
  }

  return {
    sync(config: RealtimeBootstrap, connectivity: ConnectivitySample): Promise<RealtimeMode> {
      const mode = realtimeMode(config, connectivity);
      if (mode === "disabled" || mode === "offline") {
        if (handle !== null) {
          handle.disconnect();
          handle = null;
        }
        const plan = subscriptionPlan(current, [], mode);
        current = current.filter((c) => !plan.unsubscribe.includes(c));
        token = null;
        return Promise.resolve(mode);
      }
      if (pending !== null) return pending;
      const run = connect(config, mode).finally(() => {
        if (pending === run) pending = null;
      });
      pending = run;
      return run;
    },
    subscriptions(): string[] {
      return [...current];
    },
    connecting(): boolean {
      return pending !== null;
    },
  };
}
