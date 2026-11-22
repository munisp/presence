/**
 * Content routes: announcements, venue offers, reports (PRS-SRS-001 §5.5).
 *
 *   GET  /v1/announcements?venueId= — live announcements (venue + global)
 *   GET  /v1/offers?venueId=        — offers inside their validity window
 *   POST /v1/reports                — file a report against another user
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";

export function registerContentRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get("/v1/announcements", async (req, reply) => {
    const { venueId } = req.query as { venueId?: string };
    const rows = await ctx.pg.query(
      `SELECT announcement_id, venue_id, body, publish_at, expire_at
         FROM announcements
        WHERE now() BETWEEN publish_at AND expire_at
          AND (venue_id IS NULL OR venue_id = $1)
        ORDER BY publish_at DESC`,
      [venueId ?? null],
    );
    return reply.send({ announcements: rows.rows });
  });

  app.get("/v1/offers", async (req, reply) => {
    const { venueId } = req.query as { venueId?: string };
    if (!venueId) return reply.code(422).send({ error: "venueId is required" });
    const rows = await ctx.pg.query(
      `SELECT offer_id, title, terms, starts_at, ends_at
         FROM offers
        WHERE venue_id = $1 AND now() BETWEEN starts_at AND ends_at
        ORDER BY ends_at ASC`,
      [venueId],
    );
    return reply.send({ offers: rows.rows });
  });

  app.post("/v1/reports", async (req, reply) => {
    const body = req.body as { reported?: string; venueId?: string; reason?: string; details?: string };
    if (!body.reported || !body.reason) {
      return reply.code(422).send({ error: "reported and reason are required" });
    }
    if (body.reported === req.userId) {
      return reply.code(422).send({ error: "cannot report yourself" });
    }
    const id = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(
        `INSERT INTO reports (reporter, reported, venue_id, reason, details)
         VALUES ($1, $2, $3, $4, $5) RETURNING report_id`,
        [req.userId, body.reported, body.venueId ?? null, body.reason, body.details ?? null],
      );
      return r.rows[0].report_id as string;
    });
    return reply.code(201).send({ reportId: id, status: "open" });
  });
}
