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
 *
 * FR-16: each live presence window carries an opaque session id. A publish
 * without a live session starts one; heartbeats keep it; presenting a
 * session id that is not the live one is rejected with a 409. Account ids
 * never leave the edge in scan results pre-OPEN — the session id (with the
 * pair id) is the only handle a candidate gets.
 *
 * SEC-20: consecutive fixes are checked for impossible travel — when the
 * implied speed between the previous and the new cell exceeds a plausible
 * vehicle the publish is refused with a 422.
 *
 * FR-18: accounts with the invisible switch on cannot publish presence at
 * all (403); flipping the switch purges any live presence immediately.
 */

import { FastifyInstance } from "fastify";
import { cellToParent, getResolution, gridDistance, isValidCell } from "h3-js";
import { containsCoordinates } from "../auth.js";
import {
  EdgeContext,
  newPresenceSessionId,
  purgePresence,
  sessionKey,
} from "../context.js";
import { isImpossibleTravel } from "../velocity.js";
import { DISCOVERY_BLOCKED_ERROR, isDiscoveryAllowed, isInvisible } from "./account.js";

export const PRESENCE_TTL_S = 900; // FR-14

/** TR-14: pick the storage resolution from live venue density. */
export function resolutionFor(livePresences: number): number {
  if (livePresences > 10_000) return 11;
  if (livePresences > 2_000) return 10;
  return 9;
}

interface PresenceEntry {
  cell: string;
  venueId: string | null;
  floorId: string | null;
  sessionId: string;
  publishedAt: number;
}

export function registerPresenceRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/presence",
    {
      // TR-23: strict schema — unknown fields (incl. coordinate-shaped keys)
      // fail validation with a 400 before the handler runs.
      schema: {
        body: {
          type: "object",
          required: ["cell"],
          additionalProperties: false,
          properties: {
            cell: { type: "string" },
            venueId: { type: "string" },
            floorId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$" },
            sessionId: { type: "string", pattern: "^[0-9a-f]{32}$" },
          },
        },
      },
    },
    async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (containsCoordinates(body)) {
      // TR-15: raw coordinates are rejected, always. Defense in depth — the
      // body schema above already rejects these keys (TR-23).
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
    const floorId = typeof body.floorId === "string" ? body.floorId : null;
    const presentedSessionId = typeof body.sessionId === "string" ? body.sessionId : null;

    // FR-99: a floor attribution is only meaningful with its venue, and only
    // for a floor the venue actually declared.
    if (floorId !== null && venueId === null) {
      return reply.code(422).send({ error: "floorId requires venueId (FR-99)" });
    }
    if (floorId !== null && venueId !== null) {
      const floor = await ctx.pg.query(
        "SELECT 1 FROM venue_floors WHERE venue_id = $1 AND floor_id = $2",
        [venueId, floorId],
      );
      if (floor.rows.length === 0) {
        return reply.code(422).send({ error: "floor not declared for this venue (FR-99)" });
      }
    }

    // FR-02/FR-04/FR-53: age-blocked, deleted and investigation-removed
    // accounts cannot publish presence.
    if (!(await isDiscoveryAllowed(ctx, userId))) {
      return reply.code(403).send({ error: DISCOVERY_BLOCKED_ERROR });
    }
    // FR-55: an attestation-key suspension closes presence publishing with
    // the same neutral error — the suspension is never named to the client.
    const suspended = await ctx.pg.query(
      "SELECT has_active_suspension($1::uuid, 'attestation_key') AS s",
      [userId],
    );
    if (suspended.rows[0]?.s === true) {
      return reply.code(403).send({ error: DISCOVERY_BLOCKED_ERROR });
    }
    // FR-18: invisible accounts cannot publish presence.
    if (await isInvisible(ctx, userId)) {
      return reply.code(403).send({ error: "account is invisible (FR-18)" });
    }

    // TR-12/14: coarsen the client cell to the venue's active resolution.
    const live = venueId ? await ctx.valkey.scard(`presence:venue:${venueId}`) : 0;
    const targetRes = resolutionFor(live);
    const storedCell = getResolution(cell) === targetRes ? cell : cellToParent(cell, targetRes);

    const previous = await ctx.valkey.get(`presence:user:${userId}`);
    let sessionId: string;
    if (previous) {
      const prev = JSON.parse(previous) as Partial<PresenceEntry> & { cell: string };
      if (presentedSessionId && presentedSessionId !== prev.sessionId) {
        // FR-16: a session id that is not the live one is rejected — the
        // client must start a fresh session.
        return reply.code(409).send({
          error: "presence session id rejected; start a new session (FR-16)",
        });
      }
      // FR-16: heartbeats keep the live session id. Legacy entries without
      // one are upgraded in place.
      sessionId = prev.sessionId ?? newPresenceSessionId();

      if (prev.cell !== storedCell) {
        // SEC-20: impossible-travel check between consecutive fixes. Both
        // cells are coarsened to the coarser of their resolutions so the
        // grid distance is comparable.
        if (typeof prev.publishedAt === "number") {
          const res = Math.min(getResolution(prev.cell), getResolution(storedCell));
          const a = getResolution(prev.cell) === res ? prev.cell : cellToParent(prev.cell, res);
          const b = getResolution(storedCell) === res ? storedCell : cellToParent(storedCell, res);
          let steps: number;
          try {
            steps = gridDistance(a, b);
          } catch {
            // Pentagon distortion makes the distance undefined — treat the
            // jump as impossible rather than wave it through.
            return reply.code(422).send({ error: "presence moved implausibly fast (SEC-20)" });
          }
          if (isImpossibleTravel(steps, res, Date.now() - prev.publishedAt)) {
            return reply.code(422).send({ error: "presence moved implausibly fast (SEC-20)" });
          }
        }
        await ctx.valkey.srem(`presence:cell:${prev.cell}`, userId);
      }
      if (prev.venueId && prev.venueId !== venueId) {
        await ctx.valkey.srem(`presence:venue:${prev.venueId}`, userId);
      }
    } else {
      if (presentedSessionId) {
        // FR-16: the client claims a session that is not live.
        return reply.code(409).send({
          error: "presence session id rejected; start a new session (FR-16)",
        });
      }
      sessionId = newPresenceSessionId();
    }

    const entry: PresenceEntry = {
      cell: storedCell,
      venueId,
      floorId,
      sessionId,
      publishedAt: Date.now(),
    };
    const pipe = ctx.valkey.pipeline();
    pipe.set(`presence:user:${userId}`, JSON.stringify(entry), "EX", PRESENCE_TTL_S);
    pipe.sadd(`presence:cell:${storedCell}`, userId);
    if (venueId) pipe.sadd(`presence:venue:${venueId}`, userId);
    // FR-16 reverse index: session id -> account id, same TTL as presence.
    pipe.set(sessionKey(sessionId), userId, "EX", PRESENCE_TTL_S);
    await pipe.exec();

    return reply.send({ ok: true, cell: storedCell, ttl: PRESENCE_TTL_S, sessionId });
    },
  );

  app.delete("/v1/presence", async (req, reply) => {
    await purgePresence(ctx, req.userId);
    return reply.send({ ok: true });
  });
}
