/**
 * FR-91/SEC-22 rotating tie-break: equal-score candidates must not resolve
 * to a stable ordering. With a per-scan seed the order among ties is
 * deterministic for that scan and rotates across scans; without a seed the
 * legacy userId order holds (tooling stays reproducible).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Corpus, InterestGraph, Matcher } from "../src/engine.js";
import { rankScan } from "../src/scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "golden.json"), "utf8"));
const graph = new InterestGraph(golden.taxonomy.nodes, golden.taxonomy.links);
const matcher = new Matcher(graph);
const corpus = new Corpus(golden.corpus.size, new Map(Object.entries(golden.corpus.df)));

// Eight candidates with profiles identical to the requester's — every pair
// scores the same, so ordering is decided purely by the tie-break.
function tiedCandidates() {
  const profile = { "music.indie": 1.0, "music.techno": 1.0 };
  const ids = ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh"];
  return {
    requester: { ...profile },
    candidates: ids.map((userId) => ({ userId, profile: { ...profile }, cellDistance: 0 })),
  };
}

test("without a seed the legacy userId order applies", () => {
  const { requester, candidates } = tiedCandidates();
  const out = rankScan(requester, candidates, matcher, corpus, { baseThreshold: 0.0 });
  assert.deepEqual(
    out.map((r) => r.userId),
    ["aa", "bb", "cc"],
  );
});

test("a seed makes tie order deterministic within the scan", () => {
  const { requester, candidates } = tiedCandidates();
  const a = rankScan(requester, candidates, matcher, corpus, { baseThreshold: 0.0 }, 7);
  const b = rankScan(requester, candidates, matcher, corpus, { baseThreshold: 0.0 }, 7);
  assert.deepEqual(a.map((r) => r.userId), b.map((r) => r.userId));
});

test("the order rotates across seeds (SEC-22: no stable ordering)", () => {
  const { requester, candidates } = tiedCandidates();
  const legacy = rankScan(requester, candidates, matcher, corpus, { baseThreshold: 0.0 })
    .map((r) => r.userId)
    .join(",");
  const orders = new Set<string>();
  for (let seed = 1; seed <= 12; seed++) {
    const out = rankScan(requester, candidates, matcher, corpus, { baseThreshold: 0.0 }, seed);
    orders.add(out.map((r) => r.userId).join(","));
  }
  // Twelve seeds over the same tied pool must produce at least one ordering
  // that differs from the unseeded legacy order — otherwise the seeding is
  // not actually rotating anything.
  const differsFromLegacy = [...orders].some((o) => o !== legacy);
  assert.ok(orders.size > 1, `expected rotation across seeds, got ${orders.size} ordering(s)`);
  assert.ok(differsFromLegacy, "no seeded ordering differed from the legacy order");
});

test("unequal scores are unaffected by the seed", () => {
  const requester = { "music.indie": 1.0, "music.techno": 1.0 };
  const mk = (userId: string, profile: Record<string, number>) => ({
    userId,
    profile,
    cellDistance: 0,
  });
  const candidates = [
    mk("zz-low", { "music.soul": 1.0 }),
    mk("aa-high", { "music.indie": 1.0, "music.techno": 1.0 }),
    mk("mm-mid", { "music.indie": 1.0 }),
  ];
  for (const seed of [1, 2, 3]) {
    const out = rankScan(requester, candidates, matcher, corpus, { baseThreshold: 0.0 }, seed);
    // the identical-profile candidate outscores the rest regardless of seed
    assert.equal(out[0].userId, "aa-high");
  }
});
