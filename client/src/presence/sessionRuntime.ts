/**
 * AMD-CRT-02: the session runtime — proactive refresh, never a dead tap.
 *
 * session.ts owns the DECISIONS (when to refresh, what a 401 means);
 * this module owns the DRIVING of them while the app is alive:
 *
 *   - PROACTIVE — a refresh is scheduled at refreshDueAtMs (REFRESH_MARGIN_S
 *     before expiry), so a member mid-session never hits a 401 on a tap;
 *   - BOUNDED — at most REFRESH_ATTEMPTS attempts with the AMD-NET-03
 *     full-jitter schedule ({@link REFRESH_BACKOFF_MS}); the whole
 *     schedule is proven to fit inside the margin by
 *     refreshScheduleFitsMargin();
 *   - HONEST EXHAUSTION — when the schedule is spent the runtime says
 *     "reauthenticate", never a silent infinite retry;
 *   - ROTATION-SAFE — a successful response maps through
 *     refreshedSession, which keeps the previous refresh token unless
 *     the realm rotated a replacement (SEC-02);
 *   - SINGLE-FLIGHT — the proactive driver and the reactive 401 path
 *     can fire together; the coordinator joins concurrent refreshers on
 *     ONE in-flight call, so the realm never sees a refresh storm and a
 *     rotation is never raced by a parallel stale-token refresh.
 *
 * Framework-free: the refresh call, sleep, clock and randomness are
 * injected, so the unit tests run under plain node --test.
 */

import {
  refreshAttemptDelayMs,
  refreshDueAtMs,
  refreshedSession,
  REFRESH_ATTEMPTS,
  type SessionTokens,
  type TokenResponseLike,
} from "./session.js";

export interface RefreshEffects {
  /**
   * Calls the token endpoint with the refresh token. Resolves with the
   * parsed body on ANY HTTP response; THROWS only on a network failure.
   * A revoked refresh token resolves with an error body, which fails the
   * {@link refreshedSession} mapping and ends in "reauthenticate" —
   * exactly right, since retrying a dead credential cannot help.
   */
  refresh(refreshToken: string, deviceId: string): Promise<TokenResponseLike>;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
  /** Uniform [0, 1) — full-jitter source. */
  random(): number;
}

export type RefreshResult =
  | { kind: "refreshed"; tokens: SessionTokens }
  | { kind: "reauthenticate" };

/** How long the scheduler sleeps before kicking the proactive refresh. */
export function nextRefreshDelayMs(tokens: SessionTokens, nowMs: number): number {
  return Math.max(0, refreshDueAtMs(tokens) - nowMs);
}

/**
 * Run one bounded proactive refresh. Each attempt waits the full-jitter
 * delay for its slot ({@link REFRESH_BACKOFF_MS}), then calls the realm.
 * A network failure consumes an attempt and moves to the next slot; a
 * response that does not map to a usable session ends the loop at once
 * — the server answered, so the honest next step is re-authentication.
 */
export async function runProactiveRefresh(
  previous: SessionTokens,
  effects: RefreshEffects,
): Promise<RefreshResult> {
  for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt++) {
    const delay = refreshAttemptDelayMs(attempt, effects.random);
    if (delay > 0) await effects.sleep(delay);
    let json: TokenResponseLike;
    try {
      json = await effects.refresh(previous.refreshToken, previous.deviceId);
    } catch {
      continue; // network failure — the next backoff slot retries
    }
    const next = refreshedSession(previous, json, effects.nowMs());
    return next === null ? { kind: "reauthenticate" } : { kind: "refreshed", tokens: next };
  }
  return { kind: "reauthenticate" };
}

/**
 * The single-flight coordinator. Both refresh triggers (the proactive
 * timer and a reactive 401 from any in-flight request) call ensureFresh;
 * concurrent callers join the SAME in-flight refresh and all receive the
 * same result. A refresh requested while one is running does not start a
 * second call — the in-flight result is fresh by construction.
 */
export interface RefreshCoordinator {
  ensureFresh(current: SessionTokens): Promise<RefreshResult>;
  /** True while a refresh is in flight (UI may show a subtle indicator). */
  inFlight(): boolean;
}

export function createRefreshCoordinator(effects: RefreshEffects): RefreshCoordinator {
  let pending: Promise<RefreshResult> | null = null;
  return {
    ensureFresh(current: SessionTokens): Promise<RefreshResult> {
      if (pending !== null) return pending;
      const run = runProactiveRefresh(current, effects).finally(() => {
        if (pending === run) pending = null;
      });
      pending = run;
      return run;
    },
    inFlight(): boolean {
      return pending !== null;
    },
  };
}
