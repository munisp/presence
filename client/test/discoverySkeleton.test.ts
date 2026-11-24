/** FR-80: one skeleton for pairs/rooms/tables; explain once; never interrupt. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DISCOVERY_MODES,
  MODE_EXPLANATIONS,
  SEEN_EXPLANATIONS_KEY,
  SKELETON_AFFORDANCES,
  SKELETON_REGIONS,
  explanationDue,
  explanationIsOneSentence,
  formatSeenExplanations,
  parseSeenExplanations,
  planModeChange,
  skeletonDescriptor,
  skeletonFor,
  skeletonHonoursFr87,
  skeletonSharedAcrossModes,
} from "../src/presence/discoverySkeleton.js";
import { LOCAL_STATE_ALLOWLIST } from "../src/presence/localState.js";

test("the three modes and the pinned skeleton regions (FR-80)", () => {
  assert.deepEqual(DISCOVERY_MODES, ["pairs", "rooms", "tables"]);
  assert.deepEqual(SKELETON_REGIONS, [
    "header",
    "modeSelector",
    "resultRegion",
    "statusTray",
  ]);
});

test("every mode renders the same skeleton; only the result region differs", () => {
  const skeletons = DISCOVERY_MODES.map((mode) => skeletonFor(mode));
  for (const [index, skeleton] of skeletons.entries()) {
    assert.deepEqual(skeleton.regions, SKELETON_REGIONS);
    assert.equal(skeleton.resultContent, DISCOVERY_MODES[index]);
  }
  for (const a of skeletons) {
    for (const b of skeletons) {
      assert.equal(skeletonSharedAcrossModes(a, b), true);
    }
  }
});

test("each mode explanation is exactly one sentence (FR-80)", () => {
  for (const mode of DISCOVERY_MODES) {
    assert.equal(
      explanationIsOneSentence(MODE_EXPLANATIONS[mode]),
      true,
      `${mode} explanation must be one sentence`,
    );
  }
});

test("the one-sentence check rejects multi-sentence and unterminated text", () => {
  assert.equal(explanationIsOneSentence("One sentence."), true);
  assert.equal(explanationIsOneSentence("Two. Sentences."), false);
  assert.equal(explanationIsOneSentence("Unterminated"), false);
  assert.equal(explanationIsOneSentence("Trailing. text"), false);
});

test("the seen-set persists under an allowlisted TR-30 key", () => {
  assert.equal(SEEN_EXPLANATIONS_KEY, "presence.ui.seenExplanations");
  assert.ok(LOCAL_STATE_ALLOWLIST.includes(SEEN_EXPLANATIONS_KEY));
});

test("the seen-set parse fails closed toward explaining again", () => {
  assert.deepEqual(parseSeenExplanations(null), []);
  assert.deepEqual(parseSeenExplanations("not json"), []);
  assert.deepEqual(parseSeenExplanations('{"pairs":true}'), []);
  assert.deepEqual(parseSeenExplanations('["pairs","bogus","rooms"]'), [
    "pairs",
    "rooms",
  ]);
  const roundTrip = parseSeenExplanations(
    formatSeenExplanations(["pairs", "tables"]),
  );
  assert.deepEqual(roundTrip, ["pairs", "tables"]);
});

test("an explanation is due once per user per mode (FR-80)", () => {
  assert.equal(explanationDue("pairs", []), true);
  assert.equal(explanationDue("pairs", ["pairs"]), false);
  assert.equal(explanationDue("rooms", ["pairs"]), true);
});

test("a mode change must not interrupt an open conversation (FR-80)", () => {
  const plan = planModeChange("rooms", "pairs", true, []);
  assert.deepEqual(plan, { action: "defer", reason: "conversation-open" });
  const reselect = planModeChange("pairs", "pairs", true, ["pairs"]);
  assert.deepEqual(reselect, {
    action: "switch",
    to: "pairs",
    explanation: null,
  });
});

test("switching with no open conversation explains only when due", () => {
  const first = planModeChange("tables", "pairs", false, []);
  assert.deepEqual(first, {
    action: "switch",
    to: "tables",
    explanation: MODE_EXPLANATIONS.tables,
  });
  const again = planModeChange("tables", "pairs", false, ["tables"]);
  assert.deepEqual(again, { action: "switch", to: "tables", explanation: null });
});

test("the skeleton carries no load-more affordance and passes FR-87", () => {
  assert.deepEqual(SKELETON_AFFORDANCES, ["mode-switch", "refresh"]);
  for (const mode of DISCOVERY_MODES) {
    const skeleton = skeletonFor(mode);
    assert.equal(skeletonHonoursFr87(skeleton), true);
    const descriptor = skeletonDescriptor(skeleton);
    assert.equal(descriptor.kind, "discovery-skeleton");
    assert.deepEqual(Object.keys(descriptor.fields).sort(), [
      "regions",
      "resultContent",
    ]);
  }
});
