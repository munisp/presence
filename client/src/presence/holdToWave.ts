/**
 * FR-82: hold-to-wave — the consent gesture that cannot fire by accident.
 *
 * Waving MUST require a sustained press of at least 400 milliseconds
 * with progressive feedback, and MUST NOT be triggered by a single tap.
 * The press MAY be cancelled by releasing early or by moving off the
 * control.
 *
 * The gesture is modelled as pure functions over the press duration so
 * the unit tests can drive every path under plain node --test:
 *
 *   - {@link waveProgress} maps held time to a 0..1 ramp — the
 *     progressive feedback the requirement demands. It is clamped and
 *     fails closed (garbage input reads as no press at all).
 *   - {@link rampStage} quarters the ramp for the haptic stage the
 *     native layer plays under the finger; it is monotonic
 *     non-decreasing in held time, so the ramp never runs backwards.
 *   - {@link evaluatePress} is the arbiter: "wave" exists only at or
 *     beyond {@link WAVE_PRESS_MIN_MS}. A release before the threshold
 *     is a cancellation, not a wave; leaving the control is a
 *     cancellation at any duration; a single tap — any duration under
 *     400 ms, pressed and released — can never produce "wave".
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test. No network, no platform APIs.
 */

/** FR-82: the minimum sustained press, in milliseconds. */
export const WAVE_PRESS_MIN_MS = 400;

/** FR-82: the two cancellation paths the requirement permits. */
export const WAVE_CANCEL_PATHS = ["early-release", "off-control"] as const;

/** The outcome of evaluating a press at a moment in time. */
export type WaveOutcome =
  | "pressing"
  | "wave"
  | "cancelled-early-release"
  | "cancelled-off-control";

/**
 * FR-82 progressive feedback: fraction of the required press completed,
 * clamped to 0..1. NaN, negative, and infinite input fail closed to 0 —
 * a broken clock reads as no press, never as a completed one.
 */
export function waveProgress(heldMs: number): number {
  if (!Number.isFinite(heldMs) || heldMs <= 0) return 0;
  return Math.min(1, heldMs / WAVE_PRESS_MIN_MS);
}

/**
 * The haptic ramp stage (0..3) under the finger — quarters of the
 * required press. Monotonic non-decreasing in held time; the full
 * duration maps to stage 3, never beyond.
 */
export function rampStage(heldMs: number): 0 | 1 | 2 | 3 {
  const progress = waveProgress(heldMs);
  if (progress < 0.25) return 0;
  if (progress < 0.5) return 1;
  if (progress < 0.75) return 2;
  return 3;
}

/**
 * FR-82 arbiter. The order of the checks is the semantics: leaving the
 * control cancels at ANY duration (even past the threshold — the wave
 * belongs to a finger still on the control); an early release cancels;
 * only a completed, on-control press waves.
 */
export function evaluatePress(
  heldMs: number,
  released: boolean,
  onControl: boolean,
): WaveOutcome {
  if (!onControl) return "cancelled-off-control";
  if (!Number.isFinite(heldMs) || heldMs < WAVE_PRESS_MIN_MS) {
    return released ? "cancelled-early-release" : "pressing";
  }
  return "wave";
}

/**
 * FR-82 single-tap guard: no duration below the threshold can wave,
 * whether the tap is still held or already released.
 */
export function tapCannotWave(durationMs: number): boolean {
  return (
    evaluatePress(durationMs, false, true) !== "wave" &&
    evaluatePress(durationMs, true, true) !== "wave"
  );
}
