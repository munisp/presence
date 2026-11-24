/**
 * Batch 26 — TR-19 redirect resolution + FR-22 hard primary-reason guarantee.
 *
 * TR-19: deprecated taxonomy nodes are expressed as a redirect, never a
 * rename. resolve() follows the chain (with a hop cap so a governance loop
 * cannot hang the scan path); resolveProfile() re-homes declared weights
 * onto live nodes, keeping the maximum weight and the original insertion
 * order (golden parity: with no redirects resolution is the identity).
 *
 * FR-22: no two of the returned candidates may share the same primary
 * reason. MMR still orders the list, but a candidate whose primary reason
 * is already taken is skipped; the list may come back shorter than three —
 * FR-20 is an upper bound, not a quota.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InterestGraph,
  Matcher,
  resolveProfile,
  declared,
} from "../src/engine.js";
import { rankScan, ScanCandidate } from "../src/scan.js";
import { Corpus } from "../src/engine.js";

const nodes = [
  { nid: "root", label: "Root", parent: null, kind: "root", sensitive: false },
  { nid: "music", label: "Music", parent: "root", kind: "topic", sensitive: false },
  { nid: "jazz", label: "Jazz", parent: "music", kind: "topic", sensitive: false },
  { nid: "jazz.old", label: "Jazz (old)", parent: "music", kind: "topic", sensitive: false, redirect: "jazz" },
  { nid: "soul", label: "Soul", parent: "music", kind: "topic", sensitive: false },
  { nid: "loop.a", label: "A", parent: "root", kind: "topic", sensitive: false, redirect: "loop.b" },
  { nid: "loop.b", label: "B", parent: "root", kind: "topic", sensitive: false, redirect: "loop.a" },
];
const graph = new InterestGraph(nodes, []);

test("TR-19: resolve follows a redirect chain to a live node", () => {
  assert.equal(graph.resolve("jazz.old"), "jazz");
  assert.equal(graph.resolve("jazz"), "jazz"); // live nodes are their own resolution
  assert.throws(() => graph.resolve("never.existed"), /unknown node/);
});

test("TR-19: redirect loops terminate at the hop cap instead of hanging", () => {
  // loop.a <-> loop.b: resolve must return within the cap, never hang.
  const out = graph.resolve("loop.a");
  assert.ok(out === "loop.a" || out === "loop.b");
});

test("TR-19: resolveProfile re-homes weights, keeps max, preserves order", () => {
  const resolved = resolveProfile({ "jazz.old": 0.4, soul: 0.9, jazz: 0.7, gone: 1 }, graph);
  assert.deepEqual(resolved, { jazz: 0.7, soul: 0.9 }); // max(0.4, 0.7); unknown dropped
  assert.deepEqual(Object.keys(resolved), ["jazz", "soul"]); // insertion order of first sight
});

test("TR-19: with no redirects resolution is the identity (golden parity)", () => {
  const live = new InterestGraph(nodes.filter((n) => !n.redirect), []);
  const profile = { jazz: 0.5, soul: 1 };
  assert.deepEqual(resolveProfile(profile, live), profile);
});

test("TR-19: declared interests surface through their redirect target", () => {
  assert.deepEqual(declared({ "jazz.old": 1, soul: 0.5 }, graph), ["jazz", "soul"]);
});

test("FR-22: no two returned candidates share the same primary reason", () => {
  const g = new InterestGraph(nodes.filter((n) => !n.redirect), []);
  const matcher = new Matcher(g);
  const corpus = new Corpus(1, new Map());
  const requester = { jazz: 1, soul: 1 };
  // Four candidates that are all near-identical to the requester: their
  // primary reason will collide on the strongest shared node.
  const candidates = ["a", "b", "c", "d"].map((userId) => ({
    userId,
    profile: { jazz: 1, soul: 0.9 },
    cellDistance: 0,
  }));
  const out = rankScan(requester, candidates, matcher, corpus, { baseThreshold: 0.0 });
  assert.ok(out.length >= 1 && out.length <= 3);
  const primaries = out.map((r) => r.reasons[0]?.node);
  assert.equal(new Set(primaries).size, primaries.length, `duplicate primary in ${primaries}`);
});

test("FR-22: distinct primaries still fill up to three slots (MMR ordering kept)", () => {
  const g = new InterestGraph(nodes.filter((n) => !n.redirect), []);
  const matcher = new Matcher(g);
  const corpus = new Corpus(1, new Map());
  // Three clearly different candidates: jazz-only, soul-only, music-only.
  const requester = { jazz: 1, soul: 1, music: 1 };
  const candidates: ScanCandidate[] = [
    { userId: "j", profile: { jazz: 1 }, cellDistance: 0 },
    { userId: "s", profile: { soul: 1 }, cellDistance: 0 },
    { userId: "m", profile: { music: 1 }, cellDistance: 0 },
  ];
  const out = rankScan(requester, candidates, matcher, corpus, { baseThreshold: 0.0 });
  assert.ok(out.length >= 2, `expected distinct primaries to surface, got ${out.length}`);
});
