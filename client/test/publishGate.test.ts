/** FR-88: accuracy-grant gate — no publish without precise location. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACCURACY_REFUSAL_ALTERNATIVE,
  ACCURACY_REFUSAL_SENTENCE,
  evaluateAccuracyGrant,
  refusalHonoursFr88,
} from "../src/presence/publishGate.js";

test("a precise grant publishes", () => {
  assert.deepEqual(evaluateAccuracyGrant("precise"), { publish: true });
});

test("an approximate grant refuses with the pinned sentence and check-in offer", () => {
  const decision = evaluateAccuracyGrant("approximate");
  assert.equal(decision.publish, false);
  if (!decision.publish) {
    assert.equal(decision.reason, "accuracy-grant");
    assert.equal(decision.sentence, ACCURACY_REFUSAL_SENTENCE);
    assert.equal(decision.alternative, "venue-checkin");
  }
});

test("unknown or malformed grants fail closed — nothing publishes", () => {
  for (const grant of [undefined, null, "", "full", "PRECISE", 1, {}, ["precise"]]) {
    const decision = evaluateAccuracyGrant(grant);
    assert.equal(decision.publish, false, `grant ${String(grant)} must refuse`);
  }
});

test("the refusal is exactly one sentence and offers venue check-in (FR-88)", () => {
  const sentences = ACCURACY_REFUSAL_SENTENCE.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  assert.equal(sentences.length, 1);
  assert.equal(ACCURACY_REFUSAL_ALTERNATIVE, "venue-checkin");
  assert.ok(refusalHonoursFr88(evaluateAccuracyGrant("approximate")));
  assert.ok(refusalHonoursFr88(evaluateAccuracyGrant("precise")));
});
