/** FR-66/FR-67: the TableCard — time, place, head count, one prompt. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROBE_FIELDS,
  TABLE_CARD_AFFORDANCES,
  TABLE_CARD_FIELDS,
  TABLE_CARD_LIMIT,
  TABLE_CARD_MIN_SHARED,
  TABLE_SEAT_MAX,
  generatedPrompt,
  planJoin,
  probeRevealsOnlyVenueAndHeadcount,
  tableCardDescriptor,
  tableCardHonoursFr87,
  type TableCardData,
} from "../src/presence/tableCard.js";

function card(overrides: Partial<TableCardData> = {}): TableCardData {
  return {
    tableId: "t1",
    time: "2026-11-25T21:00:00Z",
    place: "Café Aurora",
    headCount: 4,
    prompt: {
      nodeId: "node-ambient-music",
      label: "ambient music",
      memberCount: 3,
      members: ["ada", "grace", "linus"],
      generated: true,
    },
    ...overrides,
  };
}

test("FR-66: the field set is pinned and the mirrors cross-pin the server", () => {
  assert.deepEqual(TABLE_CARD_FIELDS, ["time", "place", "headCount", "prompt"]);
  assert.equal(TABLE_CARD_MIN_SHARED, 2);
  assert.equal(TABLE_CARD_LIMIT, 5);
  assert.equal(TABLE_SEAT_MAX, 6, "SEC-33: the seventh join is refused");
  assert.deepEqual(TABLE_CARD_AFFORDANCES, [
    "view-card",
    "join-table",
    "leave-table",
  ]);
});

test("FR-67: the prompt is generated, shared by enough members, sorted", () => {
  assert.ok(generatedPrompt(card().prompt));
  assert.ok(
    !generatedPrompt({ ...card().prompt, generated: false as never }),
    "a non-generated card is refused",
  );
  assert.ok(
    !generatedPrompt({
      ...card().prompt,
      memberCount: 1,
      members: ["ada"],
    }),
    "below the shared minimum is refused",
  );
  assert.ok(
    !generatedPrompt({
      ...card().prompt,
      members: ["linus", "ada", "grace"],
    }),
    "an unsorted member list is refused",
  );
  assert.ok(
    !generatedPrompt({ ...card().prompt, memberCount: 4 }),
    "the count must match the member list",
  );
});

test("FR-66/SEC-33: joining is self-serve while open, bounded at six seats", () => {
  assert.deepEqual(planJoin(true, 0), { action: "join", refreshesSnapshot: true });
  assert.deepEqual(planJoin(true, 5), { action: "join", refreshesSnapshot: true });
  assert.deepEqual(planJoin(true, 6), {
    action: "refuse",
    reason: "table-full",
  });
  assert.deepEqual(planJoin(false, 2), {
    action: "refuse",
    reason: "table-closed",
  });
  assert.deepEqual(planJoin(true, 2.5), { action: "refuse", reason: "invalid" });
  assert.deepEqual(planJoin(true, -1), { action: "refuse", reason: "invalid" });
});

test("FR-67: the join plan refreshes the shared snapshot", () => {
  const plan = planJoin(true, 3);
  assert.equal(plan.action, "join");
  if (plan.action === "join") {
    assert.equal(plan.refreshesSnapshot, true);
  }
});

test("FR-75: the pre-join probe reveals only venue and headcount", () => {
  assert.deepEqual(PROBE_FIELDS, ["venue", "headCount"]);
  assert.ok(
    probeRevealsOnlyVenueAndHeadcount({ venue: "Café Aurora", headCount: 4 }),
  );
  assert.ok(
    !probeRevealsOnlyVenueAndHeadcount({
      venue: "Café Aurora",
      headCount: 4,
      members: ["ada"],
    }),
    "member identities must not ride along",
  );
  assert.ok(!probeRevealsOnlyVenueAndHeadcount({ venue: "Café Aurora" }));
  assert.ok(!probeRevealsOnlyVenueAndHeadcount({}));
});

test("FR-87: the card descriptor carries no banned affordance", () => {
  assert.ok(tableCardHonoursFr87(card()));
  const descriptor = tableCardDescriptor(card());
  assert.equal(descriptor.kind, "table-card");
  assert.deepEqual(Object.keys(descriptor.fields), [
    "time",
    "place",
    "headCount",
    "prompt",
    "generated",
  ]);
  assert.equal(descriptor.fields.generated, true);
});
