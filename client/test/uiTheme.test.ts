/**
 * Theme contract tests (b47): the theme is derived from the audited
 * palette, so these tests pin the derivation — colours resolve, scales
 * clamp, motion gates, and garbage fails closed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_TARGET_PT,
  MOTION_DURATIONS_MS,
  SPACING_UNIT_PT,
  THEME_TONES,
  motionMs,
  spacing,
  textStyle,
  themeHonoursA11y,
} from "../src/presence/ui/theme.js";

test("every tone resolves a text style at both ends of the type range", () => {
  for (const tone of THEME_TONES) {
    const base = textStyle(tone, 1);
    const large = textStyle(tone, 2);
    assert.ok(base !== null, tone);
    assert.ok(large !== null, tone);
    assert.equal(large.fontSizePt, base.fontSizePt * 2);
  }
});

test("an unknown tone fails closed to null", () => {
  assert.equal(textStyle("no-such-tone", 1), null);
});

test("the dynamic-type preference clamps into [1, 2]; garbage is 1", () => {
  const note = textStyle("note", Number.NaN);
  assert.ok(note !== null);
  assert.equal(note.fontSizePt, 12); // unreadable preference → base size
  const triple = textStyle("note", 3);
  assert.ok(triple !== null);
  assert.equal(triple.fontSizePt, 24); // clamped to the 200 % WCAG floor
});

test("spacing is the 4 pt grid; off-grid fails closed", () => {
  assert.equal(SPACING_UNIT_PT, 4);
  assert.equal(spacing(3), 12);
  assert.equal(spacing(0), 0);
  assert.equal(spacing(2.5), null);
  assert.equal(spacing(-1), null);
  assert.equal(spacing(Number.NaN), null);
});

test("reduced motion zeroes every duration; unknown kinds are instant", () => {
  assert.equal(motionMs("fast", false), MOTION_DURATIONS_MS.fast);
  assert.equal(motionMs("standard", false), MOTION_DURATIONS_MS.standard);
  assert.equal(motionMs("fast", true), 0);
  assert.equal(motionMs("standard", true), 0);
  assert.equal(motionMs("no-such-kind", false), 0);
});

test("the action target floor is the pinned 44 pt", () => {
  assert.ok(ACTION_TARGET_PT.width >= 44);
  assert.ok(ACTION_TARGET_PT.height >= 44);
});

test("master guard: themeHonoursA11y", () => {
  assert.equal(themeHonoursA11y(), true);
});
