/** FR-08 interest-set and FR-64 prompt validation unit tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INTEREST_MAX,
  INTEREST_MIN,
  parseInterests,
  parsePrompts,
  PROMPT_MAX_COUNT,
  PROMPT_MAX_LEN,
} from "../src/profile.js";

const mkInterests = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ nodeId: `music.g${i}`, weight: 1 }));

test("a valid interest set parses, defaulting weight to 1", () => {
  const out = parseInterests([{ nodeId: "music.soul" }, { nodeId: "music.indie", weight: 0.5 }, { nodeId: "music.techno" }]);
  assert.deepEqual(out, [
    { nodeId: "music.soul", weight: 1 },
    { nodeId: "music.indie", weight: 0.5 },
    { nodeId: "music.techno", weight: 1 },
  ]);
});

test("set-size bounds are enforced (FR-08)", () => {
  assert.equal(parseInterests(mkInterests(INTEREST_MIN - 1)), null);
  assert.equal(parseInterests(mkInterests(INTEREST_MIN)) !== null, true);
  assert.equal(parseInterests(mkInterests(INTEREST_MAX)) !== null, true);
  assert.equal(parseInterests(mkInterests(INTEREST_MAX + 1)), null);
});

test("duplicate nodes are rejected", () => {
  assert.equal(
    parseInterests([{ nodeId: "a" }, { nodeId: "b" }, { nodeId: "a" }]),
    null,
  );
});

test("weights must be in (0, 1]", () => {
  for (const w of [0, -0.5, 1.01, Number.NaN]) {
    assert.equal(
      parseInterests([{ nodeId: "a" }, { nodeId: "b" }, { nodeId: "c", weight: w }]),
      null,
      `weight ${w} must fail`,
    );
  }
});

test("malformed items are rejected", () => {
  assert.equal(parseInterests("not-an-array"), null);
  assert.equal(parseInterests([{ nodeId: 3 }, { nodeId: "b" }, { nodeId: "c" }]), null);
  assert.equal(parseInterests([{ nodeId: "" }, { nodeId: "b" }, { nodeId: "c" }]), null);
  assert.equal(parseInterests([{ weight: 1 }, { nodeId: "b" }, { nodeId: "c" }]), null);
});

test("valid prompts parse", () => {
  const out = parsePrompts([
    { slot: 1, body: "ask me about afrobeat" },
    { slot: 3, body: "sunday league referee" },
  ]);
  assert.deepEqual(out, [
    { slot: 1, body: "ask me about afrobeat" },
    { slot: 3, body: "sunday league referee" },
  ]);
});

test("prompt count and length caps are enforced (FR-64)", () => {
  const four = Array.from({ length: PROMPT_MAX_COUNT + 1 }, (_, i) => ({ slot: (i % 3) + 1, body: "x" }));
  assert.equal(parsePrompts(four), null);
  assert.equal(parsePrompts([{ slot: 1, body: "x".repeat(PROMPT_MAX_LEN + 1) }]), null);
  assert.equal(parsePrompts([{ slot: 1, body: "x".repeat(PROMPT_MAX_LEN) }]) !== null, true);
  assert.equal(parsePrompts([{ slot: 1, body: "" }]), null);
});

test("duplicate or out-of-range slots are rejected", () => {
  assert.equal(parsePrompts([{ slot: 1, body: "a" }, { slot: 1, body: "b" }]), null);
  assert.equal(parsePrompts([{ slot: 0, body: "a" }]), null);
  assert.equal(parsePrompts([{ slot: PROMPT_MAX_COUNT + 1, body: "a" }]), null);
  assert.equal(parsePrompts([{ slot: 1.5, body: "a" }]), null);
});

test("an empty prompt array clears the set", () => {
  assert.deepEqual(parsePrompts([]), []);
});
