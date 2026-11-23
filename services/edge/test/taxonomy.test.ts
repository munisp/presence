/** FR-59/TR-20 taxonomy release unit tests. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  CMS_NODE_KINDS,
  LINK_KINDS,
  RELEASE_OPS_MAX,
  TAXONOMY_DEPTH_MAX,
  TaxonomyState,
  applyOps,
  diffSummary,
  linkKey,
  parseReleaseBody,
} from "../src/taxonomy.js";

function state(): TaxonomyState {
  return {
    nodes: new Map([
      ["music", { nodeId: "music", label: "music", parentId: null, kind: "domain", sensitive: false, redirectTo: null, depth: 0 }],
      ["music.jazz", { nodeId: "music.jazz", label: "jazz", parentId: "music", kind: "category", sensitive: false, redirectTo: null, depth: 1 }],
      ["old.node", { nodeId: "old.node", label: "old", parentId: null, kind: "domain", sensitive: false, redirectTo: "music", depth: 0 }],
    ]),
    links: new Map(),
  };
}

test("the governed vocabularies are fixed", () => {
  assert.deepEqual([...CMS_NODE_KINDS], ["domain", "category", "topic", "leaf"]);
  assert.deepEqual([...LINK_KINDS], ["rivalry", "neighbour", "co_occurs"]);
  assert.equal(TAXONOMY_DEPTH_MAX, 5);
  assert.equal(RELEASE_OPS_MAX, 200);
});

test("parseReleaseBody validates the envelope", () => {
  assert.equal(parseReleaseBody(null).ok, false);
  assert.equal(parseReleaseBody({}).ok, false);
  assert.equal(parseReleaseBody({ message: "  ", ops: [{}] }).ok, false);
  assert.equal(parseReleaseBody({ message: "m", ops: [] }).ok, false);
  assert.equal(parseReleaseBody({ message: "m", ops: [{ type: "nonsense" }] }).ok, false);
  const ok = parseReleaseBody({
    message: " add bebop ",
    ops: [{ type: "add_node", nodeId: "music.jazz.bebop", label: "bebop", parentId: "music.jazz", kind: "topic", sensitive: false }],
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.message, "add bebop");
});

test("add_node must extend the parent path by exactly one segment (TR-17)", () => {
  assert.equal(parseReleaseBody({ message: "m", ops: [{ type: "add_node", nodeId: "other.path", label: "x", parentId: "music", kind: "leaf", sensitive: false }] }).ok, false);
  assert.equal(parseReleaseBody({ message: "m", ops: [{ type: "add_node", nodeId: "music.jazz.bebop.hard", label: "x", parentId: "music", kind: "leaf", sensitive: false }] }).ok, false);
});

test("applyOps adds a node and derives depth from the parent", () => {
  const s = state();
  applyOps(s, [{ type: "add_node", nodeId: "music.jazz.bebop", label: "bebop", parentId: "music.jazz", kind: "topic", sensitive: false }]);
  const node = s.nodes.get("music.jazz.bebop");
  assert.equal(node?.depth, 2);
  assert.equal(node?.parentId, "music.jazz");
});

test("applyOps rejects duplicates, missing parents and deprecated parents", () => {
  assert.throws(() => applyOps(state(), [{ type: "add_node", nodeId: "music.jazz", label: "x", parentId: "music", kind: "leaf", sensitive: false }]), /already exists/);
  assert.throws(() => applyOps(state(), [{ type: "add_node", nodeId: "nope.child", label: "x", parentId: "nope", kind: "leaf", sensitive: false }]), /parent not found/);
  assert.throws(() => applyOps(state(), [{ type: "add_node", nodeId: "old.node.kid", label: "x", parentId: "old.node", kind: "leaf", sensitive: false }]), /deprecated/);
});

test("applyOps enforces the depth ceiling (TR-17)", () => {
  const s = state();
  s.nodes.set("d4", { nodeId: "d4", label: "d4", parentId: "music", kind: "topic", sensitive: false, redirectTo: null, depth: 4 });
  applyOps(s, [{ type: "add_node", nodeId: "d4.d5", label: "d5", parentId: "d4", kind: "leaf", sensitive: false }]);
  assert.throws(
    () => applyOps(s, [{ type: "add_node", nodeId: "d4.d5.d6", label: "d6", parentId: "d4.d5", kind: "leaf", sensitive: false }]),
    /exceeds 5/,
  );
});

test("deprecate rejects chains and missing targets", () => {
  assert.throws(() => applyOps(state(), [{ type: "deprecate", nodeId: "music.jazz", redirectTo: "old.node" }]), /chains/);
  assert.throws(() => applyOps(state(), [{ type: "deprecate", nodeId: "music.jazz", redirectTo: "ghost" }]), /not found/);
  const s = state();
  applyOps(s, [{ type: "deprecate", nodeId: "music.jazz", redirectTo: "music" }]);
  assert.equal(s.nodes.get("music.jazz")?.redirectTo, "music");
});

test("link ops are referential and idempotent-shaped", () => {
  const s = state();
  applyOps(s, [{ type: "add_link", aId: "music", bId: "music.jazz", kind: "co_occurs", weight: 0.5 }]);
  assert.equal(s.links.size, 1);
  assert.throws(() => applyOps(s, [{ type: "remove_link", aId: "music", bId: "music.jazz", kind: "rivalry" }]), /link not found/);
  applyOps(s, [{ type: "remove_link", aId: "music", bId: "music.jazz", kind: "co_occurs" }]);
  assert.equal(s.links.size, 0);
  assert.equal(linkKey({ aId: "a", bId: "b", kind: "rivalry" }), "a b rivalry");
});

test("op parsing rejects bad shapes", () => {
  const bad = [
    { type: "edit_label", nodeId: "Music", label: "x" }, // uppercase id
    { type: "edit_label", nodeId: "music", label: "" },
    { type: "set_sensitive", nodeId: "music", sensitive: "yes" },
    { type: "deprecate", nodeId: "music", redirectTo: "music" }, // self
    { type: "add_link", aId: "music", bId: "music.jazz", kind: "co_occurs", weight: 1.5 },
    { type: "add_link", aId: "music", bId: "music.jazz", kind: "friendship", weight: 0.5 },
    { type: "add_link", aId: "music", bId: "music", kind: "rivalry", weight: 0.5 },
  ];
  for (const op of bad) {
    assert.equal(parseReleaseBody({ message: "m", ops: [op] }).ok, false, JSON.stringify(op));
  }
});

test("diffSummary counts every operation class (TR-20)", () => {
  const summary = diffSummary([
    { type: "add_node", nodeId: "a.b", label: "b", parentId: "a", kind: "leaf", sensitive: false },
    { type: "edit_label", nodeId: "a", label: "A" },
    { type: "set_sensitive", nodeId: "a", sensitive: true },
    { type: "deprecate", nodeId: "a", redirectTo: "b" },
    { type: "add_link", aId: "a", bId: "b", kind: "rivalry", weight: 1 },
    { type: "remove_link", aId: "a", bId: "b", kind: "rivalry" },
  ]);
  assert.deepEqual(summary, { added: 1, relabelled: 1, sensitiveChanged: 1, deprecated: 1, linksAdded: 1, linksRemoved: 1, ops: 6 });
});
