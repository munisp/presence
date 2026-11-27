/**
 * AMD-PWA-04 (the link classifier): the member PWA mirrors the AMD-NET-03
 * connectivity discipline on the web — surfaces degrade deliberately,
 * never fail open.
 *
 * The classifier watches its own requests (fed by memberApi) plus the
 * browser's own link signal (navigator.onLine), and classifies the link
 * into three states:
 *
 *   - ONLINE   — requests are succeeding and fast;
 *   - DEGRADED — the link works but is slow or lossy: EMA round-trip
 *     above 1500 ms, or a failure rate above 25% over the last eight
 *     observations;
 *   - OFFLINE  — two consecutive network failures, OR the browser itself
 *     reports no link (navigator.onLine === false short-circuits here).
 *
 * Promotion out of a bad state requires TWO consecutive healthy probes
 * (hysteresis): a flap-prone link must not oscillate the UI between
 * banners every request. Demotion is fast, promotion is slow — the
 * asymmetry is deliberate and identical to the native client's.
 *
 * The classifier drives {@link featureGateForLink}: the full surface, a
 * reduced surface (no background refresh), or the offline surface
 * (outbox + read cache only).
 *
 * Framework-free and pure: observations in, state out. Unit tests run
 * under plain node --test.
 */

export type ConnectivityState = "online" | "degraded" | "offline";
export type LinkFeatures = "full" | "reduced" | "none";

/** EMA weight for the round-trip estimate. */
export const EMA_ALPHA = 0.25;
/** Round-trip above this (EMA) marks the link degraded — a 2G signature. */
export const DEGRADED_RTT_MS = 1_500;
/** Failure-rate window size. */
export const FAILURE_WINDOW = 8;
/**
 * The failure rate only applies once the window holds at least this many
 * observations — a single failed probe is 1/1 = 100% of nothing and must
 * not flap the UI to degraded.
 */
export const MIN_WINDOW_OBSERVATIONS = 4;
/** Failure rate above this over the window marks the link degraded. */
export const FAILURE_RATE_DEGRADED = 0.25;
/** Consecutive network failures that mark the link offline. */
export const OFFLINE_CONSECUTIVE_FAILURES = 2;
/** Consecutive healthy probes required to promote out of a bad state. */
export const PROMOTION_HEALTHY_PROBES = 2;

export interface Observation {
  /** Did the request reach the server and get a response at all? */
  ok: boolean;
  /** Round-trip time; required for successful observations. */
  rttMs?: number;
}

export interface ClassifierState {
  state: ConnectivityState;
  emaRttMs: number | null;
  /** Rolling window of recent outcomes, oldest first. */
  window: boolean[];
  consecutiveFailures: number;
  consecutiveHealthy: number;
}

export function initialClassifierState(): ClassifierState {
  return {
    state: "online",
    emaRttMs: null,
    window: [],
    consecutiveFailures: 0,
    consecutiveHealthy: 0,
  };
}

function failureRate(window: boolean[]): number {
  if (window.length < MIN_WINDOW_OBSERVATIONS) return 0;
  const failures = window.filter((ok) => !ok).length;
  return failures / window.length;
}

/**
 * Fold one request observation into the classifier. Pure — the caller
 * keeps the returned state.
 */
export function observe(current: ClassifierState, observation: Observation): ClassifierState {
  const window = [...current.window, observation.ok].slice(-FAILURE_WINDOW);
  const emaRttMs =
    observation.ok && typeof observation.rttMs === "number"
      ? current.emaRttMs === null
        ? observation.rttMs
        : EMA_ALPHA * observation.rttMs + (1 - EMA_ALPHA) * current.emaRttMs
      : current.emaRttMs;
  const consecutiveFailures = observation.ok ? 0 : current.consecutiveFailures + 1;
  const consecutiveHealthy = observation.ok ? current.consecutiveHealthy + 1 : 0;

  let state = current.state;
  let settledWindow = window;
  if (consecutiveFailures >= OFFLINE_CONSECUTIVE_FAILURES) {
    state = "offline";
  } else if (
    state === "online" &&
    ((emaRttMs !== null && emaRttMs > DEGRADED_RTT_MS) ||
      failureRate(window) > FAILURE_RATE_DEGRADED)
  ) {
    state = "degraded";
  } else if (state !== "online" && consecutiveHealthy >= PROMOTION_HEALTHY_PROBES) {
    // Hysteresis: two consecutive healthy probes promote one step at a
    // time (offline → degraded → online), never a flap straight back —
    // and the promotion RESETS the failure window, because the healthy
    // streak is the new evidence: without the reset, the stale failures
    // still inside the window would re-demote the link on the very next
    // healthy probe.
    state = state === "offline" ? "degraded" : "online";
    settledWindow = [];
  }
  return { state, emaRttMs, window: settledWindow, consecutiveFailures, consecutiveHealthy };
}

/** The browser's own link signal short-circuits to offline. */
export function withBrowserSignal(
  current: ClassifierState,
  browserOnline: boolean,
): ClassifierState {
  if (browserOnline) return current;
  return { ...current, state: "offline", consecutiveHealthy: 0 };
}

/** What the surfaces are allowed to do on this link. */
export function featureGateForLink(state: ConnectivityState): LinkFeatures {
  if (state === "online") return "full";
  if (state === "degraded") return "reduced";
  return "none";
}
