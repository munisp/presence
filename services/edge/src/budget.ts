/**
 * FR-28: density-scaled match budget. The denser the venue, the fewer scans
 * each account may burn per window — from three per hour in a sparse cell
 * down to one per day in a crowd. This is a product budget, separate from
 * the SEC-20 anti-abuse ceilings (200 scans/hour), which still apply.
 */

export interface MatchBudget {
  band: "sparse" | "busy" | "crowd";
  limit: number;        // scans allowed per window
  windowSeconds: number;
}

export const BUDGET_BUSY_MIN_POP = 25;   // below → sparse
export const BUDGET_CROWD_MIN_POP = 100; // at/above → crowd

/** FR-28: budget for a cell population, per the spec ladder. */
export function matchBudget(cellPopulation: number): MatchBudget {
  if (cellPopulation >= BUDGET_CROWD_MIN_POP) {
    return { band: "crowd", limit: 1, windowSeconds: 86_400 };
  }
  if (cellPopulation >= BUDGET_BUSY_MIN_POP) {
    return { band: "busy", limit: 2, windowSeconds: 3_600 };
  }
  return { band: "sparse", limit: 3, windowSeconds: 3_600 };
}
