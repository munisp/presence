/** FR-87 + FR-77: the prohibition registry every surface is audited against. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROHIBITED_ENGAGEMENT_PATTERNS,
  PROHIBITED_PROXIMITY_ELEMENTS,
  descriptorViolations,
  honoursSurfaceProhibitions,
  type SurfaceDescriptor,
} from "../src/presence/surfaceIntegrity.js";

test("the FR-87 engagement-mechanic registry is pinned", () => {
  assert.deepEqual(PROHIBITED_ENGAGEMENT_PATTERNS, [
    "infinite-scroll",
    "auto-loading-scroll",
    "typing-indicator",
    "read-receipt",
    "streak",
    "daily-login-reward",
    "like-count",
    "view-count",
    "photo-at-match",
  ]);
});

test("the FR-77 proximity-element registry is pinned", () => {
  assert.deepEqual(PROHIBITED_PROXIMITY_ELEMENTS, [
    "map",
    "direction-indicator",
    "distance-value",
    "radius",
    "heat-map",
    "proximity-arrangement",
  ]);
});

test("a clean descriptor has no violations", () => {
  const descriptor: SurfaceDescriptor = {
    kind: "match",
    affordances: ["hold-to-wave"],
    fields: { headline: "coffee — what you have in common.", paths: [] },
  };
  assert.deepEqual(descriptorViolations(descriptor), []);
  assert.equal(honoursSurfaceProhibitions(descriptor), true);
});

test("every prohibited affordance is caught", () => {
  for (const banned of [
    ...PROHIBITED_ENGAGEMENT_PATTERNS,
    ...PROHIBITED_PROXIMITY_ELEMENTS,
  ]) {
    const descriptor: SurfaceDescriptor = {
      kind: "hostile",
      affordances: [banned],
      fields: {},
    };
    assert.deepEqual(descriptorViolations(descriptor), [banned]);
    assert.equal(honoursSurfaceProhibitions(descriptor), false);
  }
});

test("every prohibited field key is caught", () => {
  for (const banned of [
    ...PROHIBITED_ENGAGEMENT_PATTERNS,
    ...PROHIBITED_PROXIMITY_ELEMENTS,
  ]) {
    const descriptor: SurfaceDescriptor = {
      kind: "hostile",
      affordances: [],
      fields: { [banned]: 1 },
    };
    assert.deepEqual(descriptorViolations(descriptor), [banned]);
  }
});

test("multiple violations are all reported", () => {
  const descriptor: SurfaceDescriptor = {
    kind: "hostile",
    affordances: ["infinite-scroll", "map"],
    fields: { "view-count": 3, headline: "ok" },
  };
    assert.deepEqual(descriptorViolations(descriptor), [
    "infinite-scroll",
    "map",
    "view-count",
  ]);
});
