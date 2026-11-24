/**
 * NFR-04 + NFR-05: start-up budgets.
 *
 * NFR-04: cold start to interactive MUST be at most 1.8 seconds on the
 * reference mid-tier device. NFR-05: warm start (process alive, return
 * to foreground) MUST be at most 600 ms.
 *
 * A wall-clock figure can only be measured on a device, so this module
 * is the client-side half of the requirement: the pinned phase ledger
 * every cold and warm start must fit into, and the list of work that is
 * BANNED from the critical path. A start-up plan whose allocations
 * exceed the budget — or that pulls deferred work onto the critical
 * path — fails its audit here, loudly, in CI, before it can ship.
 *
 * The phase table is the contract surfaces drive their splash and
 * skeleton timing from: cold start pays for native init, the JS bundle,
 * the secure-store read (TR-30 refresh token), the cached client-config
 * read (TR-33 — the network revalidation happens AFTER interactive),
 * the first render, and the handoff to interactive. Warm start reuses
 * the resident native runtime and JS bundle, so those phases cost zero
 * and the whole resume must fit in 600 ms.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

/** NFR-04: cold start to interactive, milliseconds. */
export const COLD_START_BUDGET_MS = 1800;

/** NFR-05: warm start to interactive, milliseconds. */
export const WARM_START_BUDGET_MS = 600;

export type StartupMode = "cold" | "warm";

export interface StartupPhase {
  readonly phase: string;
  readonly coldMs: number;
  readonly warmMs: number;
}

/**
 * The pinned critical-path ledger. Allocations sum to exactly the two
 * budgets — the budget is a ceiling, so the ledger is the strongest
 * statement the contract can make: this is what a compliant start-up
 * looks like, and any phase that overruns its line breaks the total.
 *
 * Warm start pays nothing for native-init or js-bundle-load: the
 * process and its bundle are resident by definition (NFR-05).
 */
export const STARTUP_PHASES: readonly StartupPhase[] = [
  { phase: "native-init", coldMs: 350, warmMs: 0 },
  { phase: "js-bundle-load", coldMs: 550, warmMs: 0 },
  { phase: "secure-store-read", coldMs: 150, warmMs: 50 },
  { phase: "config-cache-read", coldMs: 100, warmMs: 40 },
  { phase: "first-render", coldMs: 500, warmMs: 380 },
  { phase: "interactive-handoff", coldMs: 150, warmMs: 130 },
] as const;

/**
 * Work that MUST NOT run before interactive. BLE start, taxonomy
 * prefetch, analytics flush, ambient-widget sync and push-token
 * refresh all wait for the post-interactive queue — they are how the
 * cold path stays inside 1.8 s. Pinned so a well-meaning "just warm it
 * up early" change fails the audit instead of silently taxing every
 * start-up.
 */
export const DEFERRED_UNTIL_INTERACTIVE = [
  "ble-advertising-start",
  "ble-scan-start",
  "taxonomy-prefetch",
  "analytics-flush",
  "ambient-widget-sync",
  "push-token-refresh",
] as const;

export type DeferredWork = (typeof DEFERRED_UNTIL_INTERACTIVE)[number];

/** Sum of one mode's allocations across a phase ledger. */
export function phaseTotal(phases: readonly StartupPhase[], mode: StartupMode): number {
  return phases.reduce((total, phase) => total + (mode === "cold" ? phase.coldMs : phase.warmMs), 0);
}

/** The budget for a mode. */
export function startupBudgetMs(mode: StartupMode): number {
  return mode === "cold" ? COLD_START_BUDGET_MS : WARM_START_BUDGET_MS;
}

/**
 * Budget audit, fail closed: every allocation finite and non-negative,
 * no warm phase dearer than its cold twin (a warm start never does MORE
 * work than a cold one for the same phase), and both totals inside the
 * NFR-04/NFR-05 ceilings. Any violation returns false — a start-up
 * plan that cannot be budgeted cannot ship.
 */
export function startupWithinBudget(phases: readonly StartupPhase[]): boolean {
  for (const phase of phases) {
    if (!Number.isFinite(phase.coldMs) || !Number.isFinite(phase.warmMs)) return false;
    if (phase.coldMs < 0 || phase.warmMs < 0) return false;
    if (phase.warmMs > phase.coldMs) return false;
  }
  return (
    phaseTotal(phases, "cold") <= COLD_START_BUDGET_MS &&
    phaseTotal(phases, "warm") <= WARM_START_BUDGET_MS
  );
}

/** Is this work item on the deferred (post-interactive) list? */
export function isDeferredUntilInteractive(workId: string): boolean {
  return (DEFERRED_UNTIL_INTERACTIVE as readonly string[]).includes(workId);
}

/**
 * The anti-regression guard: no deferred work item may appear as a
 * critical-path phase. Runs in the unit tests over the pinned tables.
 */
export function deferredWorkStaysOffCriticalPath(
  phases: readonly StartupPhase[] = STARTUP_PHASES,
): boolean {
  return phases.every((phase) => !isDeferredUntilInteractive(phase.phase));
}

/** The guard the app shell asserts on boot. */
export function startupBudgetHonoursNfr04Nfr05(): boolean {
  return startupWithinBudget(STARTUP_PHASES) && deferredWorkStaysOffCriticalPath();
}

/** The startup plan descriptor surfaces drive splash/skeleton timing from. */
export function planStartup(mode: StartupMode): {
  readonly mode: StartupMode;
  readonly budgetMs: number;
  readonly phases: readonly StartupPhase[];
} {
  return { mode, budgetMs: startupBudgetMs(mode), phases: STARTUP_PHASES };
}
