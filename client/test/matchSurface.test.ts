/** FR-76: the match surface shows convergence, never identity. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMatchDiagram,
  type MatchDiagram,
  type WireCandidate,
} from "../src/presence/matchDiagram.js";
import {
  FORBIDDEN_MATCH_IDENTITY_FIELDS,
  MATCH_SURFACE_AFFORDANCES,
  buildMatchSurface,
  matchHeadline,
  matchSurfaceDescriptor,
  matchSurfaceViolations,
  showsCommonalityNotIdentity,
  type MatchSurface,
} from "../src/presence/matchSurface.js";

const CANDIDATE: WireCandidate = {
  pairId: "pair-1",
  sessionId: "session-1",
  score: 0.87,
  band: "strong",
  reasons: [
    {
      kind: "same",
      node: "n.coffee",
      label: "Specialty coffee",
      contribution: 0.6,
      yours: "n.coffee",
      theirs: "n.coffee",
      yoursLabel: "Specialty coffee",
      theirsLabel: "Specialty coffee",
    },
    {
      kind: "sibling",
      node: "n.jazz",
      label: "Jazz",
      contribution: 0.4,
      yours: "n.jazz.live",
      theirs: null,
      yoursLabel: "Live jazz",
      theirsLabel: "Jazz",
    },
  ],
  icebreaker: "Ask about the last gig they went to.",
  diagramSpec: 1,
};

function fixtureDiagram(): MatchDiagram {
  const build = buildMatchDiagram(CANDIDATE);
  assert.equal(build.ok, true);
  return build.ok ? build.diagram : (assert.fail("diagram builds"), undefined as never);
}

test("the surface builds one converging path per shared node", () => {
  const surface = buildMatchSurface(fixtureDiagram());
  assert.equal(surface.kind, "match");
  assert.equal(surface.paths.length, 2);
  const [coffee, jazz] = surface.paths;
  assert.deepEqual(coffee, {
    nodeId: "n.coffee",
    nodeLabel: "Specialty coffee",
    via: "same",
    yoursLabel: "Specialty coffee",
    theirsLabel: "Specialty coffee",
  });
  assert.equal(jazz.nodeId, "n.jazz");
  assert.equal(jazz.yoursLabel, "Live jazz");
  // A null declarer falls back to the shared node's own label (TR-35).
  assert.equal(jazz.theirsLabel, "Jazz");
});

test("the headline names the commonality, not the person (FR-76)", () => {
  const surface = buildMatchSurface(fixtureDiagram());
  assert.ok(surface.headline.includes("Specialty coffee"));
  assert.ok(surface.headline.includes("Jazz"));
  assert.ok(surface.headline.includes("in common"));
  assert.equal(
    matchHeadline([]),
    "Your paths cross here.",
    "empty overlap still never names anyone",
  );
});

test("the only affordance at the point of match is hold-to-wave", () => {
  assert.deepEqual(MATCH_SURFACE_AFFORDANCES, ["hold-to-wave"]);
  const surface = buildMatchSurface(fixtureDiagram());
  assert.deepEqual(surface.affordances, ["hold-to-wave"]);
});

test("the descriptor field set is fixed — no identity field can exist", () => {
  const surface = buildMatchSurface(fixtureDiagram());
  const descriptor = matchSurfaceDescriptor(surface);
  assert.deepEqual(Object.keys(descriptor.fields).sort(), [
    "headline",
    "paths",
  ]);
  for (const banned of FORBIDDEN_MATCH_IDENTITY_FIELDS) {
    assert.equal(
      banned in descriptor.fields,
      false,
      `${banned} must not appear at the point of match`,
    );
  }
});

test("a build from the diagram passes the FR-87 audit by construction", () => {
  const surface = buildMatchSurface(fixtureDiagram());
  assert.deepEqual(matchSurfaceViolations(surface), []);
  assert.equal(showsCommonalityNotIdentity(surface), true);
});

test("the guard catches a photo at the point of match (FR-87)", () => {
  const surface = buildMatchSurface(fixtureDiagram());
  const hostile = {
    ...surface,
    affordances: ["hold-to-wave", "photo-at-match"],
  } as unknown as MatchSurface;
  assert.deepEqual(matchSurfaceViolations(hostile), ["photo-at-match"]);
  assert.equal(showsCommonalityNotIdentity(hostile), false);
});

test("the guard catches an identity-shaped field key", () => {
  const surface = buildMatchSurface(fixtureDiagram());
  const hostile = {
    ...surface,
    affordances: surface.affordances,
    headline: surface.headline,
    paths: surface.paths,
  } as MatchSurface;
  // Simulate a renderer-supplied descriptor that smuggled a photo field.
  const descriptor = matchSurfaceDescriptor(hostile);
  descriptor.fields["photoUrl"] = "https://example.invalid/p.jpg";
  const violations: string[] = [];
  for (const key of Object.keys(descriptor.fields)) {
    if ((FORBIDDEN_MATCH_IDENTITY_FIELDS as readonly string[]).includes(key)) {
      violations.push(key);
    }
  }
  assert.deepEqual(violations, ["photoUrl"]);
});
