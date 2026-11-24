/**
 * FR-19: presence is withdrawn within 60 seconds of the app entering the
 * background, unless the user has enabled background presence.
 *
 * This module is the decision contract the app lifecycle handler is held
 * to. It never touches a timer or the network itself — it turns a
 * visibility transition into the action the platform adapter must carry
 * out, with the deadline spelled out in the type so the guarantee is
 * impossible to lose between modules.
 *
 * The withdrawal wire target is DELETE /v1/presence (PRS-SRS-001 §5.2):
 * one authenticated call removes presence and cell membership server-side.
 * The deadline is the outer bound, not the schedule — the adapter fires
 * the withdrawal immediately on backgrounding; the 60 seconds exist to
 * bound platforms that defer the callback, and the unit tests pin the
 * constant so nobody can quietly relax the guarantee.
 *
 * FR-19 interacts with, but is not changed by, FR-85: reduced-power mode
 * lowers the publish cadence while the app is active; it never extends
 * the background-withdrawal deadline.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

/** FR-19: the withdrawal guarantee, in seconds. */
export const BACKGROUND_WITHDRAWAL_DEADLINE_S = 60;

/** App visibility as the platform reports it to the lifecycle handler. */
export type AppVisibility = "foreground" | "background";

/** The wire target a withdrawal maps to (PRS-SRS-001 §5.2). */
export const WITHDRAWAL_WIRE = {
  method: "DELETE",
  path: "/v1/presence",
} as const;

export type LifecycleAction =
  | {
      readonly action: "withdraw";
      readonly wire: typeof WITHDRAWAL_WIRE;
      /** FR-19: the withdrawal MUST complete within this many seconds. */
      readonly deadlineS: typeof BACKGROUND_WITHDRAWAL_DEADLINE_S;
    }
  | {
      readonly action: "remain";
      readonly reason: "background-presence-enabled";
    }
  | {
      /** Foreground return before a scheduled withdrawal fired — cancel it. */
      readonly action: "cancel-pending-withdrawal";
    }
  | { readonly action: "none" };

/**
 * Evaluate a visibility transition. `backgroundPresenceEnabled` is the
 * user's FR-19 opt-in: with it on, backgrounding keeps presence live
 * (the FR-14 heartbeat cadence continues to apply); with it off, the
 * withdrawal decision is unconditional.
 *
 * The function is total and never throws — a lifecycle callback is the
 * wrong place for an exception to strand a live presence.
 */
export function evaluateVisibilityChange(
  to: AppVisibility,
  opts: { readonly backgroundPresenceEnabled: boolean },
): LifecycleAction {
  if (to === "background") {
    if (opts.backgroundPresenceEnabled) {
      return { action: "remain", reason: "background-presence-enabled" };
    }
    return {
      action: "withdraw",
      wire: WITHDRAWAL_WIRE,
      deadlineS: BACKGROUND_WITHDRAWAL_DEADLINE_S,
    };
  }
  // Foreground: if a withdrawal was scheduled but the user came back
  // first, cancel it; republishing is a separate decision (cadence gate,
  // FR-85), not this module's call.
  return { action: "cancel-pending-withdrawal" };
}

/**
 * Compile-time intent made runtime-explicit: every withdrawal decision
 * carries the FR-19 deadline and the DELETE /v1/presence wire target.
 * The unit tests pin the guarantee through this guard.
 */
export function withdrawalHonoursFr19(action: LifecycleAction): boolean {
  if (action.action !== "withdraw") return true;
  return (
    action.deadlineS === 60 &&
    action.wire.method === "DELETE" &&
    action.wire.path === "/v1/presence"
  );
}
