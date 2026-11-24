/**
 * NFR-29 + NFR-30: the power budget.
 *
 * NFR-29: foreground battery drain MUST be at most 2 %/h on the
 * reference mid-tier device. NFR-30: when background presence is off,
 * background battery use MUST be at parity with a no-op app — the only
 * honest way to promise parity is to do NOTHING in the background.
 *
 * As with the start-up budgets, the milli-percent figures can only be
 * confirmed on hardware; this module is the enforceable client-side
 * half. It pins the duty-cycle ledger: every energy consumer the app
 * registers, its cost, and the cadence-derived activation counts — the
 * publish activations are COMPUTED from the FR-85 power-mode intervals
 * (cross-imported, never duplicated), so a cadence change re-prices the
 * ledger automatically and a budget breach fails in CI.
 *
 * NFR-30 is structural: the background work registry is EMPTY when
 * background presence is off, by construction. Opting in registers
 * exactly one item — the BLE central wake already declared in app.json
 * (UIBackgroundModes: bluetooth-central; Android declares no background
 * location at all, ACCESS_BACKGROUND_LOCATION is blocked).
 *
 * Imports are pinned by tests/test_batch42.py: powerMode.js only.
 */

import { publishIntervalS, type PowerMode } from "./powerMode.js";

/** NFR-29: the foreground ceiling, in percent of battery per hour. */
export const FOREGROUND_BUDGET_PERCENT_PER_HOUR = 2;

/**
 * The ledger is kept in milli-percent per hour (1 % = 1000 mp) so the
 * arithmetic stays integer-clean. The ceiling is therefore 2000 mp/h.
 */
export const FOREGROUND_BUDGET_MP_PER_HOUR = FOREGROUND_BUDGET_PERCENT_PER_HOUR * 1000;

/**
 * Continuous consumers and their pinned allocations. These are budget
 * ceilings per consumer, not measurements — the audit enforces that
 * the plan fits, and the on-device profiling pass (the partial's named
 * gap) verifies reality against them.
 */
export const FIXED_CONSUMERS = [
  { consumer: "ble-advertise", milliPercentPerHour: 650 },
  { consumer: "ble-scan", milliPercentPerHour: 450 },
  { consumer: "ui-render", milliPercentPerHour: 400 },
] as const;

/** Cost of ONE presence publish (cell upload heartbeat), in mp. */
export const PUBLISH_COST_MP = 20;

/** Cost of ONE on-device cell computation feeding a publish, in mp. */
export const CELL_COMPUTE_COST_MP = 15;

/** Publish/cell activations per hour, derived from the FR-85 cadence. */
export function activationsPerHour(mode: PowerMode): number {
  return 3600 / publishIntervalS(mode);
}

/**
 * The total foreground drain for a power mode: fixed consumers plus the
 * cadence-derived publish and cell work. Reduced power mode is cheaper
 * by construction — half the activations — which is exactly the
 * trade-off the FR-85 notice describes.
 */
export function foregroundMilliPercentPerHour(mode: PowerMode): number {
  const fixed = FIXED_CONSUMERS.reduce((total, c) => total + c.milliPercentPerHour, 0);
  const perActivation = PUBLISH_COST_MP + CELL_COMPUTE_COST_MP;
  return fixed + activationsPerHour(mode) * perActivation;
}

/**
 * Budget audit, fail closed: a non-finite or negative total cannot pass,
 * and any total above the NFR-29 ceiling fails loudly.
 */
export function foregroundWithinBudget(mode: PowerMode): boolean {
  const total = foregroundMilliPercentPerHour(mode);
  if (!Number.isFinite(total) || total < 0) return false;
  return total <= FOREGROUND_BUDGET_MP_PER_HOUR;
}

/** The guard the app shell asserts: BOTH modes fit the NFR-29 ceiling. */
export function powerBudgetHonoursNfr29(): boolean {
  return foregroundWithinBudget("standard") && foregroundWithinBudget("reduced");
}

/**
 * NFR-30, structural half: the background work registry when background
 * presence is OFF. Empty by construction — parity with a no-op app is
 * achieved by doing nothing, not by doing little.
 */
export const BACKGROUND_WORK_WHEN_PRESENCE_OFF: readonly string[] = [];

/**
 * The single background consumer registered when the user opts in to
 * background presence: the BLE central wake (the only
 * UIBackgroundModes entry app.json declares).
 */
export const BACKGROUND_WORK_WHEN_PRESENCE_ON = ["ble-central-wake"] as const;

/**
 * The background work registry. Off means EMPTY — never a reduced set,
 * never a low-power variant: no work is the parity guarantee. Anything
 * but a literal true reads as off (fail closed).
 */
export function backgroundWorkSet(backgroundPresenceEnabled: boolean): readonly string[] {
  return backgroundPresenceEnabled === true
    ? BACKGROUND_WORK_WHEN_PRESENCE_ON
    : BACKGROUND_WORK_WHEN_PRESENCE_OFF;
}

/** The guard the app shell asserts on every backgrounding (with FR-19). */
export function backgroundParityHonoursNfr30(): boolean {
  return backgroundWorkSet(false).length === 0;
}
