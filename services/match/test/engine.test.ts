/**
 * Parity suite: the TypeScript engine must reproduce the Python reference
 * (which reproduces the ACC-10 answer key 653/653) to 1e-9 on every golden
 * pair — scores and the full ordered reason lists (TR-08, TR-10).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Corpus, InterestGraph, Matcher, Profile } from "../src/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "golden.json"), "utf8"));

const graph = new InterestGraph(golden.taxonomy.nodes, golden.taxonomy.links);
const matcher = new Matcher(graph);
const corpus = new Corpus(
  golden.corpus.size,
  new Map(Object.entries(golden.corpus.df)),
);

function profile(nids: string[]): Profile {
  return Object.fromEntries(nids.map((n) => [n, 1.0]));
}

test("golden pair scores agree with the Python engine to 1e-9", () => {
  for (const p of golden.pairs) {
    const m = matcher.score(profile(p.a), profile(p.b), corpus);
    assert.ok(
      Math.abs(m.score - p.score) < 1e-9,
      `score drift on ${p.a} x ${p.b}: ${m.score} != ${p.score}`,
    );
  }
});

test("golden reason lists agree in kind, node, order and contribution", () => {
  for (const p of golden.pairs) {
    const m = matcher.score(profile(p.a), profile(p.b), corpus);
    assert.equal(m.reasons.length, p.reasons.length, `reason count on ${p.a} x ${p.b}`);
    for (let i = 0; i < m.reasons.length; i++) {
      assert.equal(m.reasons[i].kind, p.reasons[i].kind);
      assert.equal(m.reasons[i].node, p.reasons[i].node);
      assert.ok(Math.abs(m.reasons[i].contribution - p.reasons[i].contribution) < 1e-9);
    }
  }
});

test("scoring is deterministic (TR-10)", () => {
  const p = golden.pairs[0];
  const s1 = matcher.score(profile(p.a), profile(p.b), corpus);
  const s2 = matcher.score(profile(p.a), profile(p.b), corpus);
  assert.equal(s1.score, s2.score);
  assert.deepEqual(s1.reasons, s2.reasons);
});
