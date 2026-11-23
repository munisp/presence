/**
 * Anti-abuse velocity rules (PRS-SRS-001 §7, SEC-20).
 *
 * On top of the six-per-minute burst limit (FR-24, enforced by the gateway
 * rate limiter), each account gets:
 *
 *   - 200 scans per hour (SCAN_HOURLY_MAX)
 *   - 20 waves per day   (WAVE_DAILY_MAX — a wave is a consent express)
 *   - impossible-travel rejection: consecutive presence fixes are compared
 *     by H3 grid distance against elapsed time; implied speeds above a
 *     plausible vehicle (MAX_PLAUSIBLE_KMH, deliberately generous so only
 *     teleports trip it) are refused with a 422.
 *
 * Pure helpers so the contract is testable without infrastructure.
 */

// H3 average edge length (km) at the storage resolutions (TR-12/14 ladder).
export const EDGE_KM: Record<number, number> = { 9: 0.1744, 10: 0.0659, 11: 0.0249 };

/** Centre-to-centre distance between adjacent cells: edge * sqrt(3). */
export function kmPerGridStep(resolution: number): number {
  const edge = EDGE_KM[resolution];
  if (!edge) throw new Error(`unsupported H3 resolution ${resolution}`);
  return edge * Math.sqrt(3);
}

export const MAX_PLAUSIBLE_KMH = 500; // SEC-20: trips on teleports only

/** SEC-20: implied speed between two presence fixes, in km/h. */
export function impliedSpeedKmh(gridSteps: number, resolution: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return Number.POSITIVE_INFINITY;
  const km = gridSteps * kmPerGridStep(resolution);
  return km / (elapsedMs / 3_600_000);
}

/** SEC-20: true when the move between two fixes is implausibly fast. */
export function isImpossibleTravel(gridSteps: number, resolution: number, elapsedMs: number): boolean {
  return impliedSpeedKmh(gridSteps, resolution, elapsedMs) > MAX_PLAUSIBLE_KMH;
}

export const SCAN_HOURLY_MAX = 200; // SEC-20
export const WAVE_DAILY_MAX = 20;   // SEC-20
