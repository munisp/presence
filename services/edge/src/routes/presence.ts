/**
 * Presence routes (PRS-SRS-001 §5.2).
 *
 *   POST   /v1/presence   — enter or heartbeat; body carries a client-computed
 *                           H3 cell at resolution 11, nothing else (TR-15).
 *                           The server coarsens the cell to the venue's active
 *                           resolution (TR-12/14) and stores it with the
 *                           fifteen-minute TTL (FR-14).
 *   DELETE /v1/presence   — leave; presence and cell membership are removed.
 *
 * Resolution ladder (TR-12/14): res 9 by default, res 10 once a venue passes
 * 2 000 live presences, res 11 past 10 000.
 */

import { FastifyInstance } from "fastify";
import { cellToParent, getResolution, isValidCell } from "h3-js";
import { containsCoordinates, withRls } from "../auth.js";
import { EdgeContext } from "../context.js";

export const PRESENCE_TTL_S = 900; // FR-14

/** TR-14: pick the storage resolution from live venue density. */
export function resolutionFor(livePresences: number): number {
  if (livePresences > 10_000) return 11;
  if (livePresences > 2_000) return 10;
  return 9;
}

export function registerPresenceRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post("/v1/presence", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (containsCoordinates(body)) {
      // TR-15: raw coordinates are rejected, always.
      return reply.code(422).send({ error: "coordinate fields are not accepted; send an H3 cell" });
    }
    const cell = body.cell;
    if (typeof cell !== "string" || !isValidCell(cell)) {
      return reply.code(422).send({ error: "cell must be a valid H3 cell" });
    }
    if (!req.headers["x-app-attest-assertion"]) {
      // P0: assertion presence only; cryptographic verification lands with
      // the attestation milestone.
      return reply.code(401).send({ error: "missing app attestation" });
    }

    const userId = req.userId;
    const venueId = typeof body.venueId === "string" ? body.venueId : null;

    // TR-12/14: coarsen the client cell to the venue's active resolution.
    const live = venueId ? await ctx.valkey.scard(`presence:venue:${venueId}`) : 0;
    const targetRes = resolutionFor(live);
    const storedCell = getResolution(cell) === targetRes ? cell : cellToParent(cell, targetRes);

    const previous = await ctx.valkey.get(`presence:user:${userId}`);
    if (previous) {
      const prev = JSON.parse(previous) as { cell: string };
      if (prev.cell !== storedCell) {
        await ctx.valkey.srem(`presence:cell:${prev.cell}`, userId);
      }
    }

    const entry = JSON.stringify({ cell: storedCell, venueId });
    const pipe = ctx.valkey.pipeline();
    pipe.set(`presence:user:${userId}`, entry, "EX", PRESENCE_TTL_S);
    pipe.sadd(`presence:cell:${storedCell}`, userId);
    if (venueId) pipe.sadd(`presence:venue:${venueId}`, userId);
    await pipe.exec();

    return reply.send({ ok: true, cell: storedCell, ttl: PRESENCE_TTL_S });
  });

  app.delete("/v1/presence", async (req, reply) => {
    const userId = req.userId;
    const previous = await ctx.valkey.get(`presence:user:${userId}`);
    if (previous) {
      const prev = JSON.parse(previous) as { cell: string; venueId?: string | null };
      const pipe = ctx.valkey.pipeline();
      pipe.srem(`presence:cell:${prev.cell}`, userId);
      if (prev.venueId) pipe.srem(`presence:venue:${prev.venueId}`, userId);
      pipe.del(`presence:user:${userId}`);
      await pipe.exec();
    }
    return reply.send({ ok: true });
  });
}
