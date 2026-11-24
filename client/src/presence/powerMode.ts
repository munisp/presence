/**
 * FR-85: reduced-power presence mode.
 *
 * The user MUST be able to select a reduced-power mode that publishes no
 * more than once every ten minutes, with a visible indication that
 * matches will be less timely. This module is the contract for that
 * mode: the cadence constants, the pinned notice, and the pure scheduler
 * arithmetic the surfaces drive their timers from.
 *
 * The cadence ceiling interacts with the server's FR-14 session TTL
 * (900 s, services/edge/src/routes/presence.ts PRESENCE_TTL_S): both the
 * standard and reduced intervals stay strictly below it, so a healthy
 * heartbeat stream never lets presence lapse — the reduced interval
 * leaves a 300-second margin in which a failed publish can retry before
 * the session expires.
 *
 * FR-85 governs cadence while the app is active; it does not extend the
 * FR-19 background-withdrawal deadline, which applies in every power
 * mode unless the user separately enabled background presence.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

export type PowerMode = "standard" | "reduced";

export const POWER_MODES: readonly PowerMode[] = ["standard", "reduced"];

/**
 * Standard cadence: one publish every five minutes. Chosen to match the
 * FR-92 stabilisation window — each publish carries a fully settled
 * modal cell — and to give three heartbeats per FR-14 TTL.
 */
export const STANDARD_PUBLISH_INTERVAL_S = 5 * 60;

/**
 * FR-85: reduced mode publishes "no more than once every ten minutes" —
 * the interval IS the ceiling, so it is exactly ten minutes.
 */
export const REDUCED_PUBLISH_INTERVAL_S = 10 * 60;

/**
 * FR-14 (server): presence sessions live 900 s. Both intervals must stay
 * strictly below this so presence cannot lapse between healthy
 * heartbeats; pinned by the unit tests so a future cadence change fails
 * loudly instead of silently expiring users.
 */
export const PRESENCE_SESSION_TTL_S = 900;

/**
 * FR-85's visible indication, pinned so every surface renders the same
 * trade-off notice when reduced mode is selected.
 */
export const REDUCED_POWER_NOTICE =
  "Reduced power is on — you will appear to others more slowly and new matches may take longer to arrive.";

/** Labels + trade-off copy for the power-mode selector surface. */
export const POWER_MODE_PRESENTATION: Readonly<
  Record<PowerMode, { readonly label: string; readonly detail: string }>
> = {
  standard: {
    label: "Standard",
    detail: "Publishes about every five minutes while you are out.",
  },
  reduced: {
    label: "Reduced power",
    detail: REDUCED_POWER_NOTICE,
  },
};

/** The publish interval for a mode, in seconds. */
export function publishIntervalS(mode: PowerMode): number {
  return mode === "reduced" ? REDUCED_PUBLISH_INTERVAL_S : STANDARD_PUBLISH_INTERVAL_S;
}

/**
 * Scheduler arithmetic: is a publish due at `nowMs`, given the last
 * publish at `lastPublishAtMs`? A missing last publish means one is due
 * immediately (fresh session). Timestamps are injected so the tests are
 * deterministic.
 */
export function isPublishDue(mode: PowerMode, lastPublishAtMs: number | null, nowMs: number): boolean {
  if (lastPublishAtMs === null) return true;
  return nowMs - lastPublishAtMs >= publishIntervalS(mode) * 1000;
}

/** When the next publish falls due after `lastPublishAtMs` (epoch ms). */
export function nextPublishDueAtMs(mode: PowerMode, lastPublishAtMs: number): number {
  return lastPublishAtMs + publishIntervalS(mode) * 1000;
}

/**
 * Mode switches apply to the NEXT publish: dropping to reduced stretches
 * the interval from the last publish (never publishes early), and
 * returning to standard shortens it (a publish can be due immediately).
 * This is just isPublishDue evaluated under the new mode — pinned so the
 * surfaces cannot invent their own switch semantics.
 */
export function isPublishDueAfterSwitch(
  newMode: PowerMode,
  lastPublishAtMs: number | null,
  nowMs: number,
): boolean {
  return isPublishDue(newMode, lastPublishAtMs, nowMs);
}
