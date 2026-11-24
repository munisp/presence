/** FR-92: modal-cell stabilisation over a five-minute window. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { gridDistance, gridRingUnsafe, latLngToCell } from "h3-js";

import {
  MOVEMENT_THRESHOLD_CELLS,
  STABILISATION_WINDOW_MS,
  createCellStabiliser,
} from "../src/presence/cellStabiliser.js";

// A Lagos fix and two neighbours derived from it — real cells, so
// gridDistance behaves exactly as it will on device.
const BASE = latLngToCell(6.5244, 3.3792, 9);
const ADJACENT = gridRingUnsafe(BASE, 1)[0];
const NEXT = gridRingUnsafe(BASE, 2)[0];
assert.equal(gridDistance(BASE, ADJACENT), 1, "fixture sanity: ring-1 cells are one step away");

const T0 = 1_700_000_000_000;
const MIN = 60_000;

test("the window is five minutes and the movement threshold is one cell", () => {
  assert.equal(STABILISATION_WINDOW_MS, 300_000);
  assert.equal(MOVEMENT_THRESHOLD_CELLS, 1);
});

test("the first observation publishes its own cell", () => {
  const s = createCellStabiliser();
  const obs = s.observe(BASE, T0);
  assert.deepEqual(obs, { publishCell: BASE, changed: true, reason: "initial", computedCell: BASE });
});

test("boundary flapping settles to the modal cell of the window", () => {
  const s = createCellStabiliser();
  // A stationary user flapping between BASE and an adjacent cell, with
  // BASE dominant across the window.
  const seq = [BASE, ADJACENT, BASE, BASE, ADJACENT, BASE];
  const cells = seq.map((c, i) => s.observe(c, T0 + i * 30_000).publishCell);
  // Every flap publishes BASE — the mode — never the noisy neighbour.
  for (const c of cells) assert.equal(c, BASE);
  // No spurious republish once settled.
  const settled = s.observe(ADJACENT, T0 + seq.length * 30_000);
  assert.equal(settled.publishCell, BASE);
  assert.equal(settled.reason, "modal");
  assert.equal(settled.changed, false);
});

test("a persistent neighbour shift becomes the new mode inside the window", () => {
  const s = createCellStabiliser();
  for (let i = 0; i < 4; i += 1) s.observe(BASE, T0 + i * 20_000);
  // The user "settles" onto the adjacent cell (e.g. GPS bias shift): the
  // mode follows only once the neighbour STRICTLY out-counts BASE in the
  // window — ties keep the published cell (hysteresis).
  const observations = [s.observe(ADJACENT, T0 + 80_000)];
  for (let i = 0; i < 5; i += 1) {
    observations.push(s.observe(ADJACENT, T0 + 100_000 + i * 20_000));
  }
  // While BASE leads or ties, the published cell stays BASE...
  const flips = observations.filter((o) => o.changed);
  assert.equal(flips.length, 1, "exactly one clean transition — never a flap");
  assert.equal(flips[0].publishCell, ADJACENT);
  assert.equal(flips[0].reason, "modal");
  // ...and once the neighbour holds a strict majority the published cell
  // has moved for good.
  const last = observations[observations.length - 1];
  assert.equal(last.publishCell, ADJACENT);
  assert.equal(last.reason, "modal");
});

test("real movement publishes fresh immediately (FR-92 movement exemption)", () => {
  const s = createCellStabiliser();
  s.observe(BASE, T0);
  s.observe(BASE, T0 + 30_000);
  // Two grid steps away — more than the one-cell noise budget.
  assert.equal(gridDistance(BASE, NEXT), 2, "fixture sanity");
  const obs = s.observe(NEXT, T0 + 60_000);
  assert.equal(obs.publishCell, NEXT);
  assert.equal(obs.reason, "moved");
  assert.equal(obs.changed, true);
});

test("an unmeasurable pair is treated as movement, never as 'same place'", () => {
  const s = createCellStabiliser();
  s.observe(BASE, T0);
  // A different-resolution or garbage cell makes gridDistance throw; the
  // stabiliser must publish fresh rather than freeze on the stale cell.
  const obs = s.observe("fffffffffffffff", T0 + 10_000);
  assert.equal(obs.reason, "moved");
  assert.equal(obs.publishCell, "fffffffffffffff");
});

test("samples older than the window are evicted", () => {
  const s = createCellStabiliser();
  // Old history says BASE; it all falls out of the five-minute window.
  s.observe(BASE, T0);
  s.observe(BASE, T0 + MIN);
  const later = T0 + STABILISATION_WINDOW_MS + MIN + 1_000;
  // One fresh adjacent observation: both BASE samples are now outside
  // the window, so the mode is ADJACENT even though BASE leads the
  // lifetime count.
  const obs = s.observe(ADJACENT, later);
  assert.equal(obs.reason, "modal");
  assert.equal(obs.publishCell, ADJACENT);
});

test("ties keep the published cell; a strict majority moves it", () => {
  const s = createCellStabiliser();
  s.observe(BASE, T0);
  // 1-1 tie: hysteresis keeps BASE — the flap is not published.
  const tie = s.observe(ADJACENT, T0 + 10_000);
  assert.equal(tie.publishCell, BASE);
  assert.equal(tie.changed, false);
  assert.equal(tie.reason, "modal");
  // Strict majority for ADJACENT: the published cell moves, once.
  const majority = s.observe(ADJACENT, T0 + 20_000);
  assert.equal(majority.publishCell, ADJACENT);
  assert.equal(majority.changed, true);
  assert.equal(majority.reason, "modal");
});
