/** FR-09/TECH-09 linking unit tests, including the cross-language pin:
 * this embedder must produce the same vectors as scripts/taxonomy_embedder.py
 * (which generated test/golden_embeddings.json). */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EMBEDDING_DIMS,
  EMBEDDER_ID,
  LINK_MAX_CANDIDATES,
  LINK_MIN_SIMILARITY,
  embed,
  parseLinkBody,
  tokens,
  toVectorLiteral,
} from "../src/linking.js";
import { screenText } from "../src/screening.js";

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../test/golden_embeddings.json", import.meta.url)), "utf8"),
) as { embedder: string; dims: number; probes: Record<string, number[]> };

test("the golden file is for this embedder", () => {
  assert.equal(golden.embedder, EMBEDDER_ID);
  assert.equal(golden.dims, EMBEDDING_DIMS);
});

test("embed() matches the Python-generated golden vectors exactly", () => {
  for (const [probe, expected] of Object.entries(golden.probes)) {
    const actual = embed(probe);
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert.ok(
        Math.abs(actual[i] - expected[i]) <= 1e-12,
        `${probe}[${i}]: ${actual[i]} != ${expected[i]}`,
      );
    }
  }
});

test("embed() is deterministic and unit-normalised", () => {
  const a = embed("jazz and climbing");
  assert.deepEqual(a, embed("jazz and climbing"));
  const norm = Math.sqrt(a.reduce((acc, v) => acc + v * v, 0));
  assert.ok(Math.abs(norm - 1) <= 1e-12);
  assert.notDeepEqual(a, embed("something else entirely"));
});

test("lexical overlap beats no overlap", () => {
  const jazz = embed("jazz");
  const jazzClimbing = embed("jazz and climbing");
  const cooking = embed("cooking recipes");
  const dot = (x: number[], y: number[]) => x.reduce((acc, v, i) => acc + v * y[i], 0);
  assert.ok(dot(jazz, jazzClimbing) > dot(jazz, cooking));
});

test("empty input is the zero vector, never NaN", () => {
  const v = embed("  ");
  assert.equal(v.length, EMBEDDING_DIMS);
  assert.ok(v.every((x) => x === 0));
});

test("tokens() is the contract normalisation", () => {
  assert.deepEqual(tokens("  Jazz,  and…CLIMBING! "), ["jazz", "and", "climbing"]);
  assert.deepEqual(tokens(""), []);
});

test("toVectorLiteral renders a pgvector literal", () => {
  assert.equal(toVectorLiteral([0.5, -0.25, 0]), "[0.5,-0.25,0]");
});

test("candidate policy constants are the governed values", () => {
  assert.equal(LINK_MAX_CANDIDATES, 5);
  assert.ok(LINK_MIN_SIMILARITY > 0 && LINK_MIN_SIMILARITY < 1);
});

test("parseLinkBody validates and screens", () => {
  assert.equal(parseLinkBody(null, screenText).ok, false);
  assert.equal(parseLinkBody({}, screenText).ok, false);
  assert.equal(parseLinkBody({ text: 42 }, screenText).ok, false);
  assert.equal(parseLinkBody({ text: "  " }, screenText).ok, false);
  assert.equal(parseLinkBody({ text: "x".repeat(501) }, screenText).ok, false);
  assert.equal(parseLinkBody({ text: "call 08012345678 now" }, screenText).ok, false);
  const ok = parseLinkBody({ text: " jazz and climbing " }, screenText);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.text, "jazz and climbing");
});
