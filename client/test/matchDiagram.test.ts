/**
 * TR-35: the match surface builds from the reason payload ALONE, and the
 * diagram spec version gates rendering — an unknown spec is a refusal,
 * never a guessed render.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMatchDiagram,
  DIAGRAM_SPEC_VERSION,
  renderableFromPayloadAlone,
  WireCandidate,
  WireReason,
} from "../src/presence/matchDiagram.js";

function reason(over: Partial<WireReason> = {}): WireReason {
  return {
    kind: "same",
    node: "n.music.techno",
    label: "Techno",
    contribution: 0.6,
    yours: "n.music.techno",
    theirs: "n.music.techno",
    yoursLabel: "Techno",
    theirsLabel: "Techno",
    ...over,
  };
}

function candidate(over: Partial<WireCandidate> = {}): WireCandidate {
  return {
    pairId: "0b6f2c60-0000-4000-8000-000000000001",
    sessionId: "sess-1",
    score: 0.83,
    band: "immediate",
    reasons: [reason()],
    icebreaker: "Both into Techno",
    diagramSpec: DIAGRAM_SPEC_VERSION,
    ...over,
  };
}

test("a well-formed payload builds a diagram with both anchors and one node per reason", () => {
  const r = buildMatchDiagram(candidate({ reasons: [reason(), reason({ node: "n.food.ramen", label: "Ramen", contribution: 0.3 })] }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.diagram.anchors, ["you", "them"]);
  assert.equal(r.diagram.specVersion, DIAGRAM_SPEC_VERSION);
  assert.equal(r.diagram.nodes.length, 2);
  assert.equal(r.diagram.edges.length, 4); // two edges per reason
});

test("shares are normalised to the total contribution and sum to 1", () => {
  const r = buildMatchDiagram(candidate({ reasons: [reason({ contribution: 0.6 }), reason({ node: "n.x", contribution: 0.3 })] }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const sum = r.diagram.nodes.reduce((s, n) => s + n.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(Math.abs(r.diagram.nodes[0].share - 2 / 3) < 1e-9);
});

test("edges carry role, declaring label and kind semantics from the payload alone", () => {
  const r = buildMatchDiagram(candidate({
    reasons: [reason({ kind: "ancestor", yours: "n.a.b", yoursLabel: "Acid techno", theirs: null })],
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const [yours, theirs] = r.diagram.edges;
  assert.deepEqual([yours.from, yours.to, yours.role, yours.label, yours.via], ["you", "n.music.techno", "yours", "Acid techno", "ancestor"]);
  // null declarer: the edge still renders, labelled by the shared node.
  assert.deepEqual([theirs.from, theirs.to, theirs.role, theirs.label, theirs.via], ["n.music.techno", "them", "theirs", "Techno", "ancestor"]);
});

test("a missing or unknown diagramSpec is refused — never a guessed render", () => {
  const noSpec = candidate();
  delete noSpec.diagramSpec;
  const a = buildMatchDiagram(noSpec);
  assert.equal(a.ok, false);
  assert.equal(!a.ok && a.reason, "unsupported-spec");
  assert.equal(!a.ok && a.reason === "unsupported-spec" && a.specVersion, 0);
  const b = buildMatchDiagram(candidate({ diagramSpec: 999 }));
  assert.equal(b.ok, false);
  assert.equal(!b.ok && b.reason, "unsupported-spec");
});

test("malformed reasons refuse as incomplete — the surface never renders gaps", () => {
  for (const bad of [
    candidate({ reasons: [reason({ yoursLabel: undefined as unknown as string })] }),
    candidate({ reasons: [reason({ kind: "cousin" as WireReason["kind"] })] }),
    candidate({ reasons: [null as unknown as WireReason] }),
    candidate({ reasons: undefined as unknown as WireReason[] }),
  ]) {
    const r = buildMatchDiagram(bad);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "incomplete-payload");
  }
});

test("renderableFromPayloadAlone is exactly the build's success", () => {
  assert.equal(renderableFromPayloadAlone(candidate()), true);
  assert.equal(renderableFromPayloadAlone(candidate({ diagramSpec: 2 })), false);
});

test("an empty reason list still renders — a zero-node halo, not an error", () => {
  const r = buildMatchDiagram(candidate({ reasons: [], icebreaker: "" }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.diagram.nodes.length, 0);
  assert.equal(r.diagram.edges.length, 0);
});
