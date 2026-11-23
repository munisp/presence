/** FR-44/45/46 interest-room unit tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRoomNote,
  ROOM_NOTE_INTERVAL_S,
  ROOM_NOTE_MAX_LEN,
  ROOM_NOTES_MAX,
  ROOM_TTL_S,
  roomKey,
} from "../src/rooms.js";

test("room keys are deterministic and opaque", () => {
  const a = roomKey("11111111-1111-1111-1111-111111111111", "music.techno");
  const b = roomKey("11111111-1111-1111-1111-111111111111", "music.techno");
  const c = roomKey("11111111-1111-1111-1111-111111111111", "music.jungle");
  const d = roomKey("22222222-2222-2222-2222-222222222222", "music.techno");
  assert.equal(a, b, "same venue+node → same room");
  assert.notEqual(a, c, "different topic → different room");
  assert.notEqual(a, d, "different venue → different room");
  assert.match(a, /^rm_[0-9a-f]{24}$/);
  assert.equal(a.includes("music"), false, "the key reveals nothing");
});

test("room TTL aligns with the presence session", () => {
  assert.equal(ROOM_TTL_S, 900);
});

test("posting discipline constants match the spec (FR-46)", () => {
  assert.equal(ROOM_NOTE_INTERVAL_S, 300);
  assert.equal(ROOM_NOTE_MAX_LEN, 280);
  assert.equal(ROOM_NOTES_MAX, 50);
});

test("note bodies are trimmed and bounded", () => {
  assert.equal(parseRoomNote(null).ok, false);
  assert.equal(parseRoomNote({}).ok, false);
  assert.equal(parseRoomNote({ body: "   " }).ok, false);
  assert.equal(parseRoomNote({ body: "x".repeat(281) }).ok, false);
  assert.equal(parseRoomNote({ body: 42 }).ok, false);
  const out = parseRoomNote({ body: "  anyone up for the back room set?  " });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.note, "anyone up for the back room set?");
});
