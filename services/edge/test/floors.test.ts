/** FR-99/TR-42 connected-floor scoping unit tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FloorDeclaration, floorsCompatible } from "../src/floors.js";

const DECL: FloorDeclaration[] = [
  { floorId: "G", connectedTo: ["L1"] },
  { floorId: "L1", connectedTo: ["G"] },
  { floorId: "L2", connectedTo: [] }, // roof bar: isolated
];

test("same floor is always compatible", () => {
  assert.equal(floorsCompatible("L1", "L1", DECL), true);
});

test("declared connected floors are compatible (either direction)", () => {
  assert.equal(floorsCompatible("G", "L1", DECL), true);
  assert.equal(floorsCompatible("L1", "G", DECL), true);
});

test("one-sided declaration is honoured symmetrically", () => {
  const oneSided: FloorDeclaration[] = [{ floorId: "G", connectedTo: ["L1"] }];
  assert.equal(floorsCompatible("L1", "G", oneSided), true);
});

test("undeclared floor pairs are not compatible", () => {
  assert.equal(floorsCompatible("G", "L2", DECL), false);
  assert.equal(floorsCompatible("L2", "L1", DECL), false);
});

test("missing floor info never applies the rule", () => {
  assert.equal(floorsCompatible(null, "L2", DECL), true);
  assert.equal(floorsCompatible("G", null, DECL), true);
  assert.equal(floorsCompatible(null, null, DECL), true);
});

test("with no declarations, different floors are not connected", () => {
  // scan.ts only calls this when declarations exist; the empty set must
  // still answer conservatively for a directly-invoked caller
  assert.equal(floorsCompatible("G", "L9", []), false);
  assert.equal(floorsCompatible("G", "G", []), true);
});
