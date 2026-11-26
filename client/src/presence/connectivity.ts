/**
 * AMD-NET-03: the connectivity classifier — surfaces degrade
 * deliberately, never fail open.
 *
 * The client watches its own requests and classifies the link into
 * three states:
 *
 *   - ONLINE   — requests are succeeding and fast;
 *   - DEGRADED — the link works but is slow or lossy: EMA round-trip
 *     above 1500 ms, or a failure rate above 25% over the last eight
 *     observations;
 *   - OFFLINE  — two consecutive network failures.
 *
 * Promotion out of a bad state requires TWO consecutive healthy probes
 * (hysteresis): a flap-prone link must not oscillate the UI between
 * banners every request. Demotion is fast (one bad window), promotion is
 * slow (two good probes) — the asymmetry is deliberate.
 *
 * The classifier drives {@link featureGateForLink}: the full surface, a
 * reduced surface (no imagery prefetch, no background refresh), or the
 * offline surface (outbox + read cache only).
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

export interface ConnectivitySample {
  state: ConnectivityState;
  /** Exponential moving average of successful round-trips. */
  emaRttMs: number | null;
  /** Last {@link FAILURE_WINDOW} success flags, oldest first. */
  window: boolean[];
  consecutiveFailures: number;
  consecutiveHealthy: number;
}

export const INITIAL_CONNECTIVITY: ConnectivitySample = {
  state: "online",
  emaRttMs: null,
  window: [],
  consecutiveFailures: 0,
  consecutiveHealthy: 0,
};

/** A healthy probe: succeeded AND fast enough to count as a good link. */
function isHealthy(obs: Observation): boolean {
  return obs.ok && (obs.rttMs ?? Number.POSITIVE_INFINITY) <= DEGRADED_RTT_MS;
}

/** Record one request outcome; returns the next sample. Pure. */
export function recordObservation(
  sample: ConnectivitySample,
  obs: Observation,
): ConnectivitySample {
  const window = [...sample.window, obs.ok].slice(-FAILURE_WINDOW);
  const consecutiveFailures = obs.ok ? 0 : sample.consecutiveFailures + 1;
  const consecutiveHealthy = isHealthy(obs) ? sample.consecutiveHealthy + 1 : 0;
  const emaRttMs =
    obs.ok && typeof obs.rttMs === "number"
      ? sample.emaRttMs === null
        ? obs.rttMs
        : EMA_ALPHA * obs.rttMs + (1 - EMA_ALPHA) * sample.emaRttMs
      : sample.emaRttMs;

  const failures = window.filter((ok) => !ok).length;
  const failureRate =
    window.length < MIN_WINDOW_OBSERVATIONS ? 0 : failures / window.length;
  const degradedCondition =
    (emaRttMs !== null && emaRttMs > DEGRADED_RTT_MS) ||
    failureRate > FAILURE_RATE_DEGRADED;

  let state = sample.state;
  if (consecutiveFailures >= OFFLINE_CONSECUTIVE_FAILURES) {
    state = "offline"; // demote fast
  } else if (state === "online" && degradedCondition) {
    state = "degraded"; // demote fast
  } else if (state !== "online" && consecutiveHealthy >= PROMOTION_HEALTHY_PROBES) {
    // Promote slow — and only as far as the measurements justify.
    state = degradedCondition ? "degraded" : "online";
  }

  return { state, emaRttMs, window, consecutiveFailures, consecutiveHealthy };
}

/**
 * The feature set a link state entitles the UI to. Offline is "none":
 * the outbox and the read cache carry the experience until the link
 * returns — surfaces must not pretend they are live.
 */
export function featureGateForLink(state: ConnectivityState): LinkFeatures {
  switch (state) {
    case "online":
      return "full";
    case "degraded":
      return "reduced";
    case "offline":
      return "none";
  }
}

/** Which surfaces survive each link state — the degradation contract. */
export const LINK_SURFACE_MAP: Record<
  LinkFeatures,
  { realtimeRefresh: boolean; imageryPrefetch: boolean; backgroundSync: boolean }
> = {
  full: { realtimeRefresh: true, imageryPrefetch: true, backgroundSync: true },
  reduced: { realtimeRefresh: true, imageryPrefetch: false, backgroundSync: false },
  none: { realtimeRefresh: false, imageryPrefetch: false, backgroundSync: false },
};
