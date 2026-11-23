/**
 * FR-44/45/46: crowd-mode interest rooms — constants, keys, and parsers.
 *
 * Rooms are ephemeral: every artefact is a Valkey key with a TTL aligned to
 * the presence session (900 s). When the crowd thins or everyone leaves,
 * the room simply stops existing — there is nothing to delete.
 */

import { createHash } from "node:crypto";

/** Aligned with the FR-16 presence session TTL — rooms die with presence. */
export const ROOM_TTL_S = 900;

/** FR-46: one note per member per room per five minutes. */
export const ROOM_NOTE_INTERVAL_S = 300;

/** FR-45: note bounds; the ring buffer keeps the most recent N. */
export const ROOM_NOTE_MAX_LEN = 280;
export const ROOM_NOTES_MAX = 50;

/**
 * Deterministic room identity: the same (venue, node) always yields the same
 * key, so a re-listed crowd reassembles the same rooms. The key is opaque —
 * it reveals neither the venue nor the topic.
 */
export function roomKey(venueId: string, nodeId: string): string {
  const digest = createHash("sha256").update(`${venueId}:${nodeId}`).digest("hex");
  return `rm_${digest.slice(0, 24)}`;
}

/** Parse a note body: trimmed, 1..ROOM_NOTE_MAX_LEN. */
export function parseRoomNote(body: unknown): { ok: true; note: string } | { ok: false } {
  if (body === null || typeof body !== "object") return { ok: false };
  const raw = (body as Record<string, unknown>).body;
  if (typeof raw !== "string") return { ok: false };
  const note = raw.trim();
  if (note.length === 0 || note.length > ROOM_NOTE_MAX_LEN) return { ok: false };
  return { ok: true, note };
}

/** What a stored note looks like — deliberately no author field (FR-45). */
export interface RoomNote {
  noteId: string;
  body: string;
  at: string;
}
