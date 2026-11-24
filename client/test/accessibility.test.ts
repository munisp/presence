/** NFR-25/26/37: WCAG 2.2 AA contrast, targets, labels, reach — pinned and audited. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLIENT_PALETTE,
  CONTRAST_NON_TEXT_MIN,
  CONTRAST_TEXT_LARGE_MIN,
  CONTRAST_TEXT_NORMAL_MIN,
  CONTROL_ROLES,
  PRIMARY_ACTION_ZONE_MIN_FRACTION,
  REACH_REFERENCE_DEVICE,
  REDUCED_MOTION_FALLBACK,
  TEXT_SCALE_MAX_SUPPORTED,
  TOUCH_TARGET_MIN_PT,
  accessibilityHonoursNfr25Nfr26Nfr37,
  contrastRatio,
  controlsViolations,
  dynamicTypeScale,
  motionPlan,
  paletteHonoursNfr25,
  paletteViolations,
  primaryActionInReachZone,
  reachZoneTopPt,
  relativeLuminance,
  requiredContrast,
  type ControlDescriptor,
  type PaletteEntry,
} from "../src/presence/accessibility.js";

test("the WCAG floors and the NFR-26 target are pinned", () => {
  assert.equal(TOUCH_TARGET_MIN_PT, 44);
  assert.equal(CONTRAST_TEXT_NORMAL_MIN, 4.5);
  assert.equal(CONTRAST_TEXT_LARGE_MIN, 3.0);
  assert.equal(CONTRAST_NON_TEXT_MIN, 3.0);
  assert.equal(TEXT_SCALE_MAX_SUPPORTED, 2);
  assert.equal(PRIMARY_ACTION_ZONE_MIN_FRACTION, 0.6);
  assert.deepEqual(REACH_REFERENCE_DEVICE, { name: "6.1-inch", logicalHeightPt: 844 });
});

test("relative luminance matches the WCAG reference values", () => {
  assert.equal(relativeLuminance("#000000"), 0);
  assert.equal(relativeLuminance("#FFFFFF"), 1);
  // Computed reference: #949494 has luminance 0.2961.
  const mid = relativeLuminance("#949494");
  assert.ok(mid !== null && Math.abs(mid - 0.2961) < 0.001);
});

test("contrast ratio: black on white is 21:1, a colour on itself is 1:1", () => {
  assert.equal(contrastRatio("#000000", "#FFFFFF"), 21);
  assert.equal(contrastRatio("#0B0F14", "#0B0F14"), 1);
  // Symmetric.
  assert.equal(contrastRatio("#F2F5F7", "#0B0F14"), contrastRatio("#0B0F14", "#F2F5F7"));
});

test("unparseable colours fail closed to null", () => {
  assert.equal(relativeLuminance("red"), null);
  assert.equal(relativeLuminance("#FFF"), null);
  assert.equal(relativeLuminance("#GGGGGG"), null);
  assert.equal(contrastRatio("red", "#000000"), null);
  assert.equal(contrastRatio("#000000", ""), null);
});

test("required contrast: 4.5 for normal text, 3.0 for large or non-text", () => {
  const base: PaletteEntry = {
    role: "t",
    foreground: "#FFFFFF",
    background: "#000000",
    sizePt: 12,
    bold: false,
  };
  assert.equal(requiredContrast(base), CONTRAST_TEXT_NORMAL_MIN);
  assert.equal(requiredContrast({ ...base, sizePt: 18 }), CONTRAST_TEXT_LARGE_MIN);
  assert.equal(requiredContrast({ ...base, sizePt: 14, bold: true }), CONTRAST_TEXT_LARGE_MIN);
  assert.equal(requiredContrast({ ...base, sizePt: 14, bold: false }), CONTRAST_TEXT_NORMAL_MIN);
  assert.equal(requiredContrast({ ...base, nonText: true }), CONTRAST_NON_TEXT_MIN);
});

test("the pinned shell palette passes WCAG 2.2 AA (NFR-25)", () => {
  assert.ok(CLIENT_PALETTE.length >= 3);
  assert.deepEqual(paletteViolations(CLIENT_PALETTE), []);
  assert.ok(paletteHonoursNfr25());
  // The note colour the contract caught: #5C6B77 measured 3.50:1 on the
  // shell background — below the 4.5:1 floor for 12 pt text.
  const oldNote: PaletteEntry = {
    role: "note",
    foreground: "#5C6B77",
    background: "#0B0F14",
    sizePt: 12,
    bold: false,
  };
  assert.deepEqual(paletteViolations([oldNote]), ["note"]);
  const note = CLIENT_PALETTE.find((entry) => entry.role === "note");
  assert.ok(note !== undefined && note.foreground === "#74879B");
  const ratio = contrastRatio(note.foreground, note.background);
  assert.ok(ratio !== null && ratio >= CONTRAST_TEXT_NORMAL_MIN);
});

test("dynamic type clamps into [1, 2] and garbage fails closed to 1", () => {
  assert.equal(dynamicTypeScale(1.3), 1.3);
  assert.equal(dynamicTypeScale(0.5), 1);
  assert.equal(dynamicTypeScale(2), 2);
  assert.equal(dynamicTypeScale(99), TEXT_SCALE_MAX_SUPPORTED);
  assert.equal(dynamicTypeScale(Number.NaN), 1);
  assert.equal(dynamicTypeScale(Number.POSITIVE_INFINITY), 1);
});

test("reduced motion replaces animation; unreadable preference reduces", () => {
  assert.deepEqual(motionPlan(true), { animated: false, fallback: "instant" });
  assert.deepEqual(motionPlan(false), { animated: true, fallback: null });
  const garbage = motionPlan(undefined as never);
  assert.equal(garbage.animated, false);
  assert.equal(garbage.fallback, REDUCED_MOTION_FALLBACK);
});

const CONTROL: ControlDescriptor = {
  id: "wave",
  label: "Hold to wave",
  role: "button",
  targetPt: { width: 44, height: 44 },
  focusOrder: 0,
};

test("a well-formed control passes; the roles registry is pinned", () => {
  assert.deepEqual(controlsViolations([CONTROL]), []);
  assert.ok(CONTROL_ROLES.includes("button"));
});

test("NFR-26: any target dimension below 44 pt is a violation", () => {
  const narrow = { ...CONTROL, targetPt: { width: 43.9, height: 44 } };
  assert.deepEqual(controlsViolations([narrow]), ["wave:target"]);
  const short = { ...CONTROL, targetPt: { width: 44, height: 12 } };
  assert.deepEqual(controlsViolations([short]), ["wave:target"]);
  const garbage = { ...CONTROL, targetPt: { width: Number.NaN, height: 44 } };
  assert.deepEqual(controlsViolations([garbage]), ["wave:target"]);
});

test("NFR-25: a missing label or unknown role is a violation", () => {
  assert.deepEqual(controlsViolations([{ ...CONTROL, label: "" }]), ["wave:label"]);
  assert.deepEqual(controlsViolations([{ ...CONTROL, label: "  " }]), ["wave:label"]);
  assert.deepEqual(controlsViolations([{ ...CONTROL, role: "div" as never }]), ["wave:role"]);
});

test("focus order must be a unique non-negative integer per surface", () => {
  const second: ControlDescriptor = { ...CONTROL, id: "join", focusOrder: 1 };
  assert.deepEqual(controlsViolations([CONTROL, second]), []);
  const duplicate: ControlDescriptor = { ...CONTROL, id: "join", focusOrder: 0 };
  assert.deepEqual(controlsViolations([CONTROL, duplicate]), ["join:focus-order-duplicate"]);
  assert.deepEqual(controlsViolations([{ ...CONTROL, focusOrder: -1 }]), ["wave:focus-order"]);
  assert.deepEqual(controlsViolations([{ ...CONTROL, focusOrder: 0.5 }]), ["wave:focus-order"]);
});

test("NFR-37: the primary action must start in the lower 40 percent", () => {
  const h = REACH_REFERENCE_DEVICE.logicalHeightPt;
  assert.equal(reachZoneTopPt(h), h * 0.6);
  assert.ok(primaryActionInReachZone(h * 0.6, h), "exactly on the line counts");
  assert.ok(primaryActionInReachZone(h * 0.75, h));
  assert.ok(!primaryActionInReachZone(h * 0.59, h), "above the line refuses");
  assert.ok(!primaryActionInReachZone(h * 0.2, h));
});

test("NFR-37: garbage geometry fails closed", () => {
  assert.ok(!primaryActionInReachZone(Number.NaN, 844));
  assert.ok(!primaryActionInReachZone(500, 0));
  assert.ok(!primaryActionInReachZone(500, -844));
  assert.ok(!primaryActionInReachZone(-10, 844));
  assert.ok(!primaryActionInReachZone(900, 844));
});

test("the master guard holds (NFR-25/26/37)", () => {
  assert.ok(accessibilityHonoursNfr25Nfr26Nfr37());
});
