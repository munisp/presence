/**
 * NFR-25 + NFR-26 + NFR-37: the accessibility contract.
 *
 * NFR-25: the client MUST conform to WCAG 2.2 AA — contrast, dynamic
 * type, screen-reader labelling, focus order, reduced-motion respect.
 * NFR-26: every interactive control MUST have a touch target of at
 * least 44 × 44 pt. NFR-37: the primary action on every screen MUST be
 * reachable one-handed on a 6.1-inch device, within the lower 40 percent
 * of the display.
 *
 * What is enforceable without a device lands here as pure functions and
 * pinned constants:
 *
 *   1. Contrast — {@link contrastRatio} is the WCAG relative-luminance
 *      formula, and {@link CLIENT_PALETTE} pins every colour pair the
 *      shell uses against its role. {@link paletteViolations} fails any
 *      pair below its required ratio (4.5:1 normal text, 3:1 large text
 *      and non-text). Unparseable colours fail closed.
 *   2. Dynamic type — {@link TEXT_SCALE_MAX_SUPPORTED} pins 200 % text
 *      scaling (the WCAG resize floor); {@link dynamicTypeScale} clamps
 *      the OS preference into [1, 2] and fails closed to 1 on garbage.
 *   3. Reduced motion — {@link motionPlan} replaces animation with an
 *      instant state change whenever the preference is set, and treats
 *      an unreadable preference as "reduce" (fail closed toward less
 *      motion).
 *   4. Labelling, focus, targets — every interactive control is a
 *      {@link ControlDescriptor}; {@link controlViolations} requires a
 *      non-empty label, a registered role, a 44 × 44 pt target, and a
 *      unique non-negative focus order. Smaller visual glyphs are legal
 *      only when the declared target (not the glyph) meets the floor.
 *   5. One-handed reach — {@link primaryActionInReachZone} refuses a
 *      primary action whose top edge sits above the lower-40 % line of
 *      the display ({@link PRIMARY_ACTION_ZONE_MIN_FRACTION}).
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

/** NFR-26: the minimum interactive target, in points, per dimension. */
export const TOUCH_TARGET_MIN_PT = 44;

/** WCAG 2.2 AA contrast floors. */
export const CONTRAST_TEXT_NORMAL_MIN = 4.5;
export const CONTRAST_TEXT_LARGE_MIN = 3.0;
export const CONTRAST_NON_TEXT_MIN = 3.0;

/** WCAG "large text": ≥ 18 pt, or ≥ 14 pt when bold. */
export const LARGE_TEXT_MIN_PT = 18;
export const LARGE_TEXT_BOLD_MIN_PT = 14;

/** WCAG 2.2 AA resize floor: text must remain usable at 200 %. */
export const TEXT_SCALE_MAX_SUPPORTED = 2;

/** NFR-37: the primary action lives in the lower 40 % of the display. */
export const PRIMARY_ACTION_ZONE_MIN_FRACTION = 0.6;

/** NFR-37: the reference one-handed device (6.1-inch class, 844 pt tall). */
export const REACH_REFERENCE_DEVICE = {
  name: "6.1-inch",
  logicalHeightPt: 844,
} as const;

/** One pinned colour usage in the client shell. */
export interface PaletteEntry {
  role: string;
  foreground: string;
  background: string;
  sizePt: number;
  bold: boolean;
  nonText?: boolean;
}

/**
 * The shell palette — every colour pair App.tsx renders, pinned so the
 * audit cannot drift from the code. The note colour is #74879B: the
 * earlier #5C6B77 measured 3.50:1 against the shell background, below
 * the 4.5:1 floor for 12 pt text — this contract caught it and the
 * colour moved.
 */
export const CLIENT_PALETTE: readonly PaletteEntry[] = [
  {
    role: "title",
    foreground: "#F2F5F7",
    background: "#0B0F14",
    sizePt: 34,
    bold: true,
  },
  {
    role: "subtitle",
    foreground: "#9FB0BC",
    background: "#0B0F14",
    sizePt: 16,
    bold: false,
  },
  {
    role: "note",
    foreground: "#74879B",
    background: "#0B0F14",
    sizePt: 12,
    bold: false,
  },
];

function channel(hex: string, offset: number): number | null {
  const value = parseInt(hex.slice(offset, offset + 2), 16);
  if (Number.isNaN(value)) return null;
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance of a #RRGGBB colour, or null when the input
 * is not exactly that shape — garbage fails closed downstream.
 */
export function relativeLuminance(hex: string): number | null {
  if (typeof hex !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  const r = channel(hex, 1);
  const g = channel(hex, 3);
  const b = channel(hex, 5);
  if (r === null || g === null || b === null) return null;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two #RRGGBB colours (1–21), or null when
 * either colour is unparseable. Callers treat null as a violation.
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const lf = relativeLuminance(foreground);
  const lb = relativeLuminance(background);
  if (lf === null || lb === null) return null;
  const lo = Math.min(lf, lb);
  const hi = Math.max(lf, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** The contrast a palette entry must reach under WCAG 2.2 AA. */
export function requiredContrast(entry: PaletteEntry): number {
  if (entry.nonText === true) return CONTRAST_NON_TEXT_MIN;
  const large =
    entry.sizePt >= LARGE_TEXT_MIN_PT ||
    (entry.bold === true && entry.sizePt >= LARGE_TEXT_BOLD_MIN_PT);
  return large ? CONTRAST_TEXT_LARGE_MIN : CONTRAST_TEXT_NORMAL_MIN;
}

/**
 * Audit a palette: every entry must meet its required ratio. The
 * returned strings name the failing roles; an empty result passes.
 */
export function paletteViolations(palette: readonly PaletteEntry[]): string[] {
  const violations: string[] = [];
  for (const entry of palette) {
    const ratio = contrastRatio(entry.foreground, entry.background);
    if (ratio === null || ratio < requiredContrast(entry)) {
      violations.push(entry.role);
    }
  }
  return violations;
}

/** NFR-25 contrast, pinned against the shell palette. */
export function paletteHonoursNfr25(): boolean {
  return paletteViolations(CLIENT_PALETTE).length === 0;
}

/**
 * Dynamic type: clamp the OS text-scale preference into the supported
 * range. The WCAG floor is 200 %, so the ceiling is 2; an unreadable
 * preference fails closed to 1 (no scaling) rather than guessing.
 */
export function dynamicTypeScale(preferredScale: number): number {
  if (typeof preferredScale !== "number" || !Number.isFinite(preferredScale)) {
    return 1;
  }
  if (preferredScale < 1) return 1;
  if (preferredScale > TEXT_SCALE_MAX_SUPPORTED) return TEXT_SCALE_MAX_SUPPORTED;
  return preferredScale;
}

/** The reduced-motion replacement: no animation, an instant state change. */
export const REDUCED_MOTION_FALLBACK = "instant" as const;

export interface MotionPlan {
  animated: boolean;
  fallback: typeof REDUCED_MOTION_FALLBACK | null;
}

/**
 * Reduced-motion respect: when the preference is set — or unreadable —
 * the plan is instant, never animated. Motion is the thing that must
 * justify itself, so garbage fails toward less motion.
 */
export function motionPlan(prefersReducedMotion: boolean): MotionPlan {
  if (prefersReducedMotion === true) {
    return { animated: false, fallback: REDUCED_MOTION_FALLBACK };
  }
  if (prefersReducedMotion === false) {
    return { animated: true, fallback: null };
  }
  return { animated: false, fallback: REDUCED_MOTION_FALLBACK };
}

/** The roles a control may declare for the screen reader. */
export const CONTROL_ROLES = [
  "button",
  "link",
  "tab",
  "toggle",
  "input",
  "list-item",
] as const;

export type ControlRole = (typeof CONTROL_ROLES)[number];

/** One interactive control, as the native layer needs to render it. */
export interface ControlDescriptor {
  id: string;
  /** Screen-reader label — required, non-empty. */
  label: string;
  role: ControlRole;
  /** The DECLARED touch target in points — glyph size is irrelevant. */
  targetPt: { width: number; height: number };
  /** Position in the focus order; must be unique and non-negative. */
  focusOrder: number;
}

function validTarget(target: { width: number; height: number }): boolean {
  return (
    Number.isFinite(target.width) &&
    Number.isFinite(target.height) &&
    target.width >= TOUCH_TARGET_MIN_PT &&
    target.height >= TOUCH_TARGET_MIN_PT
  );
}

/**
 * NFR-25/NFR-26 audit of one control: label present, role registered,
 * target at least 44 × 44 pt, focus order a non-negative integer.
 */
export function controlViolations(control: ControlDescriptor): string[] {
  const violations: string[] = [];
  if (typeof control.label !== "string" || control.label.trim().length === 0) {
    violations.push("label");
  }
  if (!(CONTROL_ROLES as readonly string[]).includes(control.role)) {
    violations.push("role");
  }
  if (!validTarget(control.targetPt)) violations.push("target");
  if (
    !Number.isInteger(control.focusOrder) ||
    (control.focusOrder as number) < 0
  ) {
    violations.push("focus-order");
  }
  return violations;
}

/**
 * Focus-order audit across a surface: every control passes individually
 * and no two controls share a focus position (an ambiguous order is a
 * violation even when each number looks valid alone).
 */
export function controlsViolations(
  controls: readonly ControlDescriptor[],
): string[] {
  const violations: string[] = [];
  const seen = new Set<number>();
  for (const control of controls) {
    for (const violation of controlViolations(control)) {
      violations.push(`${control.id}:${violation}`);
    }
    if (seen.has(control.focusOrder)) {
      violations.push(`${control.id}:focus-order-duplicate`);
    }
    seen.add(control.focusOrder);
  }
  return violations;
}

/**
 * NFR-37: the primary action is reachable one-handed when its top edge
 * sits at or below the lower-40 % line of the display. Garbage geometry
 * fails closed — an unmeasurable action is out of reach by definition.
 */
export function primaryActionInReachZone(
  actionTopPt: number,
  screenHeightPt: number,
): boolean {
  if (
    !Number.isFinite(actionTopPt) ||
    !Number.isFinite(screenHeightPt) ||
    screenHeightPt <= 0 ||
    actionTopPt < 0 ||
    actionTopPt > screenHeightPt
  ) {
    return false;
  }
  return actionTopPt / screenHeightPt >= PRIMARY_ACTION_ZONE_MIN_FRACTION;
}

/** The y coordinate where the one-handed reach zone begins, in points. */
export function reachZoneTopPt(screenHeightPt: number): number {
  return screenHeightPt * PRIMARY_ACTION_ZONE_MIN_FRACTION;
}

/**
 * The master guard the shell asserts: palette contrast, 200 % dynamic
 * type, the pinned reduced-motion fallback, the 44 pt target floor, and
 * the lower-40 % reach zone are all in force.
 */
export function accessibilityHonoursNfr25Nfr26Nfr37(): boolean {
  return (
    paletteHonoursNfr25() &&
    TEXT_SCALE_MAX_SUPPORTED >= 2 &&
    REDUCED_MOTION_FALLBACK === "instant" &&
    TOUCH_TARGET_MIN_PT === 44 &&
    PRIMARY_ACTION_ZONE_MIN_FRACTION === 0.6 &&
    REACH_REFERENCE_DEVICE.logicalHeightPt === 844
  );
}
