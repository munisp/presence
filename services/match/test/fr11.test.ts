/**
 * Batch 25 — FR-11 non-sensitive discoverability floor + NFR-31 trace ids.
 *
 * FR-11 counts NON-sensitive declared interests: a node the taxonomy
 * governance flipped sensitive (FR-59) after declaration no longer counts
 * toward the floor, and a node the taxonomy no longer knows is skipped
 * rather than throwing on the scan path.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { InterestGraph, nonSensitiveCount } from "../src/engine.js";
import { resolveRequestId } from "../src/requestid.js";

const graph = new InterestGraph([
  { nid: "root", label: "Root", parent: null, kind: "root", sensitive: false },
  { nid: "music", label: "Music", parent: "root", kind: "topic", sensitive: false },
  { nid: "jazz", label: "Jazz", parent: "music", kind: "topic", sensitive: false },
  { nid: "health", label: "Health", parent: "root", kind: "topic", sensitive: true },
]);

test("FR-11: only non-sensitive declared nodes count", () => {
  assert.equal(nonSensitiveCount({ music: 1, jazz: 0.8 }, graph), 2);
  assert.equal(nonSensitiveCount({ music: 1, health: 1 }, graph), 1); // below floor
  assert.equal(nonSensitiveCount({ health: 1 }, graph), 0);
  assert.equal(nonSensitiveCount({}, graph), 0);
});

test("FR-11: unknown nodes are skipped, never thrown", () => {
  assert.equal(nonSensitiveCount({ music: 1, gone: 1 }, graph), 1);
  assert.equal(nonSensitiveCount({ gone: 1, also_gone: 1 }, graph), 0);
});

test("NFR-31: a well-formed incoming id is honored; malformed ids are replaced", () => {
  const incoming = "4f3c2a1b-9d8e-4c7a-b6f5-0123456789ab";
  assert.equal(resolveRequestId(incoming), incoming);
  for (const bad of [undefined, null, 42, "", "has space", "x".repeat(129)]) {
    assert.match(
      resolveRequestId(bad),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  }
});
