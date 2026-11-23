/**
 * TR-36 idf prior smoothing — TypeScript mirror of tests/test_idf_prior.py.
 * The prior stabilises idf at small live populations and fades to exactly
 * zero influence at N = PRIOR_FADE_N, keeping the scoring contract
 * bit-identical at N >= 30 (well inside the 2% shift bound).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Corpus, PRIOR_FADE_N } from "../src/engine.js";

const legacyIdf = (size: number, n: number) => Math.sqrt(Math.log(1.0 + size / (1.0 + n)));

test("no prior is bit-identical to the legacy formula", () => {
  const c = new Corpus(5, new Map([["a", 2], ["b", 5]]));
  assert.equal(c.idf("a"), legacyIdf(5, 2));
  assert.equal(c.idf("b"), legacyIdf(5, 5));
  assert.equal(c.idf("unseen"), legacyIdf(5, 0));
});

test("prior influence is exactly zero at and beyond PRIOR_FADE_N", () => {
  const prior = new Map([["common", 900], ["rare", 3]]);
  for (const size of [PRIOR_FADE_N, PRIOR_FADE_N + 1, PRIOR_FADE_N * 4]) {
    const c = new Corpus(size, new Map([["common", size], ["rare", 1]]));
    c.setPrior(prior, 1000);
    assert.equal(c.idf("common"), legacyIdf(size, size));
    assert.equal(c.idf("rare"), legacyIdf(size, 1));
  }
});

test("small live corpora are pulled toward the global distribution", () => {
  const prior = new Map([["common", 900], ["rare", 3]]);
  const live = new Corpus(2, new Map([["common", 2], ["rare", 1]]));
  live.setPrior(prior, 1000);
  const plain = new Corpus(2, new Map([["common", 2], ["rare", 1]]));

  // exact blended values
  const w = (PRIOR_FADE_N - 2) / PRIOR_FADE_N;
  const s = w * PRIOR_FADE_N;
  const expectedCommon = Math.sqrt(Math.log(1.0 + (2 + s) / (1.0 + 2 + s * (900 / 1000))));
  assert.equal(live.idf("common"), expectedCommon);
  const expectedRare = Math.sqrt(Math.log(1.0 + (2 + s) / (1.0 + 1 + s * (3 / 1000))));
  assert.equal(live.idf("rare"), expectedRare);

  // the pull is toward the prior's verdict: with the global distribution
  // saying 900:3, the rare/common idf ratio widens dramatically versus what
  // the tiny live corpus alone would conclude
  const blendedRatio = live.idf("rare") / live.idf("common");
  const plainRatio = plain.idf("rare") / plain.idf("common");
  assert.ok(blendedRatio > plainRatio, `${blendedRatio} should exceed ${plainRatio}`);

  // and the blended common-node value lands near the prior's own idf
  const priorOnlyCommon = Math.sqrt(Math.log(1.0 + PRIOR_FADE_N / (1.0 + PRIOR_FADE_N * 0.9)));
  assert.ok(Math.abs(live.idf("common") - priorOnlyCommon) < 0.05);
});

test("an empty live corpus scores exactly the prior's own idf at PRIOR_FADE_N", () => {
  const c = new Corpus(0, new Map());
  c.setPrior(new Map([["x", 250]]), 1000);
  const expected = Math.sqrt(Math.log(1.0 + PRIOR_FADE_N / (1.0 + PRIOR_FADE_N * 0.25)));
  assert.equal(c.idf("x"), expected);
});

test("clearPrior restores legacy behaviour", () => {
  const c = new Corpus(3, new Map([["a", 1]]));
  c.setPrior(new Map([["a", 10]]), 100);
  assert.notEqual(c.idf("a"), legacyIdf(3, 1));
  c.clearPrior();
  assert.equal(c.idf("a"), legacyIdf(3, 1));
});
