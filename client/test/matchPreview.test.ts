/** AMD-INN-07: on-device match preview — local estimate, never a request. */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { WireCandidate } from "../src/presence/matchDiagram.js";
import {
  MatchPreview,
  PREVIEW_POSSIBLE_MIN,
  PREVIEW_SHARED_BONUS,
  PREVIEW_STRONG_MIN,
  previewScore,
  previewVerdict,
} from "../src/presence/matchPreview.js";

const candidate: WireCandidate = {
  pairId: "p1",
  sessionId: "s1",
  score: 0.3,
  band: "near",
  reasons: [
    {
      kind: "same",
      node: "n-salsa",
      label: "Salsa",
      contribution: 0.3,
      yours: null,
      theirs: "n-salsa",
      yoursLabel: "Salsa",
      theirsLabel: "Salsa",
    },
  ],
  icebreaker: "Salsa",
  diagramSpec: 1,
};

test("AMD-INN-07: the bonus mirrors the engine contract", () => {
  // Cross-pinned: TR-04 EXACT_OVERLAP_BONUS and the FR-21 floor.
  const engine = readFileSync("../services/match/src/engine.ts", "utf8");
  assert.match(engine, /EXACT_OVERLAP_BONUS = 0\.05/);
  assert.match(engine, /SUGGEST_THRESHOLD = 0\.12/);
  assert.equal(PREVIEW_SHARED_BONUS, 0.05);
  assert.equal(PREVIEW_POSSIBLE_MIN, 0.12);
  assert.equal(PREVIEW_STRONG_MIN, 0.36);
});

test("AMD-INN-07: shared interests lift the estimate, capped at 1", () => {
  const withShared: MatchPreview = previewScore(candidate, ["n-salsa"]);
  assert.equal(withShared.estimate, 0.35);
  assert.deepEqual(withShared.shared, ["n-salsa"]);
  const hot = previewScore({ ...candidate, score: 0.99 }, ["n-salsa"]);
  assert.equal(hot.estimate, 1);
});

test("AMD-INN-07: verdicts follow the pinned thresholds", () => {
  assert.equal(previewVerdict(0.4), "strong");
  assert.equal(previewVerdict(0.36), "strong");
  assert.equal(previewVerdict(0.2), "possible");
  assert.equal(previewVerdict(0.12), "possible");
  assert.equal(previewVerdict(0.05), "weak");
  assert.equal(previewScore(candidate, []).estimate, 0.3);
  assert.equal(previewScore(candidate, []).verdict, "possible");
});

test("AMD-INN-07: the preview is on-device — no edge route serves it", () => {
  // A server round-trip would defeat the privacy purpose: the estimate
  // must never become a signal the platform can read.
  const routes = readdirSync("../services/edge/src/routes")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(`../services/edge/src/routes/${f}`, "utf8"))
    .join("\n");
  assert.ok(!routes.includes("match-preview"));
  assert.ok(!routes.includes("previewScore"));
});
