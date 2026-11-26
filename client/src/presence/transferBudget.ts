/**
 * AMD-NET-05: last-mile transfer budgets — payloads must fit the last
 * mile, not the lab.
 *
 * The member this platform is FOR is on a contested 2G/3G link in Lagos,
 * not on the office fibre the developers test on. This module makes that
 * concrete: named link profiles model the last mile, and every
 * network-bound surface carries a budget in SECONDS on the 2G profile.
 * Client and edge tests pin the actual wire sizes against these budgets,
 * so a feature that doubles a payload fails CI before it strands a member.
 *
 * Transfer model: one RTT of setup plus serialization time at the
 * profile's downlink rate. It is deliberately simple — a budget you can
 * compute in your head is a budget people respect.
 */

export interface LinkProfile {
  /** Downlink throughput in kilobits per second. */
  downKbps: number;
  /** Round-trip time in milliseconds. */
  rttMs: number;
}

/**
 * Named last-mile profiles. `edge2g` is the design floor — 50 kbps and a
 * 1200 ms RTT is a real congested EDGE cell, and it is the profile every
 * budget is asserted against.
 */
export const LINK_PROFILES = {
  edge2g: { downKbps: 50, rttMs: 1_200 },
  rural3g: { downKbps: 400, rttMs: 600 },
  urban4g: { downKbps: 10_000, rttMs: 80 },
} as const;

export type LinkProfileName = keyof typeof LINK_PROFILES;

/** Expected transfer time: one RTT plus serialization at the downlink rate. */
export function transferSeconds(bytes: number, profile: LinkProfile): number {
  return profile.rttMs / 1000 + (bytes * 8) / (profile.downKbps * 1000);
}

export type BudgetedSurface =
  | "scan"
  | "publish"
  | "configBootstrap"
  | "configRevalidate"
  | "message";

/**
 * Per-surface budgets, asserted on the 2G profile. `configRevalidate`
 * is the AMD-NET-04 conditional GET: a 304 answer must cost one round
 * trip and nothing else — its budget is a hair above one RTT.
 */
export const SURFACE_TRANSFER_BUDGETS: Record<
  BudgetedSurface,
  { profile: LinkProfileName; maxSeconds: number }
> = {
  scan: { profile: "edge2g", maxSeconds: 8 },
  publish: { profile: "edge2g", maxSeconds: 4 },
  configBootstrap: { profile: "edge2g", maxSeconds: 6 },
  configRevalidate: { profile: "edge2g", maxSeconds: 1.3 },
  message: { profile: "edge2g", maxSeconds: 6 },
};

/** Does a payload of this size meet the surface's last-mile budget? */
export function fitsTransferBudget(surface: BudgetedSurface, bytes: number): boolean {
  const budget = SURFACE_TRANSFER_BUDGETS[surface];
  return transferSeconds(bytes, LINK_PROFILES[budget.profile]) <= budget.maxSeconds;
}

/** The largest payload (bytes) that still meets the surface's budget. */
export function maxBytesForBudget(surface: BudgetedSurface): number {
  const budget = SURFACE_TRANSFER_BUDGETS[surface];
  const profile = LINK_PROFILES[budget.profile];
  const serializationSeconds = budget.maxSeconds - profile.rttMs / 1000;
  if (serializationSeconds <= 0) return 0;
  return Math.floor((serializationSeconds * profile.downKbps * 1000) / 8);
}

export interface BudgetReport {
  surface: BudgetedSurface;
  bytes: number;
  seconds: number;
  maxSeconds: number;
  withinBudget: boolean;
}

/** Evaluate one payload size against every surface's budget. */
export function budgetReport(bytesBySurface: Partial<Record<BudgetedSurface, number>>): BudgetReport[] {
  return (Object.keys(SURFACE_TRANSFER_BUDGETS) as BudgetedSurface[]).map((surface) => {
    const bytes = bytesBySurface[surface] ?? 0;
    const budget = SURFACE_TRANSFER_BUDGETS[surface];
    const seconds = transferSeconds(bytes, LINK_PROFILES[budget.profile]);
    return {
      surface,
      bytes,
      seconds,
      maxSeconds: budget.maxSeconds,
      withinBudget: seconds <= budget.maxSeconds,
    };
  });
}
