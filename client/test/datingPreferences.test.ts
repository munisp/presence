/** AMD-DATE-01..05: dating preferences — validation and cross-pins. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DATING_AGE_MAX,
  DATING_AGE_MIN,
  DATING_GENDERS,
  DATING_GOALS,
  DATING_MAX_SEEKING,
  datingPreferencesToWire,
  validateDatingPreferences,
} from "../src/presence/datingPreferences.js";

const VALID = { gender: "female", seeking: ["male"], goal: "long_term", ageMin: 24, ageMax: 34 };

test("AMD-DATE-02: the vocabularies and bounds mirror the edge module", () => {
  // Cross-pinned: the edge mirrors the database-seeded tables.
  const edge = readFileSync("../services/edge/src/dating.ts", "utf8");
  assert.match(edge, /DATING_GENDERS = \["female", "male", "nonbinary"\]/);
  assert.match(edge, /DATING_GOALS = \["long_term", "short_term", "friendship", "exploring"\]/);
  assert.match(edge, /DATING_AGE_MIN = 18/);
  assert.match(edge, /DATING_AGE_MAX = 99/);
  assert.match(edge, /DATING_MAX_SEEKING = 3/);
  assert.deepEqual([...DATING_GENDERS], ["female", "male", "nonbinary"]);
  assert.deepEqual([...DATING_GOALS], ["long_term", "short_term", "friendship", "exploring"]);
  assert.equal(DATING_AGE_MIN, 18);
  assert.equal(DATING_AGE_MAX, 99);
  assert.equal(DATING_MAX_SEEKING, 3);
});

test("AMD-DATE-01: a valid preference set passes with no errors", () => {
  assert.deepEqual(validateDatingPreferences(VALID), []);
});

test("AMD-DATE-01: every bad dimension is reported, all at once", () => {
  const errors = validateDatingPreferences({
    gender: "unknown",
    seeking: ["male", "male", "alien", "female"],
    goal: "unknown",
    ageMin: 16,
    ageMax: 12,
  });
  assert.ok(errors.includes("gender_unknown"));
  assert.ok(errors.includes("seeking_too_many"));
  assert.ok(errors.includes("seeking_duplicate"));
  assert.ok(errors.includes("seeking_unknown"));
  assert.ok(errors.includes("goal_unknown"));
  assert.ok(errors.includes("age_bounds"));
});

test("AMD-DATE-01: empty seeking and inverted ranges are caught", () => {
  assert.deepEqual(validateDatingPreferences({ ...VALID, seeking: [] }), ["seeking_empty"]);
  assert.deepEqual(validateDatingPreferences({ ...VALID, ageMin: 40, ageMax: 30 }), [
    "age_inverted",
  ]);
});

test("AMD-DATE-01: the wire shape carries exactly five fields", () => {
  const wire = datingPreferencesToWire(VALID);
  assert.deepEqual(Object.keys(wire).sort(), ["ageMax", "ageMin", "gender", "goal", "seeking"]);
  assert.deepEqual(wire, { ...VALID, seeking: ["male"] });
});
