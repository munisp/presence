/**
 * AMD-INN-05: duress mode — a panic gesture the platform must honour
 * entirely on-device. There is no server route and no server round-trip in
 * the critical path: under coercion the network may be watched, slow, or
 * cut. The pipeline is pinned and ordered:
 *
 *   1. withdraw-presence — stop broadcasting (best effort, fire-and-forget)
 *   2. wipe-local-state — the TR-30 allowlist wipe, by construction complete
 *   3. neutral-screen — replace the UI with an innocuous surface
 *
 * Every step runs even if an earlier one fails; the caller gets the
 * per-step record. This module imports ONLY ./localState.js — the wipe is
 * the allowlist wipe, so a new allowlisted key joins the duress wipe
 * automatically.
 */

import { clearLocalState, KeyValueBackend } from "./localState.js";

/** The pinned, ordered pipeline — order is the contract. */
export const DURESS_PIPELINE = [
  "withdraw-presence",
  "wipe-local-state",
  "neutral-screen",
] as const;

export type DuressStep = (typeof DURESS_PIPELINE)[number];

export interface DuressStepResult {
  step: DuressStep;
  ok: boolean;
}

export interface DuressDeps {
  /** Best-effort presence withdrawal (DELETE the live intent/session). */
  withdrawPresence: () => Promise<void>;
  /** Show the innocuous surface (calculator, notes, …). */
  showNeutralScreen: () => void;
}

/** Read the plan without executing it — the UI preview and tests pin it. */
export function planDuressExit(): readonly DuressStep[] {
  return DURESS_PIPELINE;
}

/**
 * Execute the pipeline in order. Best effort per step: a rejected
 * withdrawal (offline) must not block the wipe, and the wipe must not
 * block the neutral screen.
 */
export async function executeDuressExit(
  backend: KeyValueBackend,
  deps: DuressDeps,
): Promise<DuressStepResult[]> {
  const results: DuressStepResult[] = [];
  try {
    await deps.withdrawPresence();
    results.push({ step: "withdraw-presence", ok: true });
  } catch {
    results.push({ step: "withdraw-presence", ok: false });
  }
  try {
    await clearLocalState(backend);
    results.push({ step: "wipe-local-state", ok: true });
  } catch {
    results.push({ step: "wipe-local-state", ok: false });
  }
  try {
    deps.showNeutralScreen();
    results.push({ step: "neutral-screen", ok: true });
  } catch {
    results.push({ step: "neutral-screen", ok: false });
  }
  return results;
}
