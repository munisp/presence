/**
 * FR-79: the offer window — expiry as a closing perimeter.
 *
 * Expiry of presence, offers, and conversations MUST be communicated as
 * a continuous perimeter or boundary that closes, and MUST NOT be shown
 * as a numeric countdown by default; a numeric form may exist only
 * behind an explicit user preference.
 *
 * This module is the presentation contract for that closing boundary.
 * The default render carries only a fraction — 1.0 with the full window
 * ahead, 0.0 when it closes — and `secondsRemaining` is physically null
 * unless the user explicitly opted into the numeric form, so a numeric
 * countdown cannot appear by accident: the default path never computes
 * one.
 *
 * The window length mirrors the server's FR-33 offer TTL
 * (services/edge/src/lifecycle.ts OFFER_TTL_MS); the equality is pinned
 * by tests/test_batch39.py so the perimeter the user watches close is
 * the perimeter the server enforces.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

/** FR-33: the offer window, mirror of services/edge OFFER_TTL_MS. */
export const OFFER_WINDOW_MS = 30 * 60 * 1000;

/** FR-79: the default presentation is the closing perimeter. */
export const DEFAULT_EXPIRY_PRESENTATION = "perimeter" as const;

export type ExpiryPresentation = "perimeter" | "numeric";

/** The user's expiry-display preference. Numeric is opt-in, never default. */
export interface ExpiryPreference {
  numericCountdown: boolean;
}

export const DEFAULT_EXPIRY_PREFERENCE: ExpiryPreference = {
  numericCountdown: false,
};

/**
 * Resolve the presentation from the preference. Anything other than an
 * explicit `numericCountdown: true` — including a missing or malformed
 * preference — resolves to the perimeter.
 */
export function expiryPresentation(
  preference: ExpiryPreference | null | undefined,
): ExpiryPresentation {
  return preference?.numericCountdown === true ? "numeric" : "perimeter";
}

/**
 * The fraction of the window still ahead: 1.0 just after surfacing,
 * 0.0 at expiry. Monotonic non-increasing in `nowMs`, clamped to 0..1;
 * a non-positive or invalid window fails closed to 0 (already closed).
 */
export function perimeterFractionRemaining(
  nowMs: number,
  expiresAtMs: number,
  windowMs: number,
): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;
  const remaining = expiresAtMs - nowMs;
  if (!Number.isFinite(remaining)) return 0;
  return Math.min(1, Math.max(0, remaining / windowMs));
}

/**
 * The offer-window presentation contract. `secondsRemaining` is null
 * unless the numeric form was explicitly opted into — the perimeter
 * render never carries a number.
 */
export interface OfferWindow {
  kind: "offer-window";
  presentation: ExpiryPresentation;
  /** 1 = full window ahead, 0 = closed. */
  fractionRemaining: number;
  /** Whole seconds remaining; null unless presentation is "numeric". */
  secondsRemaining: number | null;
}

/** Build the offer window for one expiring offer. */
export function buildOfferWindow(
  nowMs: number,
  expiresAtMs: number,
  windowMs: number,
  preference: ExpiryPreference | null | undefined,
): OfferWindow {
  const presentation = expiryPresentation(preference);
  return {
    kind: "offer-window",
    presentation,
    fractionRemaining: perimeterFractionRemaining(nowMs, expiresAtMs, windowMs),
    secondsRemaining:
      presentation === "numeric"
        ? Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000))
        : null,
  };
}
