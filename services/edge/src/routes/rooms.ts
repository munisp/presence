/**
 * Crowd-mode interest rooms (PRS-SRS-001 §5).
 *
 *   GET    /v1/venues/:venueId/rooms — FR-44: in the crowd band this is the
 *                                       discovery surface: rooms formed from
 *                                       live members' declared interests
 *   POST   /v1/rooms/:roomKey/join   — opt in; needs live venue presence and
 *                                       a declared interest in the topic
 *   GET    /v1/rooms/:roomKey        — FR-45: topic, k-suppressed count and
 *                                       notes; members only, uniform 404
 *   POST   /v1/rooms/:roomKey/notes  — FR-46: 1 note / 5 min / member; the
 *                                       first note is screened (SEC-21)
 *   DELETE /v1/rooms/:roomKey/leave  — opt out; idempotent
 *
 * Rooms are ephemeral: meta, membership, notes, rate and screening state all
 * live in Valkey with a presence-aligned TTL. Notes carry no author field —
 * opting in is what publishes a note, and no one can be singled out of one.
 */

import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { kSuppressed, K_MIN } from "../aggregate.js";
import { withRls } from "../auth.js";
import { BUDGET_BUSY_MIN_POP, BUDGET_CROWD_MIN_POP } from "../budget.js";
import { EdgeContext, publishRealtime } from "../context.js";
import {
  parseRoomNote,
  ROOM_NOTE_INTERVAL_S,
  ROOM_NOTE_MAX_LEN,
  ROOM_NOTES_MAX,
  ROOM_TTL_S,
  roomKey,
  RoomNote,
} from "../rooms.js";
import { screenText, screeningErrorMessage } from "../screening.js";

type DensityMode = "sparse" | "busy" | "crowd";

function densityMode(liveCount: number): DensityMode {
  if (liveCount >= BUDGET_CROWD_MIN_POP) return "crowd";
  if (liveCount >= BUDGET_BUSY_MIN_POP) return "busy";
  return "sparse";
}

interface RoomMeta {
  venueId: string;
  nodeId: string;
}

export function registerRoomRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // FR-44: the crowd surface. Below the crowd band the venue keeps ordinary
  // discovery and the room list is empty; in the crowd band rooms form from
  // the live population's declared, non-sensitive interests.
  app.get("/v1/venues/:venueId/rooms", async (req, reply) => {
    const { venueId } = req.params as { venueId: string };
    const present = await ctx.valkey.sismember(`presence:venue:${venueId}`, req.userId);
    if (!present) {
      return reply.code(403).send({ error: "live presence at the venue is required" });
    }
    const members = await ctx.valkey.smembers(`presence:venue:${venueId}`);
    // Filter stale set entries the same way the match service does.
    let live: string[] = [];
    if (members.length > 0) {
      const pipe = ctx.valkey.pipeline();
      for (const m of members) pipe.exists(`presence:user:${m}`);
      const res = await pipe.exec();
      live = members.filter((_: string, i: number) => res?.[i]?.[1] === 1);
    }
    const mode = densityMode(live.length);
    if (mode !== "crowd") {
      // FR-44: the transition is density-driven — no crowd, no rooms.
      return reply.send({ mode, rooms: [] });
    }

    const topics = await ctx.pg.query(
      "SELECT node_id, members FROM room_topics($1::uuid[])",
      [live],
    );
    // Refresh every room's ephemeral meta so joins and posts can resolve the
    // key back to its (venue, topic) without the key revealing either.
    const pipe = ctx.valkey.pipeline();
    const rooms = topics.rows.map((r) => {
      const key = roomKey(venueId, r.node_id as string);
      const meta: RoomMeta = { venueId, nodeId: r.node_id as string };
      pipe.set(`room:meta:${key}`, JSON.stringify(meta), "EX", ROOM_TTL_S);
      pipe.sismember(`room:${key}:members`, req.userId);
      return { key, topic: r.node_id as string, members: Number(r.members) };
    });
    const joined = await pipe.exec();
    return reply.send({
      mode,
      rooms: rooms.map((r, i) => {
        const count = kSuppressed(r.members);
        return {
          key: r.key,
          topic: r.topic,
          // FR-45: the count is k-suppressed like every aggregate figure.
          members: count,
          suppressed: count === null,
          k: K_MIN,
          // Pipeline entries interleave [set, sismember] per room.
          joined: joined?.[2 * i + 1]?.[1] === 1,
        };
      }),
    });
  });

  app.post("/v1/rooms/:roomKey/join", async (req, reply) => {
    const { roomKey: key } = req.params as { roomKey: string };
    const meta = await loadMeta(ctx, key);
    if (!meta) return reply.code(404).send({ error: "room not found" });

    // FR-44: rooms only admit members while the venue is still in the crowd
    // band — a thinning crowd lets its rooms dissolve.
    const liveCount = await ctx.valkey.scard(`presence:venue:${meta.venueId}`);
    if (liveCount < BUDGET_CROWD_MIN_POP) {
      return reply.code(409).send({ error: "the room has dissolved with the crowd" });
    }
    const present = await ctx.valkey.sismember(`presence:venue:${meta.venueId}`, req.userId);
    if (!present) {
      return reply.code(403).send({ error: "live presence at the venue is required" });
    }
    // A room is formed from declared interests; joining one is declaring you
    // share its topic. The check reads the caller's own row under RLS.
    const declared = await withRls(ctx.pg, req.userId, async (c) =>
      c.query("SELECT 1 FROM profile_interests WHERE node_id = $1", [meta.nodeId]),
    );
    if (declared.rows.length === 0) {
      return reply.code(422).send({ error: "joining needs a declared interest in the room topic (FR-44)" });
    }

    await ctx.valkey.sadd(`room:${key}:members`, req.userId);
    await ctx.valkey.expire(`room:${key}:members`, ROOM_TTL_S);
    await ctx.valkey.expire(`room:meta:${key}`, ROOM_TTL_S);
    return reply.send({ key, topic: meta.nodeId, joined: true });
  });

  // FR-45: room content — members only, and non-members cannot distinguish
  // a missing room from one they may not see (uniform 404).
  app.get("/v1/rooms/:roomKey", async (req, reply) => {
    const { roomKey: key } = req.params as { roomKey: string };
    const meta = await loadMeta(ctx, key);
    if (!meta) return reply.code(404).send({ error: "room not found" });
    const member = await ctx.valkey.sismember(`room:${key}:members`, req.userId);
    if (!member) return reply.code(404).send({ error: "room not found" });

    const count = kSuppressed(await ctx.valkey.scard(`room:${key}:members`));
    const raw = await ctx.valkey.lrange(`room:${key}:notes`, 0, ROOM_NOTES_MAX - 1);
    const notes = raw.map((n) => JSON.parse(n) as RoomNote);
    return reply.send({
      key,
      topic: meta.nodeId,
      members: count,
      suppressed: count === null,
      k: K_MIN,
      notes,
    });
  });

  // FR-46: posting discipline — one note per member per five minutes, and
  // the member's first note in the room passes the SEC-21 content filters.
  app.post("/v1/rooms/:roomKey/notes", async (req, reply) => {
    const { roomKey: key } = req.params as { roomKey: string };
    const meta = await loadMeta(ctx, key);
    if (!meta) return reply.code(404).send({ error: "room not found" });
    const member = await ctx.valkey.sismember(`room:${key}:members`, req.userId);
    if (!member) return reply.code(404).send({ error: "room not found" });

    const parsed = parseRoomNote(req.body);
    if (!parsed.ok) {
      return reply.code(422).send({ error: `body must be 1–${ROOM_NOTE_MAX_LEN} characters` });
    }

    // FR-46: the rate gate — one note per five minutes per member per room.
    const gate = await ctx.valkey.set(
      `room:rate:${key}:${req.userId}`,
      "1",
      "EX",
      ROOM_NOTE_INTERVAL_S,
      "NX",
    );
    if (gate === null) {
      return reply.code(429).send({
        error: "one note per five minutes per room (FR-46)",
        retryAfterSeconds: ROOM_NOTE_INTERVAL_S,
      });
    }

    // SEC-21: the member's first note in this room is screened; later notes
    // are not re-screened (the messages route uses the same discipline).
    const screened = await ctx.valkey.sismember(`room:screened:${key}`, req.userId);
    if (!screened) {
      const findings = screenText(parsed.note);
      if (findings.length > 0) {
        return reply.code(422).send({ error: screeningErrorMessage(findings) });
      }
      await ctx.valkey.sadd(`room:screened:${key}`, req.userId);
      await ctx.valkey.expire(`room:screened:${key}`, ROOM_TTL_S);
    }

    const note: RoomNote = {
      noteId: randomUUID(),
      body: parsed.note,
      at: new Date().toISOString(),
    };
    await ctx.valkey
      .pipeline()
      .lpush(`room:${key}:notes`, JSON.stringify(note))
      .ltrim(`room:${key}:notes`, 0, ROOM_NOTES_MAX - 1)
      .expire(`room:${key}:notes`, ROOM_TTL_S)
      .expire(`room:${key}:members`, ROOM_TTL_S)
      .expire(`room:meta:${key}`, ROOM_TTL_S)
      .exec();
    await publishRealtime(ctx, `room:${key}`, { type: "room_note", note }).catch((err) =>
      console.error("centrifugo publish failed", err),
    );
    return reply.code(201).send(note);
  });

  app.delete("/v1/rooms/:roomKey/leave", async (req, reply) => {
    const { roomKey: key } = req.params as { roomKey: string };
    await ctx.valkey.srem(`room:${key}:members`, req.userId);
    // Idempotent opt-out — leaving a room that is already gone is a no-op.
    return reply.send({ key, joined: false });
  });
}

async function loadMeta(ctx: EdgeContext, key: string): Promise<RoomMeta | null> {
  const raw = await ctx.valkey.get(`room:meta:${key}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RoomMeta;
  } catch {
    return null;
  }
}
