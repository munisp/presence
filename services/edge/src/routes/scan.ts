/**
 * Scan route (PRS-SRS-001 §5.3).
 *
 *   POST /v1/scan — rate-limited to six per minute per user (FR-24). The edge
 *   resolves the requester's live presence, collects their FR-23 suppression
 *   list, and delegates ring expansion, scoring, adaptive thresholding and
 *   MMR to the match service. Surfaced pairs are suppressed for ten minutes
 *   (FR-23). Below the minimum cell population the match service returns the
 *   empty state and the edge passes it through untouched (FR-26).
 *
 * The response carries bands and reasons, never coordinates or metres
 * (FR-25), and never identity before OPEN (FR-30).
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext, SUPPRESSION_TTL_S, suppressionKey } from "../context.js";

const SCAN_RATE_MAX = 6;        // FR-24
const SCAN_RATE_WINDOW = "1 minute";

interface MatchScanResponse {
  state: "ok" | "quiet";
  results: Array<{
    userId: string;
    score: number;
    band: string;
    reasons: unknown[];
    icebreaker: string;
  }>;
}

export function registerScanRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/scan",
    { config: { rateLimit: { max: SCAN_RATE_MAX, timeWindow: SCAN_RATE_WINDOW, keyGenerator: (req) => req.userId } } },
    async (req, reply) => {
      const userId = req.userId;

      const presence = await ctx.valkey.get(`presence:user:${userId}`);
      if (!presence) {
        return reply.code(409).send({ error: "no live presence; enter a venue first" });
      }
      const { cell, venueId } = JSON.parse(presence) as { cell: string; venueId?: string | null };

      // FR-23: who is suppressed for this requester right now?
      const suppressed: string[] = [];
      let cursor = "0";
      do {
        const [next, keys] = await ctx.valkey.scan(cursor, "MATCH", `suppress:${userId}:*`, "COUNT", 100);
        cursor = next;
        for (const k of keys) suppressed.push(k.split(":").pop()!);
      } while (cursor !== "0");
      // suppression keys are canonically ordered; also scan the flipped side
      cursor = "0";
      do {
        const [next, keys] = await ctx.valkey.scan(cursor, "MATCH", `suppress:*:${userId}`, "COUNT", 100);
        cursor = next;
        for (const key of keys) {
          const other = key.split(":")[1];
          if (other !== userId) suppressed.push(other);
        }
      } while (cursor !== "0");

      // TR-11: venue threshold configuration
      let venue: { baseThreshold?: number; maxResults?: number } = {};
      if (venueId) {
        const rows = await ctx.pg.query(
          "SELECT base_threshold, max_scan_results FROM venues WHERE venue_id = $1 AND active",
          [venueId],
        );
        if (rows.rows.length) {
          venue = {
            baseThreshold: rows.rows[0].base_threshold,
            maxResults: rows.rows[0].max_scan_results,
          };
        }
      }

      const res = await fetch(`${ctx.matchServiceUrl}/v1/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, cell, venue, exclude: suppressed }),
      });
      if (!res.ok) {
        return reply.code(502).send({ error: "match service unavailable" });
      }
      const body = (await res.json()) as MatchScanResponse;

      // FR-23: suppress every surfaced pair for ten minutes.
      if (body.results.length > 0) {
        const pipe = ctx.valkey.pipeline();
        for (const r of body.results) {
          pipe.set(suppressionKey(userId, r.userId), "1", "EX", SUPPRESSION_TTL_S);
        }
        await pipe.exec();
      }

      // FR-29: the first surfacing of a pair records DETECTED in the
      // append-only ledger (idempotent — later scans find the pair exists).
      if (body.results.length > 0) {
        await withRls(ctx.pg, userId, async (c) => {
          for (const r of body.results) {
            const [lo, hi] = userId < r.userId ? [userId, r.userId] : [r.userId, userId];
            const inserted = await c.query(
              `INSERT INTO matches (user_lo, user_hi) VALUES ($1, $2)
               ON CONFLICT (user_lo, user_hi) DO NOTHING RETURNING pair_id`,
              [lo, hi],
            );
            if (inserted.rows.length) {
              await c.query(
                `INSERT INTO consent_ledger (pair_id, actor, from_state, to_state)
                 VALUES ($1, NULL, NULL, 'DETECTED')`,
                [inserted.rows[0].pair_id],
              );
            }
          }
        });
      }

      // FR-30: no identity fields leave the edge before OPEN — the payload is
      // score, band, reasons only.
      return reply.send(body);
    },
  );
}
