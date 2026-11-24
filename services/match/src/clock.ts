/**
 * TECH-15: time is injectable. The matcher reads the wall clock only through
 * a Clock, so expiry and cache-age behaviour is testable without sleeping.
 * (Rotation randomness is already injectable: rankScan takes tieBreakSeed.)
 */

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
