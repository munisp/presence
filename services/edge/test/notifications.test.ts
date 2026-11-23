/** FR-58 notification switch unit tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPrefsPatch,
  mergePrefs,
  NOTIFICATION_CATEGORIES,
  SAFETY_CATEGORY,
} from "../src/notifications.js";

test("everything defaults on when nothing is stored", () => {
  const prefs = mergePrefs(null);
  for (const c of NOTIFICATION_CATEGORIES) assert.equal(prefs[c], true, c);
});

test("stored values merge over the defaults", () => {
  const prefs = mergePrefs({ matches: false, nudges: false });
  assert.equal(prefs.matches, false);
  assert.equal(prefs.nudges, false);
  assert.equal(prefs.messages, true);
});

test("a stored safety:false is ignored — safety is always on (FR-58)", () => {
  const prefs = mergePrefs({ safety: false });
  assert.equal(prefs[SAFETY_CATEGORY], true);
});

test("a partial patch flips only the named categories", () => {
  const out = applyPrefsPatch({ matches: true }, { matches: false });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.prefs.matches, false);
    assert.equal(out.prefs.messages, true);
  }
});

test("switching safety off is rejected, not ignored", () => {
  const out = applyPrefsPatch(null, { safety: false });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /safety/);
});

test("switching safety on is a harmless no-op", () => {
  const out = applyPrefsPatch(null, { safety: true });
  assert.equal(out.ok, true);
});

test("unknown categories and non-boolean values are rejected", () => {
  assert.equal(applyPrefsPatch(null, { telepathy: true }).ok, false);
  assert.equal(applyPrefsPatch(null, { matches: "yes" }).ok, false);
  assert.equal(applyPrefsPatch(null, ["matches"]).ok, false);
  assert.equal(applyPrefsPatch(null, null).ok, false);
});
