/**
 * Navigation contract tests (b47): the screen stack is a pure state
 * machine — illegal moves fail closed to the unchanged state, and the
 * BR-07 two-tap safety budget holds from every reachable screen.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { APP_SCREENS } from "../src/presence/reportFlow.js";
import {
  NAV_SCREENS,
  ROOT_SCREEN,
  currentScreen,
  goBack,
  initialNavigation,
  navigateTo,
  resetNavigation,
  safetyHostScreen,
  safetyReachable,
} from "../src/presence/ui/navigation.js";

test("the stack roots at discovery and can never empty past it", () => {
  const initial = initialNavigation();
  assert.equal(ROOT_SCREEN, "discovery");
  assert.equal(currentScreen(initial), "discovery");
  assert.equal(goBack(initial), initial);
});

test("navigate pushes; back pops; reset returns to the root", () => {
  const at = navigateTo(initialNavigation(), "settings");
  assert.equal(currentScreen(at), "settings");
  assert.equal(at.stack.length, 2);
  assert.equal(currentScreen(goBack(at)), "discovery");
  assert.deepEqual(resetNavigation(), initialNavigation());
});

test("unknown destinations fail closed to the unchanged state", () => {
  const state = initialNavigation();
  assert.equal(navigateTo(state, "no-such-screen"), state);
  assert.equal(navigateTo(state, ""), state);
});

test("pushing the current screen is a no-op", () => {
  const state = initialNavigation();
  assert.equal(navigateTo(state, "discovery"), state);
});

test("every app screen plus the match overlay is registered", () => {
  for (const screen of APP_SCREENS) {
    assert.ok((NAV_SCREENS as readonly string[]).includes(screen), screen);
  }
  assert.ok((NAV_SCREENS as readonly string[]).includes("match"));
});

test("the match overlay is hosted on discovery for the safety budget", () => {
  assert.equal(safetyHostScreen("match"), "discovery");
  assert.equal(safetyHostScreen("settings"), "settings");
});

test("BR-07: safety is two taps from every reachable screen", () => {
  assert.equal(safetyReachable(initialNavigation()), true);
});
