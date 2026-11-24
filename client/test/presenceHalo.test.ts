/** FR-77/FR-78: the presence halo is a density field with no position. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HALO_FULL_SCALE,
  HALO_LEVELS,
  haloDescriptor,
  haloFromCount,
  haloHonoursFr77,
  haloLevel,
  type HaloLevel,
  type PresenceHalo,
} from "../src/presence/presenceHalo.js";

test("the qualitative levels and scale are pinned (FR-78)", () => {
  assert.deepEqual(HALO_LEVELS, ["calm", "stirring", "lively", "buzzing"]);
  assert.equal(HALO_FULL_SCALE, 20);
});

test("intensity rises monotonically with the aggregate count", () => {
  let previous = -1;
  for (let count = 0; count <= HALO_FULL_SCALE * 2; count += 1) {
    const halo = haloFromCount(count);
    assert.ok(halo.intensity >= previous, `monotonic at count ${count}`);
    previous = halo.intensity;
  }
  assert.equal(haloFromCount(HALO_FULL_SCALE).intensity, 1);
  assert.equal(haloFromCount(HALO_FULL_SCALE * 3).intensity, 1, "clamped");
  assert.equal(haloFromCount(0).intensity, 0);
  assert.equal(haloFromCount(0).level, "calm");
});

test("levels quarter the 0..1 intensity range", () => {
  assert.equal(haloLevel(0), "calm");
  assert.equal(haloLevel(0.24), "calm");
  assert.equal(haloLevel(0.25), "stirring");
  assert.equal(haloLevel(0.49), "stirring");
  assert.equal(haloLevel(0.5), "lively");
  assert.equal(haloLevel(0.74), "lively");
  assert.equal(haloLevel(0.75), "buzzing");
  assert.equal(haloLevel(1), "buzzing");
});

test("invalid counts fail closed to the calmest field", () => {
  for (const bad of [Number.NaN, -5, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
    const halo = haloFromCount(bad);
    assert.equal(halo.intensity, 0, `count ${bad} fails closed`);
    assert.equal(halo.level, "calm");
  }
});

test("the descriptor carries intensity and level — nothing positional (FR-77)", () => {
  const halo = haloFromCount(7);
  const descriptor = haloDescriptor(halo);
  assert.equal(descriptor.kind, "presence-halo");
  assert.deepEqual(descriptor.affordances, []);
  assert.deepEqual(Object.keys(descriptor.fields).sort(), [
    "intensity",
    "level",
  ]);
});

test("the FR-77 guard holds for every count", () => {
  for (let count = 0; count <= HALO_FULL_SCALE * 2; count += 1) {
    assert.equal(haloHonoursFr77(haloFromCount(count)), true);
  }
});

test("the guard rejects a level label carrying digits", () => {
  const halo = haloFromCount(7);
  const tampered = { ...halo, level: "5 nearby" as HaloLevel };
  assert.equal(haloHonoursFr77(tampered), false);
});

test("the guard rejects a positional affordance (FR-77)", () => {
  const halo = haloFromCount(7);
  const tampered = {
    ...halo,
    affordances: ["map"],
  } as unknown as PresenceHalo;
  assert.equal(haloHonoursFr77(tampered), false);
});
