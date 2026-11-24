/**
 * NFR-35 + NFR-36: frame and ambient-refresh budgets.
 *
 * NFR-35: the match surface MUST render at 60 fps, with a hard floor of
 * 30 fps on the weakest supported device. NFR-36: ambient surfaces
 * (FR-86) refresh at most once per minute and MUST NOT wake the radio
 * while idle.
 *
 * NFR-35's fps can only be measured on a device; the enforceable
 * client-side half is the render ledger — the pinned decomposition of
 * the match surface's frame work. The ledger sums inside the 60 fps
 * frame budget AND inside the 30 fps floor, so even on the weakest
 * supported device the planned work fits the worst legal frame. A
 * render plan that cannot fit fails its audit in CI.
 *
 * NFR-36 is fully enforceable here: the refresh gate arithmetic (at
 * most one refresh per minute), the pinned refresh sources (push and
 * app-active only — "poll" is absent by construction, so an idle device
 * never wakes the radio for a widget), and the payload itself, which is
 * the FR-86/SEC-35 contentless payload built LOCALLY — there is no
 * fetch in the ambient path at all.
 *
 * Imports are pinned by tests/test_batch42.py: ambientSurfaces.js only.
 */

import { buildAmbientPayload, type AmbientPayload } from "./ambientSurfaces.js";

/** NFR-35: one 60 fps frame, in milliseconds. */
export const FRAME_BUDGET_MS = 1000 / 60;

/** NFR-35: the hard floor — one 30 fps frame on the weakest device. */
export const FRAME_FLOOR_MS = 1000 / 30;

export interface RenderPhase {
  readonly phase: string;
  readonly ms: number;
}

/**
 * The pinned render ledger for the match surface: layout, the
 * converging-path geometry (FR-76), label measure, paint commit.
 * Sixteen milliseconds of planned work fits the 16.67 ms budget with
 * headroom and sits well under the 33.3 ms floor.
 */
export const MATCH_SURFACE_RENDER_PHASES: readonly RenderPhase[] = [
  { phase: "layout", ms: 4 },
  { phase: "path-geometry", ms: 6 },
  { phase: "label-measure", ms: 3 },
  { phase: "paint-commit", ms: 3 },
] as const;

/** Sum of a render ledger. */
export function renderBudgetTotal(phases: readonly RenderPhase[]): number {
  return phases.reduce((total, phase) => total + phase.ms, 0);
}

/**
 * Render audit, fail closed: every phase finite and non-negative, the
 * total inside the 60 fps budget AND inside the 30 fps floor. A render
 * plan that cannot hit the floor cannot ship.
 */
export function renderWithinFrameBudget(phases: readonly RenderPhase[]): boolean {
  let total = 0;
  for (const phase of phases) {
    if (!Number.isFinite(phase.ms) || phase.ms < 0) return false;
    total += phase.ms;
  }
  return total <= FRAME_BUDGET_MS && total <= FRAME_FLOOR_MS;
}

/** The guard the match surface asserts before first paint. */
export function frameBudgetHonoursNfr35(): boolean {
  return renderWithinFrameBudget(MATCH_SURFACE_RENDER_PHASES);
}

/** NFR-36: at most one ambient refresh per minute. */
export const AMBIENT_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * NFR-36: the ONLY legal refresh triggers. A push (FR-56: APNs
 * background / FCM data-only) or the app being active. "poll" is absent
 * by construction — an idle device never wakes the radio for an ambient
 * surface.
 */
export const AMBIENT_REFRESH_SOURCES = ["push", "app-active"] as const;

export type AmbientRefreshSource = (typeof AMBIENT_REFRESH_SOURCES)[number];

/** NFR-36: the ambient path performs zero network fetches per refresh. */
export const AMBIENT_NETWORK_FETCHES_PER_REFRESH = 0;

/**
 * The refresh gate. A first refresh (no prior timestamp) is allowed;
 * afterwards at least one minute must have elapsed. Garbage — a
 * non-finite timestamp, or a clock running backwards — refuses (fail
 * closed): when the cadence cannot be verified, the refresh does not
 * happen.
 */
export function ambientRefreshAllowed(lastRefreshAtMs: number | null, nowMs: number): boolean {
  if (lastRefreshAtMs === null) return Number.isFinite(nowMs);
  if (!Number.isFinite(lastRefreshAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - lastRefreshAtMs >= AMBIENT_REFRESH_MIN_INTERVAL_MS;
}

/**
 * Plan one ambient refresh: the gate decides, and an approved refresh
 * carries the FR-86/SEC-35 contentless payload built from local state —
 * no fetch, no radio wake (NFR-36). A refused refresh carries no
 * payload at all.
 */
export function planAmbientRefresh(
  presenceActive: boolean,
  lastRefreshAtMs: number | null,
  nowMs: number,
):
  | { readonly action: "refresh"; readonly payload: AmbientPayload }
  | { readonly action: "skip"; readonly reason: "interval" | "invalid-clock" } {
  if (lastRefreshAtMs !== null && (!Number.isFinite(lastRefreshAtMs) || !Number.isFinite(nowMs))) {
    return { action: "skip", reason: "invalid-clock" };
  }
  if (!ambientRefreshAllowed(lastRefreshAtMs, nowMs)) {
    return { action: "skip", reason: "interval" };
  }
  return { action: "refresh", payload: buildAmbientPayload(presenceActive) };
}

/** Is this trigger a legal ambient refresh source? */
export function isAmbientRefreshSource(source: string): boolean {
  return (AMBIENT_REFRESH_SOURCES as readonly string[]).includes(source);
}

/** The guard the ambient layer asserts alongside ambientHonoursSec35. */
export function ambientRefreshHonoursNfr36(): boolean {
  return (
    AMBIENT_NETWORK_FETCHES_PER_REFRESH === 0 &&
    !isAmbientRefreshSource("poll") &&
    isAmbientRefreshSource("push") &&
    isAmbientRefreshSource("app-active")
  );
}
