/** FR-66/67/68 group surface helper unit tests (pure functions). */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCards,
  CARD_LIMIT,
  parseSlot,
  parseTableName,
  SLOT_DEFAULT_MINUTES,
  TABLE_MEMBER_CAP,
  TABLE_NAME_MAX_LEN,
} from "../src/groups.js";

test("FR-66/SEC-33: the edge cap mirrors the data-layer trigger", () => {
  assert.equal(TABLE_MEMBER_CAP, 6);
  assert.equal(TABLE_NAME_MAX_LEN, 80);
});

test("parseTableName trims and bounds", () => {
  assert.equal(parseTableName("  Chess corner  "), "Chess corner");
  assert.equal(parseTableName(""), null);
  assert.equal(parseTableName("   "), null);
  assert.equal(parseTableName("x".repeat(80)), "x".repeat(80));
  assert.equal(parseTableName("x".repeat(81)), null);
  assert.equal(parseTableName(42), null);
});

test("parseSlot accepts a future start and defaults the duration", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const future = "2026-11-24T13:00:00Z";
  const parsed = parseSlot(future, undefined, now);
  assert.ok(parsed);
  assert.equal(parsed.startsAt.toISOString(), "2026-11-24T13:00:00.000Z");
  assert.equal(parsed.durationMinutes, SLOT_DEFAULT_MINUTES);
});

test("parseSlot enforces duration bounds and rejects the past", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const future = "2026-11-24T13:00:00Z";
  assert.equal(parseSlot(future, 5, now)?.durationMinutes, 5);
  assert.equal(parseSlot(future, 60, now)?.durationMinutes, 60);
  assert.equal(parseSlot(future, 4, now), null);
  assert.equal(parseSlot(future, 61, now), null);
  assert.equal(parseSlot(future, 15.5, now), null);
  assert.equal(parseSlot("2026-11-24T11:00:00Z", undefined, now), null);
  assert.equal(parseSlot("not-a-date", undefined, now), null);
  assert.equal(parseSlot(123, undefined, now), null);
});

test("FR-67: cards require two sharers, are ranked and capped", () => {
  const rows = [
    { nodeId: "games.chess", label: "Chess", members: ["u1", "u2", "u3"] },
    { nodeId: "music.jazz", label: "Jazz", members: ["u1", "u2"] },
    { nodeId: "solo.hobby", label: "Solo", members: ["u1"] }, // dropped
    { nodeId: "a.one", label: "A", members: ["u2", "u1"] }, // ties with jazz, id sorts first
    ...Array.from({ length: 8 }, (_, i) => ({
      nodeId: `filler.${i}`,
      label: `F${i}`,
      members: ["u1", "u2"],
    })),
  ];
  const cards = buildCards(rows);
  assert.equal(cards.length, CARD_LIMIT);
  assert.equal(cards[0].nodeId, "games.chess"); // largest share first
  assert.equal(cards[1].nodeId, "a.one"); // tie broken by node id
  assert.ok(cards.every((c) => c.generated === true)); // FR-67 label
  assert.ok(cards.every((c) => c.memberCount >= 2));
  assert.ok(!cards.some((c) => c.nodeId === "solo.hobby"));
});

test("FR-67: member lists are sorted for deterministic output", () => {
  const cards = buildCards([
    { nodeId: "n", label: "N", members: ["u9", "u2", "u5"] },
  ]);
  assert.deepEqual(cards[0].members, ["u2", "u5", "u9"]);
});
