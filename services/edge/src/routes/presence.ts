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
import { recordSecurityEvent } from "../security.js";
import { DISCOVERY_BLOCKED_ERROR, isDiscoveryAllowed, isInvisible } from "./account.js";
import { ladderForCell, resolutionFor } from "../markets.js";
import { lookupAttribution } from "../attribution.js";

export const PRESENCE_TTL_S = 900; // FR-14
/**
 * NFR-18: a presence session and its cell persist for the 15-minute TTL plus
 * a 45-minute grace. The per-user entry and session reverse index keep the
 * 900 s TTL (that is the session); the cell/venue index sets keep entries for
 * TTL + grace (3 600 s) so a lapsed session's cell stays attributable for the
 * grace window. Index members whose per-user entry is gone are pruned on the
 * next publish in the cell, and the sets themselves expire 3 600 s after the
 * last publish — bounded residue either way.
 */
export const PRESENCE_INDEX_GRACE_S = 2700;
const PRESENCE_INDEX_TTL_S = PRESENCE_TTL_S + PRESENCE_INDEX_GRACE_S;

/** NFR-18: drop index members whose presence entry has already lapsed. */
async function pruneCellResidue(ctx: EdgeContext, cell: string): Promise<void> {
  const members = await ctx.valkey.smembers(`presence:cell:${cell}`);
  for (const member of members) {
    const live = await ctx.valkey.exists(`presence:user:${member}`);
    if (!live) await ctx.valkey.srem(`presence:cell:${cell}`, member);
  }
}

/** TR-12/14: the storage-resolution ladder moved to per-market
 * configuration (TR-37) — see services/edge/src/markets.ts. The pure
 * function is re-exported here for existing callers. */
export { resolutionFor } from "../markets.js";

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
      // SEC-30: the refusal is a security-relevant event — recorded for
      // abuse review, never disclosed back beyond the 401.
      recordSecurityEvent(ctx.pg, "missing_attestation", req.userId, { surface: "presence_publish" });
      return reply.code(401).send({ error: "missing app attestation" });
    }

    const userId = req.userId;
    let venueId = typeof body.venueId === "string" ? body.venueId : null;
    let floorId = typeof body.floorId === "string" ? body.floorId : null;
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

    // BR-14: an explicit claim to a venue that suspended the service (or
    // is not yet live / was offboarded) is refused — presence there stops
    // within one TTL of the status change.
    if (venueId !== null) {
      const venue = await ctx.pg.query(
        "SELECT active FROM venues WHERE venue_id = $1",
        [venueId],
      );
      if (venue.rows.length > 0 && venue.rows[0].active !== true) {
        return reply.code(409).send({ error: "venue is not operating (BR-14)" });
      }
    }

    // FR-90/TR-38: when the client made no explicit venue claim, a published
    // venue polygon takes precedence over the cell — presence inside it
    // attributes to the venue geometry. The map is computed in the lakehouse
    // (spatial join) and consulted here as a version-checked primary-key
    // lookup, never a per-request spatial query. An explicit venue claim
    // (check-in path, FR-99) is left untouched.
    if (venueId === null) {
      const attributed = await lookupAttribution(ctx, cell);
      if (attributed) {
        venueId = attributed.venueId;
        floorId = attributed.floorId;
      }
    }

    // TR-12/14: coarsen the client cell to the venue's active resolution.
    // TR-37: the ladder comes from the market's configuration (TR-16 native
    // h3-pg lookup, cached a minute), not from code constants.
    const live = venueId ? await ctx.valkey.scard(`presence:venue:${venueId}`) : 0;
    const ladder = await ladderForCell(ctx, cell);
    const targetRes = resolutionFor(live, ladder);
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
            recordSecurityEvent(ctx.pg, "impossible_travel", userId, { resolution: res });
            return reply.code(422).send({ error: "presence moved implausibly fast (SEC-20)" });
          }
          if (isImpossibleTravel(steps, res, Date.now() - prev.publishedAt)) {
            // SEC-30: record for abuse review. The detail carries the
            // comparison resolution only — never a cell (SEC-29).
            recordSecurityEvent(ctx.pg, "impossible_travel", userId, { resolution: res });
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
    // NFR-18: index sets outlive the session by the 45-minute grace window;
    // the TTL is refreshed on every publish, so residue is bounded by the
    // last publish + TTL + grace even if the client vanishes.
    pipe.sadd(`presence:cell:${storedCell}`, userId);
    pipe.expire(`presence:cell:${storedCell}`, PRESENCE_INDEX_TTL_S);
    if (venueId) {
      pipe.sadd(`presence:venue:${venueId}`, userId);
      pipe.expire(`presence:venue:${venueId}`, PRESENCE_INDEX_TTL_S);
    }
    // FR-16 reverse index: session id -> account id, same TTL as presence.
    pipe.set(sessionKey(sessionId), userId, "EX", PRESENCE_TTL_S);
    await pipe.exec();

    // NFR-18: sweep lapsed members of this cell's index in the background.
    pruneCellResidue(ctx, storedCell).catch((err) =>
      console.error("presence index prune failed", err),
    );

    return reply.send({ ok: true, cell: storedCell, ttl: PRESENCE_TTL_S, sessionId });
    },
  );

  app.delete("/v1/presence", async (req, reply) => {
    await purgePresence(ctx, req.userId);
    return reply.send({ ok: true });
  });
}
