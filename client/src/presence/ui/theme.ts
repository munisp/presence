/**
 * UI theme (b47) — the visual layer's single source of truth, DERIVED
 * from the accessibility contract rather than declared beside it.
 *
 * The discipline: this module contains no colour literal at all. Every
 * colour comes from CLIENT_PALETTE in ../accessibility.js, so the WCAG
 * audit (NFR-25) covers the theme by construction — a theme colour can
 * never drift from the audited palette because there is nothing here to
 * drift. Type sizes come from the palette entries and scale through the
 * pinned dynamic-type clamp; motion resolves through the pinned
 * reduced-motion plan; the touch-target floor is the pinned 44 pt.
 *
 * An unknown role, an unresolvable colour, or garbage geometry fails
 * closed to null — the renderer must not improvise a style.
 */

import {
  CLIENT_PALETTE,
  TOUCH_TARGET_MIN_PT,
  contrastRatio,
  dynamicTypeScale,
  motionPlan,
  paletteViolations,
  requiredContrast,
  type PaletteEntry,
} from "../accessibility.js";

/** The semantic tones a text node may wear — one per palette role. */
export const THEME_TONES = CLIENT_PALETTE.map((entry) => entry.role);

export type ThemeTone = (typeof THEME_TONES)[number];

/** Spacing grid: every gap is an integer multiple of 4 pt. */
export const SPACING_UNIT_PT = 4;

/** Motion durations in ms — gated to 0 by the reduced-motion plan. */
export const MOTION_DURATIONS_MS = {
  instant: 0,
  fast: 150,
  standard: 250,
} as const;

export type MotionKind = keyof typeof MOTION_DURATIONS_MS;

export interface TextStyle {
  color: string;
  backgroundColor: string;
  fontSizePt: number;
  bold: boolean;
}

function paletteEntry(role: string): PaletteEntry | null {
  const entry = CLIENT_PALETTE.find((candidate) => candidate.role === role);
  return entry ?? null;
}

/**
 * Resolve a text style for a tone at the user's dynamic-type
 * preference. The scale passes through the NFR-25 clamp ([1, 2],
 * garbage → 1), so an unreadable preference can never shrink text
 * below the audited base size. Unknown tones fail closed to null.
 */
export function textStyle(
  tone: string,
  preferredScale: number,
): TextStyle | null {
  const entry = paletteEntry(tone);
  if (entry === null) return null;
  const scale = dynamicTypeScale(preferredScale);
  const fontSizePt = entry.sizePt * scale;
  if (!Number.isFinite(fontSizePt) || fontSizePt <= 0) return null;
  return {
    color: entry.foreground,
    backgroundColor: entry.background,
    fontSizePt,
    bold: entry.bold,
  };
}

/**
 * Spacing in points: an integer multiple of the 4 pt unit. Non-integer
 * or negative multiples fail closed to null — off-grid spacing is a
 * defect, not a judgement call.
 */
export function spacing(multiple: number): number | null {
  if (!Number.isInteger(multiple) || multiple < 0) return null;
  return multiple * SPACING_UNIT_PT;
}

/**
 * Motion duration in ms. The reduced-motion plan (NFR-25) gates every
 * kind to instant; an unreadable preference is "reduce" by the pinned
 * fallback. Unknown kinds fail closed to 0 — no motion.
 */
export function motionMs(
  kind: string,
  prefersReducedMotion: boolean,
): number {
  const plan = motionPlan(prefersReducedMotion);
  if (!plan.animated) return MOTION_DURATIONS_MS.instant;
  if (!(kind in MOTION_DURATIONS_MS)) return MOTION_DURATIONS_MS.instant;
  return MOTION_DURATIONS_MS[kind as MotionKind];
}

/** The declared touch target every action renders at or above. */
export const ACTION_TARGET_PT = {
  width: TOUCH_TARGET_MIN_PT,
  height: TOUCH_TARGET_MIN_PT,
} as const;

/**
 * Master theme guard. Proves: the palette itself passes the NFR-25
 * audit; every tone resolves at both ends of the dynamic-type range;
 * every tone keeps its required contrast after scaling (contrast is
 * scale-invariant, so this re-check is about the resolution path, not
 * the arithmetic); the target floor is the pinned 44 pt; and reduced
 * motion zeroes every duration while the animated plan keeps the
 * standard duration non-zero. A deliberately unknown tone must fail —
 * otherwise the guard proves nothing.
 */
export function themeHonoursA11y(): boolean {
  if (paletteViolations(CLIENT_PALETTE).length > 0) return false;
  for (const tone of THEME_TONES) {
    const entry = paletteEntry(tone);
    if (entry === null) return false;
    const ratio = contrastRatio(entry.foreground, entry.background);
    if (ratio === null || ratio < requiredContrast(entry)) return false;
    if (textStyle(tone, 1) === null) return false;
    if (textStyle(tone, 2) === null) return false;
  }
  if (ACTION_TARGET_PT.width < TOUCH_TARGET_MIN_PT) return false;
  if (ACTION_TARGET_PT.height < TOUCH_TARGET_MIN_PT) return false;
  if (motionMs("standard", true) !== 0) return false;
  if (motionMs("standard", false) !== MOTION_DURATIONS_MS.standard) return false;
  if (motionMs("no-such-kind", false) !== 0) return false;
  return textStyle("no-such-tone", 1) === null;
}
