/** AMD-DATE-01..05: dating module pins — constants and strict parsers. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DATING_AGE_MAX,
  DATING_AGE_MIN,
  DATING_GENDERS,
  DATING_GOALS,
  DATING_MAX_SEEKING,
  DATING_STATES,
  parseDatingPeerQuery,
  parseDatingPreferencesBody,
  parseDatingStateBody,
} from "../src/dating.js";

const UID = "11111111-2222-4333-8444-555555555555";

const VALID = {
  gender: "female",
  seeking: ["male"],
  goal: "long_term",
  ageMin: 24,
  ageMax: 34,
};

test("AMD-DATE: pinned constants match the migration contract", () => {
  assert.deepEqual([...DATING_GENDERS], ["female", "male", "nonbinary"]);
  assert.deepEqual([...DATING_GOALS], ["long_term", "short_term", "friendship", "exploring"]);
  assert.equal(DATING_AGE_MIN, 18);
  assert.equal(DATING_AGE_MAX, 99);
  assert.equal(DATING_MAX_SEEKING, 3);
  assert.deepEqual([...DATING_STATES], ["active", "paused"]);
});

test("AMD-DATE-01: preferences parser — strict shape, no extra keys", () => {
  assert.deepEqual(parseDatingPreferencesBody(VALID), VALID);
  assert.equal(parseDatingPreferencesBody({ ...VALID, bio: "hi" }), null);
  assert.equal(parseDatingPreferencesBody({ gender: "female" }), null);
  assert.equal(parseDatingPreferencesBody(null), null);
  assert.equal(parseDatingPreferencesBody("x"), null);
});

test("AMD-DATE-01/02: vocabularies, dedup and age bounds are enforced", () => {
  assert.equal(parseDatingPreferencesBody({ ...VALID, gender: "alien" }), null);
  assert.equal(parseDatingPreferencesBody({ ...VALID, goal: "alien" }), null);
  assert.equal(parseDatingPreferencesBody({ ...VALID, seeking: [] }), null);
  assert.equal(parseDatingPreferencesBody({ ...VALID, seeking: ["male", "male"] }), null);
  assert.equal(parseDatingPreferencesBody({ ...VALID, seeking: ["male", "alien"] }), null);
  assert.equal(
    parseDatingPreferencesBody({ ...VALID, seeking: ["male", "female", "nonbinary", "male"] }),
    null,
  );
  assert.equal(parseDatingPreferencesBody({ ...VALID, ageMin: 17 }), null);
  assert.equal(parseDatingPreferencesBody({ ...VALID, ageMax: 100 }), null);
  assert.equal(parseDatingPreferencesBody({ ...VALID, ageMin: 40, ageMax: 30 }), null);
  assert.equal(parseDatingPreferencesBody({ ...VALID, ageMin: 18, ageMax: 18 }) !== null, true);
});

test("AMD-DATE-05: state parser — active | paused only", () => {
  assert.deepEqual(parseDatingStateBody({ state: "active" }), { state: "active" });
  assert.deepEqual(parseDatingStateBody({ state: "paused" }), { state: "paused" });
  assert.equal(parseDatingStateBody({ state: "deleted" }), null);
  assert.equal(parseDatingStateBody({}), null);
  assert.equal(parseDatingStateBody({ state: "active", extra: 1 }), null);
});

test("AMD-DATE-03/04: the peer query is a uuid and nothing else", () => {
  assert.deepEqual(parseDatingPeerQuery({ peer: UID }), { peer: UID });
  assert.equal(parseDatingPeerQuery({ peer: "not-a-uuid" }), null);
  assert.equal(parseDatingPeerQuery({}), null);
  assert.equal(parseDatingPeerQuery({ peer: UID, extra: 1 }), null);
  assert.equal(parseDatingPeerQuery(null), null);
});
