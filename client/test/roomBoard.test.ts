/** FR-45/FR-46: the RoomBoard — notes above the threshold, no authors. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOARD_AFFORDANCES,
  BOARD_REGION,
  ROOM_CROWD_K,
  ROOM_NOTES_MAX_CLIENT,
  ROOM_NOTE_INTERVAL_MS,
  boardDescriptor,
  boardMountsInResultRegion,
  canPostNote,
  noteRequiresScreening,
  renderCrowd,
  roomBoardHonoursFr87,
  roomBoardNoteHasNoAuthor,
  visibleNotes,
  type RoomBoardSnapshot,
} from "../src/presence/roomBoard.js";

function snapshot(overrides: Partial<RoomBoardSnapshot> = {}): RoomBoardSnapshot {
  return {
    topic: "vinyl night",
    members: 23,
    suppressed: false,
    k: ROOM_CROWD_K,
    notes: [
      { noteId: "n1", body: "anyone bringing a deck?", at: "2026-11-25T20:00:00Z" },
    ],
    ...overrides,
  };
}

test("FR-45: the k floor is cross-pinned and the board mounts in the skeleton", () => {
  assert.equal(ROOM_CROWD_K, 11);
  assert.equal(BOARD_REGION, "resultRegion");
  assert.ok(boardMountsInResultRegion());
  assert.equal(ROOM_NOTES_MAX_CLIENT, 50);
  assert.equal(ROOM_NOTE_INTERVAL_MS, 5 * 60 * 1000);
});

test("FR-45/BR-13: a suppressed crowd renders no count", () => {
  assert.equal(renderCrowd(snapshot()), 23);
  assert.equal(
    renderCrowd(snapshot({ members: null, suppressed: true })),
    null,
  );
  assert.equal(
    renderCrowd(snapshot({ members: 7, suppressed: false })),
    null,
    "a sub-k count fails closed even if mislabelled",
  );
  assert.equal(renderCrowd(snapshot({ members: 23.5 })), null);
});

test("FR-45: notes render only above the crowd threshold", () => {
  assert.equal(visibleNotes(snapshot()).length, 1);
  assert.deepEqual(
    visibleNotes(snapshot({ members: null, suppressed: true })),
    [],
    "below the threshold there are no notes",
  );
  const many = Array.from({ length: 80 }, (_, i) => ({
    noteId: `n${i}`,
    body: `note ${i}`,
    at: "2026-11-25T20:00:00Z",
  }));
  assert.equal(
    visibleNotes(snapshot({ notes: many })).length,
    ROOM_NOTES_MAX_CLIENT,
    "the render is bounded",
  );
});

test("FR-45: no note carries an author field", () => {
  for (const note of visibleNotes(snapshot())) {
    assert.ok(roomBoardNoteHasNoAuthor(note));
  }
  assert.ok(
    !roomBoardNoteHasNoAuthor({
      noteId: "n1",
      body: "hi",
      at: "2026-11-25T20:00:00Z",
      ...({ author: "x" } as object),
    }),
    "the proof detects a smuggled author",
  );
});

test("FR-46: one note per five minutes, garbage fails closed", () => {
  const now = 1_700_000_000_000;
  assert.ok(canPostNote(null, now), "the first note is always allowed");
  assert.ok(!canPostNote(now - ROOM_NOTE_INTERVAL_MS + 1, now));
  assert.ok(canPostNote(now - ROOM_NOTE_INTERVAL_MS, now));
  assert.ok(!canPostNote(Number.NaN, now), "a broken clock cannot post");
  assert.ok(!canPostNote(now, Number.NaN));
  assert.ok(!canPostNote(null, Number.NaN));
});

test("SEC-21: only the member's first note requires screening", () => {
  assert.ok(noteRequiresScreening(0));
  assert.ok(!noteRequiresScreening(3));
});

test("FR-87: the board descriptor carries no banned affordance", () => {
  assert.deepEqual(BOARD_AFFORDANCES, ["read-notes", "post-note", "leave-room"]);
  assert.ok(roomBoardHonoursFr87(snapshot()));
  const descriptor = boardDescriptor(snapshot());
  assert.equal(descriptor.kind, "room-board");
  assert.equal(descriptor.fields.members, 23);
  assert.equal(
    boardDescriptor(snapshot({ members: null, suppressed: true })).fields
      .members,
    null,
  );
});
