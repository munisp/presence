/** FR-81: spatial picker alongside search, three interests in four interactions. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONSTELLATION_AFFORDANCES,
  MAX_PICKER_INTERACTIONS,
  PICKER_MODES,
  POPULARITY_K_FLOOR,
  REQUIRED_DECLARATIONS,
  auditInteractionSequence,
  budgetSatisfiedByConstruction,
  buildConstellationPicker,
  constellationPickerDescriptor,
  constellationPickerViolations,
  interactionsToDeclare,
  modesOffered,
  pickerHonoursFr81,
  renderPopularity,
  type ConstellationNode,
} from "../src/presence/constellationPicker.js";

const node = (id: string, depth: number): ConstellationNode => ({
  id,
  label: id,
  depth,
  popularity: null,
  selectable: true,
});

test("the budget constants are pinned (FR-81)", () => {
  assert.equal(REQUIRED_DECLARATIONS, 3);
  assert.equal(MAX_PICKER_INTERACTIONS, 4);
  assert.deepEqual(PICKER_MODES, ["constellation", "search"]);
  assert.equal(POPULARITY_K_FLOOR, 11);
});

test("the spatial picker is offered alongside text search", () => {
  assert.ok(modesOffered());
  assert.ok(!modesOffered(["constellation"]), "constellation alone is not enough");
  assert.ok(!modesOffered(["search"]), "search alone is not enough");
});

test("three declarations always fit the budget by construction", () => {
  assert.equal(interactionsToDeclare(), 3);
  assert.ok(budgetSatisfiedByConstruction());
  assert.ok(
    MAX_PICKER_INTERACTIONS - interactionsToDeclare() === 1,
    "exactly one spare interaction for a descend, a search, or a mistake",
  );
});

test("the runtime audit nets selects and deselects against the budget", () => {
  const ok = auditInteractionSequence([
    { kind: "select", nodeId: "a" },
    { kind: "select", nodeId: "b" },
    { kind: "select", nodeId: "c" },
  ]);
  assert.deepEqual(ok, { declared: 3, interactions: 3, withinBudget: true });

  const fourWithDescend = auditInteractionSequence([
    { kind: "descend" },
    { kind: "select", nodeId: "a" },
    { kind: "select", nodeId: "b" },
    { kind: "select", nodeId: "c" },
  ]);
  assert.deepEqual(fourWithDescend, { declared: 3, interactions: 4, withinBudget: true });

  const tooFew = auditInteractionSequence([
    { kind: "select", nodeId: "a" },
    { kind: "select", nodeId: "b" },
    { kind: "search" },
    { kind: "descend" },
  ]);
  assert.equal(tooFew.withinBudget, false, "two declarations in four interactions fails");

  const overBudget = auditInteractionSequence([
    { kind: "descend" },
    { kind: "search" },
    { kind: "select", nodeId: "a" },
    { kind: "select", nodeId: "b" },
    { kind: "select", nodeId: "c" },
  ]);
  assert.equal(overBudget.withinBudget, false, "three declarations in five interactions fails");

  const netted = auditInteractionSequence([
    { kind: "select", nodeId: "a" },
    { kind: "select", nodeId: "b" },
    { kind: "deselect", nodeId: "a" },
    { kind: "select", nodeId: "c" },
  ]);
  assert.equal(netted.declared, 2, "a deselected node no longer counts");
});

test("popularity renders only at or above the k floor", () => {
  assert.equal(renderPopularity(null), null);
  assert.equal(renderPopularity(Number.NaN), null);
  assert.equal(renderPopularity(10), null, "below the k floor renders nothing");
  assert.equal(renderPopularity(11), "11 people nearby picked this");
  assert.equal(renderPopularity(250), "250 people nearby picked this");
});

test("the picker descriptor has a fixed field set and clean registry audit", () => {
  const picker = buildConstellationPicker("constellation", [node("a", 0), node("b", 1)]);
  assert.equal(picker.kind, "constellation-picker");
  assert.deepEqual(picker.affordances, CONSTELLATION_AFFORDANCES);
  assert.deepEqual(
    Object.keys(constellationPickerDescriptor(picker).fields).sort(),
    ["mode", "nodes"],
  );
  assert.deepEqual(constellationPickerViolations(picker), []);
  assert.ok(pickerHonoursFr81(picker));
});

test("a hostile affordance is caught by the registry audit", () => {
  const picker = buildConstellationPicker("search", []);
  const hostile = {
    ...picker,
    affordances: [...picker.affordances, "infinite-scroll"],
  };
  assert.deepEqual(constellationPickerViolations(hostile), ["infinite-scroll"]);
  assert.ok(!pickerHonoursFr81(hostile));
});
