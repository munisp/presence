/** FR-83: distinct haptics per consent transition + a non-visual channel. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONSENT_STATES,
  CONSENT_TRANSITIONS,
  HAPTIC_SIGNATURES,
  TRANSITION_ANNOUNCEMENTS,
  audibleWithoutHaptics,
  everyTransitionHasFeedback,
  hapticsAreDistinct,
  transitionFeedback,
  transitionKey,
} from "../src/presence/haptics.js";

test("the FR-29 states and legal transitions are pinned", () => {
  assert.deepEqual(CONSENT_STATES, ["DETECTED", "NUDGED", "EXPRESSED", "MUTUAL", "OPEN"]);
  assert.deepEqual(
    CONSENT_TRANSITIONS.map(transitionKey),
    [
      "DETECTED->NUDGED",
      "DETECTED->EXPRESSED",
      "NUDGED->EXPRESSED",
      "EXPRESSED->MUTUAL",
      "MUTUAL->OPEN",
    ],
  );
});

test("every legal transition has a haptic signature", () => {
  for (const transition of CONSENT_TRANSITIONS) {
    const signature = HAPTIC_SIGNATURES[transitionKey(transition)];
    assert.ok(signature !== undefined, `signature for ${transitionKey(transition)}`);
    assert.ok(signature.pattern.length > 0, "a non-empty vibration pattern");
    assert.ok(signature.pattern.every((ms) => ms > 0), "positive durations only");
  }
});

test("the five signatures are pairwise distinct (FR-83)", () => {
  assert.ok(hapticsAreDistinct());
  const serialised = CONSENT_TRANSITIONS.map((transition) =>
    HAPTIC_SIGNATURES[transitionKey(transition)].pattern.join(","),
  );
  assert.equal(new Set(serialised).size, CONSENT_TRANSITIONS.length);
});

test("the signatures are pinned so a refactor cannot merge them silently", () => {
  assert.deepEqual(HAPTIC_SIGNATURES["DETECTED->NUDGED"].pattern, [30]);
  assert.deepEqual(HAPTIC_SIGNATURES["DETECTED->EXPRESSED"].pattern, [20, 40, 20]);
  assert.deepEqual(HAPTIC_SIGNATURES["NUDGED->EXPRESSED"].pattern, [20, 40, 60]);
  assert.deepEqual(HAPTIC_SIGNATURES["EXPRESSED->MUTUAL"].pattern, [40, 60, 40, 60, 40]);
  assert.deepEqual(HAPTIC_SIGNATURES["MUTUAL->OPEN"].pattern, [80, 40, 160]);
});

test("every transition announces itself in audio and words", () => {
  assert.ok(audibleWithoutHaptics());
  const cues = CONSENT_TRANSITIONS.map(
    (transition) => TRANSITION_ANNOUNCEMENTS[transitionKey(transition)].audioCue,
  );
  assert.equal(new Set(cues).size, CONSENT_TRANSITIONS.length, "audio cues are distinct too");
  assert.deepEqual(cues, ["nudge-plink", "wave-send", "wave-return", "mutual-chime", "open-bloom"]);
});

test("transition feedback resolves for legal transitions, fails closed otherwise", () => {
  const mutual = transitionFeedback({ from: "EXPRESSED", to: "MUTUAL" });
  assert.ok(mutual !== null);
  assert.equal(mutual.haptic.label, "mutual");
  assert.equal(mutual.announcement.spoken, "It's mutual.");

  assert.equal(
    transitionFeedback({ from: "OPEN", to: "DETECTED" }),
    null,
    "an illegal transition gets no feedback",
  );
  assert.equal(
    transitionFeedback({ from: "MUTUAL", to: "EXPRESSED" }),
    null,
    "backwards is not a consent transition",
  );
});

test("the coverage proof holds for the whole machine", () => {
  assert.ok(everyTransitionHasFeedback());
});
