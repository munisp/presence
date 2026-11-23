/**
 * Check-in routes (PRS-SRS-001 §4.3, FR-99/FR-100).
 *
 *   POST /v1/venues/:venueId/checkin-tokens — a venue partner mints a
 *         short-lived signed token for one of their floors (printed as the
 *         per-floor QR/NFC code). Partner tokens only, own venues only —
 *         same venue_ids claim rule as the dashboard (BR-12).
 *   POST /v1/presence/checkin — a user presents a token; the edge verifies
 *         the signature against the venue's secret and answers with the
 *         (venueId, floorId) attribution for the client's next presence
 *         publish.
 *
 * The venue secret never leaves the server: clients only ever hold tokens.
 */

import { FastifyInstance } from "fastify";
import {
  CHECKIN_TOKEN_TTL_MAX_S,
  mintCheckinToken,
  newCheckinClaims,
  verifyCheckinToken,
} from "../checkin.js";
import { EdgeContext } from "../context.js";

/** Read the unsigned claims body — only to find which venue must verify. */
function peekVenueId(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (typeof claims !== "object" || claims === null) return null;
    const vid = (claims as Record<string, unknown>).vid;
    return typeof vid === "string" ? vid : null;
  } catch {
    return null;
  }
}

export function registerCheckinRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/venues/:venueId/checkin-tokens",
    {
      schema: {
        body: {
          type: "object",
          required: ["floorId"],
          additionalProperties: false,
          properties: {
            floorId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$" },
            ttlSeconds: { type: "integer", minimum: 1, maximum: CHECKIN_TOKEN_TTL_MAX_S },
          },
        },
      },
    },
    async (req, reply) => {
      const { venueId } = req.params as { venueId: string };
      const body = req.body as { floorId: string; ttlSeconds?: number };

      // BR-12: venue partner tokens only, and only for their own venues.
      const claims = (req as unknown as { user?: { venue_ids?: unknown } }).user;
      const venueIds = Array.isArray(claims?.venue_ids) ? (claims!.venue_ids as string[]) : [];
      if (!venueIds.includes(venueId)) {
        return reply.code(403).send({ error: "venue partner token required (BR-12)" });
      }

      // FR-99: tokens are minted for declared floors only.
      const rows = await ctx.pg.query(
        `SELECT v.checkin_secret
           FROM venues v
           JOIN venue_floors f ON f.venue_id = v.venue_id
          WHERE v.venue_id = $1 AND f.floor_id = $2 AND v.active`,
        [venueId, body.floorId],
      );
      if (rows.rows.length === 0) {
        return reply.code(404).send({ error: "floor not declared for this venue (FR-99)" });
      }

      const tokenClaims = newCheckinClaims(venueId, body.floorId, body.ttlSeconds ?? 60);
      const token = mintCheckinToken(tokenClaims, rows.rows[0].checkin_secret);
      return reply.send({ token, expiresAt: new Date(tokenClaims.exp * 1000).toISOString() });
    },
  );

  app.post(
    "/v1/presence/checkin",
    {
      schema: {
        body: {
          type: "object",
          required: ["token"],
          additionalProperties: false,
          properties: { token: { type: "string", maxLength: 512 } },
        },
      },
    },
    async (req, reply) => {
      const { token } = req.body as { token: string };
      const venueId = peekVenueId(token);
      if (!venueId) {
        return reply.code(401).send({ error: "invalid or expired check-in token (FR-100)" });
      }
      const rows = await ctx.pg.query(
        "SELECT checkin_secret FROM venues WHERE venue_id = $1 AND active",
        [venueId],
      );
      if (rows.rows.length === 0) {
        return reply.code(401).send({ error: "invalid or expired check-in token (FR-100)" });
      }
      const claims = verifyCheckinToken(token, rows.rows[0].checkin_secret);
      if (!claims || claims.vid !== venueId) {
        return reply.code(401).send({ error: "invalid or expired check-in token (FR-100)" });
      }
      // The floor must still be declared — a removed floor invalidates its
      // outstanding tokens.
      const floor = await ctx.pg.query(
        "SELECT 1 FROM venue_floors WHERE venue_id = $1 AND floor_id = $2",
        [claims.vid, claims.flr],
      );
      if (floor.rows.length === 0) {
        return reply.code(401).send({ error: "invalid or expired check-in token (FR-100)" });
      }
      return reply.send({
        venueId: claims.vid,
        floorId: claims.flr,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      });
    },
  );
}
