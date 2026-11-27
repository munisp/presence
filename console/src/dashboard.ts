/**
 * AMD-CON-03 (workforce dashboard): one overview assembled from the
 * existing moderated list endpoints. Two disciplines:
 *
 *  - 403-TOLERANT: a section the operator's role cannot read contributes
 *    nothing instead of breaking the dashboard (a venue-ops lead still
 *    sees their geofence estate); any OTHER failure fails the load — an
 *    overview that silently drops a broken endpoint would lie by omission.
 *  - FRESHNESS: the overview carries its fetch timestamp and is marked
 *    stale past OVERVIEW_STALE_AFTER_MS so an operator never acts on
 *    quietly-ageing numbers.
 */

import { ConsoleForbiddenError, type ConsoleApi } from "./consoleApi.js";
import type { ConsoleSection } from "./surfaces.js";

export const OVERVIEW_STALE_AFTER_MS = 60_000;

export interface OverviewCounts {
  reports: number;
  appeals: number;
  kycSessions: number;
  kycReviews: number;
  onboarding: number;
  elevation: number;
  geofenceConflicts: number;
}

export interface Overview {
  counts: OverviewCounts;
  fetchedAtMs: number;
}

export interface OverviewEffects {
  nowMs(): number;
}

function listLength(json: unknown, key: string): number {
  const value = (json as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function emptyCounts(): OverviewCounts {
  return {
    reports: 0,
    appeals: 0,
    kycSessions: 0,
    kycReviews: 0,
    onboarding: 0,
    elevation: 0,
    geofenceConflicts: 0,
  };
}

/**
 * Pull every list the role can read and count it. Sections not in
 * `readable` are never requested (no point paying for a 403), and a 403
 * that slips through anyway is tolerated per the contract above.
 */
export async function loadOverview(
  api: ConsoleApi,
  effects: OverviewEffects,
  readable: readonly ConsoleSection[],
): Promise<Overview> {
  const counts = emptyCounts();
  const can = (section: ConsoleSection) => readable.includes(section);
  const tolerateForbidden = (task: Promise<unknown>) =>
    task.catch((err: unknown) => {
      if (err instanceof ConsoleForbiddenError) return null;
      throw err;
    });

  const tasks: Promise<void>[] = [];
  if (can("moderation")) {
    tasks.push(
      tolerateForbidden(api.get("/v1/moderation/queue")).then((j) => {
        counts.reports = listLength(j, "queue");
      }),
    );
  }
  if (can("appeals")) {
    tasks.push(
      tolerateForbidden(api.get("/v1/moderation/appeals")).then((j) => {
        counts.appeals = listLength(j, "appeals");
      }),
    );
  }
  if (can("kyc")) {
    tasks.push(
      tolerateForbidden(api.get("/v1/moderation/kyc-sessions")).then((j) => {
        counts.kycSessions = listLength(j, "sessions");
      }),
      tolerateForbidden(api.get("/v1/moderation/kyc-queue")).then((j) => {
        counts.kycReviews = listLength(j, "requests");
      }),
    );
  }
  if (can("onboarding")) {
    tasks.push(
      tolerateForbidden(api.get("/v1/moderation/onboarding")).then((j) => {
        counts.onboarding = listLength(j, "applications");
      }),
    );
  }
  if (can("elevation")) {
    tasks.push(
      tolerateForbidden(api.get("/v1/moderation/elevation")).then((j) => {
        counts.elevation = listLength(j, "requests");
      }),
    );
  }
  if (can("geofences")) {
    tasks.push(
      tolerateForbidden(api.get("/v1/ops/geofences/qa")).then((j) => {
        const venues = (j as { venues?: { overlapConflicts?: unknown }[] } | null)?.venues;
        counts.geofenceConflicts = Array.isArray(venues)
          ? venues.reduce<number>(
              (sum, v) => sum + (typeof v.overlapConflicts === "number" ? v.overlapConflicts : 0),
              0,
            )
          : 0;
      }),
    );
  }
  await Promise.all(tasks);
  return { counts, fetchedAtMs: effects.nowMs() };
}

export function freshness(overview: Overview, nowMs: number): { ageMs: number; stale: boolean } {
  const ageMs = Math.max(0, nowMs - overview.fetchedAtMs);
  return { ageMs, stale: ageMs > OVERVIEW_STALE_AFTER_MS };
}

/**
 * Sections with pending work, most urgent first: appeals outrank reports
 * (a suspended member is waiting), geofence conflicts last (estate health,
 * not a person in a queue). Stable within a count by section order.
 */
export function attentionOrder(
  counts: OverviewCounts,
): { section: ConsoleSection; pending: number }[] {
  const rows: { section: ConsoleSection; pending: number }[] = [
    { section: "appeals", pending: counts.appeals },
    { section: "moderation", pending: counts.reports },
    { section: "kyc", pending: counts.kycSessions + counts.kycReviews },
    { section: "onboarding", pending: counts.onboarding },
    { section: "elevation", pending: counts.elevation },
    { section: "geofences", pending: counts.geofenceConflicts },
  ];
  return rows
    .filter((row) => row.pending > 0)
    .sort((a, b) => b.pending - a.pending || rows.indexOf(a) - rows.indexOf(b));
}
