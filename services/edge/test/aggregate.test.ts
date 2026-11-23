/** Aggregation tests: BR-13 k-anonymity suppression for venue metrics. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { kSuppressed, K_MIN } from "../src/aggregate.js";

test("BR-13: the suppression threshold is k = 11", () => {
  assert.equal(K_MIN, 11);
});

test("BR-13: values below k are withheld entirely", () => {
  assert.equal(kSuppressed(0), null);
  assert.equal(kSuppressed(1), null);
  assert.equal(kSuppressed(10), null);
});

test("BR-13: values at or above k pass through untouched", () => {
  assert.equal(kSuppressed(11), 11);
  assert.equal(kSuppressed(12), 12);
  assert.equal(kSuppressed(10_000), 10_000);
});

test("BR-13: a custom k is honoured", () => {
  assert.equal(kSuppressed(4, 5), null);
  assert.equal(kSuppressed(5, 5), 5);
});
