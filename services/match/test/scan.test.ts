/** Scan ranking unit tests (FR-20/21/22/25). */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Corpus, InterestGraph, Matcher } from "../src/engine.js";
import { adaptiveThreshold, bandFor, quantile, rankScan } from "../src/scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "golden.json"), "utf8"));
const graph = new InterestGraph(golden.taxonomy.nodes, golden.taxonomy.links);
const matcher = new Matcher(graph);
const corpus = new Corpus(golden.corpus.size, new Map(Object.entries(golden.corpus.df)));

test("adaptive threshold floors at the venue base (FR-21, TR-11)", () => {
  // five or fewer pairs: base only
  assert.equal(adaptiveThreshold([0.5, 0.4], 0.12), 0.12);
  // sparse distribution: quantile below base -> base wins
  const many = [0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12];
  assert.equal(adaptiveThreshold(many, 0.12), 0.12);
  // dense high-scoring cell: quantile above base -> quantile wins
  const hot = [0.40, 0.42, 0.44, 0.46, 0.48, 0.50, 0.52, 0.54, 0.56, 0.58];
  const t = adaptiveThreshold(hot, 0.12);
  assert.ok(t > 0.12 && t <= 0.58, `expected quantile-driven threshold, got ${t}`);
});

test("quantile is the linear-interpolated definition", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
  assert.equal(quantile([1, 2, 3, 4], 1), 4);
});

test("proximity is bands, never metres (FR-25)", () => {
  assert.equal(bandFor(0), "immediate");
  assert.equal(bandFor(1), "nearby");
  assert.equal(bandFor(2), "venue");
});

test("a scan returns at most three candidates with reasons (FR-20)", () => {
  const leaves = ["music.indie", "music.techno", "music.jazz", "music.soul",
    "music.folk", "music.classical", "music.metal", "music.hiphop"];
  const requester = { "music.indie": 1.0, "music.techno": 1.0 };
  const candidates = leaves.map((leaf, i) => ({
    userId: `u${i}`,
    profile: { [leaf]: 1.0, "music.soul": 1.0 },
    cellDistance: i % 2,
  }));
  const out = rankScan(requester, candidates, matcher, corpus, { baseThreshold: 0.0 });
  assert.ok(out.length <= 3);
  for (const r of out) assert.ok(r.reasons.length > 0);
});
