/**
 * FR-45 / FR-46 (+FR-80, BR-13): the RoomBoard.
 *
 * Per the SRS component inventory: "Opt-in notes above the crowd
 * threshold, authors hidden until reply." The board lives inside the
 * shared discovery skeleton's result region (FR-80), so rooms render
 * through the same skeleton as pairs and tables.
 *
 * The contract pins five things:
 *
 *   1. The crowd count is k-suppressed. The server answers with
 *      `members: kSuppressed(n)` — a number at or above K_MIN, or null
 *      when the room is smaller. The board renders the number it is
 *      given and renders NOTHING below the threshold:
 *      {@link renderCrowd} maps suppressed to null, so a sub-k crowd
 *      can never leak a small count. {@link ROOM_CROWD_K} cross-pins
 *      services/edge/src/aggregate.ts K_MIN (BR-13).
 *
 *   2. Notes render only above the threshold. "Opt-in notes above the
 *      crowd threshold" — {@link visibleNotes} returns no notes at all
 *      while the count is suppressed, failing closed.
 *
 *   3. Authors are hidden. The stored RoomNote has no author field —
 *      the board's note type omits it too, and
 *      {@link roomBoardNoteHasNoAuthor} proves absence on every note.
 *      "Until reply" is the server's pairing concern; the board never
 *      renders an author either way.
 *
 *   4. The note cadence is mirrored. FR-46: one note per member per
 *      five minutes. {@link canPostNote} mirrors the window so the
 *      compose affordance greys out instead of being refused; garbage
 *      timestamps fail closed. The member's first note is screened
 *      (SEC-21) — {@link noteRequiresScreening} marks it.
 *
 *   5. FR-87 applies here too. The board descriptor runs through the
 *      surface-integrity registry: no infinite scroll, no counts of
 *      likes or views — {@link roomBoardHonoursFr87}.
 *
 * Imports are pinned by tests/test_batch41.py: discoverySkeleton.js
 * (the result region the board mounts in) and surfaceIntegrity.js
 * (the FR-87 registry). No network, no platform APIs.
 */

import { SKELETON_REGIONS } from "./discoverySkeleton.js";
import {
  honoursSurfaceProhibitions,
  type SurfaceDescriptor,
} from "./surfaceIntegrity.js";

/**
 * BR-13/FR-45: the crowd threshold, cross-pinned to K_MIN in
 * services/edge/src/aggregate.ts.
 */
export const ROOM_CROWD_K = 11;

/**
 * FR-46: the note cadence — one note per member per five minutes,
 * mirroring the rooms.ts rate limit.
 */
export const ROOM_NOTE_INTERVAL_MS = 5 * 60 * 1000;

/** Mirror of ROOM_NOTES_MAX in services/edge/src/rooms.ts. */
export const ROOM_NOTES_MAX_CLIENT = 50;

/**
 * FR-45: one rendered note — deliberately NO author field. Authors are
 * hidden until reply, and the board is not the reply surface, so the
 * type carries nothing to hide.
 */
export interface RoomBoardNote {
  noteId: string;
  body: string;
  at: string;
}

/** The board facts the server hands the client — and only these. */
export interface RoomBoardSnapshot {
  topic: string;
  /** k-suppressed crowd count: null below the threshold. */
  members: number | null;
  suppressed: boolean;
  k: number;
  notes: readonly RoomBoardNote[];
}

/** FR-80: the board mounts in the shared skeleton's result region. */
export const BOARD_REGION = "resultRegion" as const;

/** FR-80: the pinned region exists in the shared skeleton. */
export function boardMountsInResultRegion(): boolean {
  return SKELETON_REGIONS.includes(BOARD_REGION);
}

/**
 * FR-45/BR-13: the rendered crowd count. A suppressed count renders as
 * null — the board shows "a few people" qualitatively, never a small
 * number. A count below the k the server claims is a protocol
 * violation and also fails closed.
 */
export function renderCrowd(snapshot: RoomBoardSnapshot): number | null {
  if (snapshot.suppressed || snapshot.members === null) return null;
  if (!Number.isInteger(snapshot.members) || snapshot.members < snapshot.k) {
    return null;
  }
  return snapshot.members;
}

/**
 * FR-45: "opt-in notes above the crowd threshold" — while the crowd is
 * suppressed the board renders no notes at all. Above it, at most
 * {@link ROOM_NOTES_MAX_CLIENT} notes render, newest ordering as
 * delivered.
 */
export function visibleNotes(
  snapshot: RoomBoardSnapshot,
): readonly RoomBoardNote[] {
  if (renderCrowd(snapshot) === null) return [];
  return snapshot.notes.slice(0, ROOM_NOTES_MAX_CLIENT);
}

/**
 * FR-45: every note on the board has no author field — the pinned
 * proof for "authors hidden".
 */
export function roomBoardNoteHasNoAuthor(note: RoomBoardNote): boolean {
  return !("author" in note);
}

/**
 * FR-46: may this member post a note now? The first note is always
 * allowed; afterwards one per five minutes, mirroring the server.
 * Garbage timestamps fail closed to not-allowed — a broken clock must
 * not become a spam vector.
 */
export function canPostNote(
  lastPostedAtMs: number | null,
  nowMs: number,
): boolean {
  if (lastPostedAtMs === null) return Number.isFinite(nowMs);
  if (!Number.isFinite(lastPostedAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  return nowMs - lastPostedAtMs >= ROOM_NOTE_INTERVAL_MS;
}

/**
 * SEC-21: the member's first note in a room is screened — the compose
 * path marks exactly that note so it routes through the classifier.
 */
export function noteRequiresScreening(notesPosted: number): boolean {
  return notesPosted === 0;
}

/** The board's affordances, pinned: read, post (cadence-bound), leave. */
export const BOARD_AFFORDANCES = [
  "read-notes",
  "post-note",
  "leave-room",
] as const;

/** The generic descriptor view of the board, for the FR-87 audit. */
export function boardDescriptor(
  snapshot: RoomBoardSnapshot,
): SurfaceDescriptor {
  return {
    kind: "room-board",
    affordances: BOARD_AFFORDANCES,
    fields: {
      region: BOARD_REGION,
      topic: snapshot.topic,
      members: renderCrowd(snapshot),
      noteCount: visibleNotes(snapshot).length,
    },
  };
}

/** The guard a renderer asserts: the board carries no FR-87 violation. */
export function roomBoardHonoursFr87(
  snapshot: RoomBoardSnapshot,
): boolean {
  return (
    boardMountsInResultRegion() &&
    honoursSurfaceProhibitions(boardDescriptor(snapshot))
  );
}
