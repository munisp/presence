/**
 * Content routes: announcements, venue offers, reports (PRS-SRS-001 §5.5).
 *
 *   GET  /v1/announcements?venueId= — live announcements (venue + global);
 *                                     removed rows never surface (FR-98)
 *   GET  /v1/offers?venueId=        — offers inside their validity window
 *   POST /v1/reports                — file a report against another user or
 *                                     an announcement; two reports in ten
 *                                     minutes remove the announcement (FR-98)
 *
 * TR-23: query/body carry strict JSON Schemas — unknown fields fail
 * validation (400) before the handler runs.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext, publishRealtime } from "../context.js";

export function registerContentRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get(
    "/v1/announcements",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { venueId: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const { venueId } = req.query as { venueId?: string };
      const rows = await ctx.pg.query(
        `SELECT announcement_id, venue_id, category, body, publish_at, expire_at
           FROM announcements
          WHERE now() BETWEEN publish_at AND expire_at
            AND removed_at IS NULL
            AND (venue_id IS NULL OR venue_id = $1)
          ORDER BY publish_at DESC`,
        [venueId ?? null],
      );
      return reply.send({ announcements: rows.rows });
    },
  );

  app.get(
    "/v1/offers",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["venueId"],
          additionalProperties: false,
          properties: { venueId: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
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
    },
  );

  app.post(
    "/v1/reports",
    {
      schema: {
        body: {
          type: "object",
          required: ["reason"],
          additionalProperties: false,
          properties: {
            reported: { type: "string", format: "uuid" },
            venueId: { type: "string" },
            announcementId: { type: "string", format: "uuid" },
            reason: { type: "string", minLength: 1 },
            details: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        reported?: string;
        venueId?: string;
        announcementId?: string;
        reason?: string;
        details?: string;
      };
      if (!body.reason) {
        return reply.code(422).send({ error: "reason is required" });
      }
      if (!body.reported && !body.announcementId) {
        return reply.code(422).send({ error: "reported or announcementId is required" });
      }
      if (body.reported === req.userId) {
        return reply.code(422).send({ error: "cannot report yourself" });
      }

      let removedPublisher: string | null = null;
      try {
        const id = await withRls(ctx.pg, req.userId, async (c) => {
          let reported = body.reported ?? null;
          let venueId = body.venueId ?? null;
          if (body.announcementId) {
            // FR-98: an announcement report names the announcement; the edge
            // resolves its publisher server-side — announcements never expose
            // the publisher id to readers.
            const ann = await c.query(
              "SELECT publisher, venue_id FROM announcements WHERE announcement_id = $1",
              [body.announcementId],
            );
            if (ann.rows.length === 0) {
              throw Object.assign(new Error("announcement not found"), { code: 404 });
            }
            reported = reported ?? (ann.rows[0].publisher as string);
            venueId = venueId ?? (ann.rows[0].venue_id as string | null);
          }
          if (!reported) {
            throw Object.assign(new Error("reported or announcementId is required"), { code: 422 });
          }
          if (reported === req.userId) {
            throw Object.assign(new Error("cannot report yourself"), { code: 422 });
          }
          const r = await c.query(
            `INSERT INTO reports (reporter, reported, venue_id, announcement_id, reason, details)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING report_id`,
            [req.userId, reported, venueId, body.announcementId ?? null, body.reason, body.details ?? null],
          );
          if (body.announcementId) {
            // FR-98: two reports in ten minutes remove the announcement; the
            // rows and the removal reason are retained as evidence.
            const removed = await c.query("SELECT maybe_remove_announcement($1) AS publisher", [
              body.announcementId,
            ]);
            removedPublisher = removed.rows[0]?.publisher ?? null;
          }
          return r.rows[0].report_id as string;
        });

        if (removedPublisher) {
          // FR-98: the publisher is told their announcement came down; the
          // channel carries no reporter information.
          await publishRealtime(ctx, `user:${removedPublisher}`, {
            type: "announcement_removed",
            announcementId: body.announcementId,
          }).catch((err) => console.error("centrifugo publish failed", err));
        }

        return reply.code(201).send({
          reportId: id,
          status: "open",
          announcementRemoved: removedPublisher != null,
        });
      } catch (err) {
        const e = err as { code?: number; message?: string };
        if (e.code === 404) return reply.code(404).send({ error: "announcement not found" });
        if (e.code === 422) return reply.code(422).send({ error: e.message });
        throw err;
      }
    },
  );
}
