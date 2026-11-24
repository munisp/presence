/**
 * Content routes: announcements, venue offers, reports (PRS-SRS-001 §5.5).
 *
 *   GET  /v1/announcements?venueId= — live announcements (venue + global);
 *                                     removed rows never surface (FR-98)
 *   GET  /v1/offers?venueId=        — offers inside their validity window
 *   POST /v1/reports                — file a report against another user, an
 *                                     announcement, or from inside a
 *                                     conversation (anchored to the pair and
 *                                     optionally one message, FR-40) with a
 *                                     fixed category (FR-49); two reports in
 *                                     ten minutes remove the announcement
 *                                     (FR-98)
 *
 * TR-23: query/body carry strict JSON Schemas — unknown fields fail
 * validation (400) before the handler runs.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext, publishRealtime } from "../context.js";
import { REPORT_CATEGORIES, ReportCategory } from "../reports.js";

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
      // BR-14: a suspended venue's announcements stop being served.
      const rows = await ctx.pg.query(
        `SELECT a.announcement_id, a.venue_id, a.category, a.body, a.publish_at, a.expire_at
           FROM announcements a
           LEFT JOIN venues v ON v.venue_id = a.venue_id
          WHERE now() BETWEEN a.publish_at AND a.expire_at
            AND a.removed_at IS NULL
            AND (a.venue_id IS NULL OR (a.venue_id = $1 AND v.active))
          ORDER BY a.publish_at DESC`,
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
      // BR-14: a suspended venue's offers stop being served.
      const rows = await ctx.pg.query(
        `SELECT o.offer_id, o.title, o.terms, o.starts_at, o.ends_at
           FROM offers o
           JOIN venues v ON v.venue_id = o.venue_id AND v.active
          WHERE o.venue_id = $1 AND now() BETWEEN o.starts_at AND o.ends_at
          ORDER BY o.ends_at ASC`,
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
          required: ["reason", "category"],
          additionalProperties: false,
          properties: {
            reported: { type: "string", format: "uuid" },
            venueId: { type: "string" },
            announcementId: { type: "string", format: "uuid" },
            pairId: { type: "string", format: "uuid" },
            messageId: { type: "string", format: "uuid" },
            reason: { type: "string", minLength: 1 },
            category: { type: "string", enum: [...REPORT_CATEGORIES] },
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
        pairId?: string;
        messageId?: string;
        reason?: string;
        category?: ReportCategory;
        details?: string;
      };
      if (!body.reason) {
        return reply.code(422).send({ error: "reason is required" });
      }
      // FR-49: the category is one of six fixed values; the schema enum
      // rejects anything else with a 400 before we get here.
      if (!body.category || !REPORT_CATEGORIES.includes(body.category)) {
        return reply.code(422).send({ error: "category is required" });
      }
      if (!body.reported && !body.announcementId && !body.pairId && !body.messageId) {
        return reply.code(422).send({ error: "reported, announcementId or pairId is required" });
      }
      if (body.reported === req.userId) {
        return reply.code(422).send({ error: "cannot report yourself" });
      }

      let removedPublisher: string | null = null;
      try {
        const id = await withRls(ctx.pg, req.userId, async (c) => {
          let reported = body.reported ?? null;
          let venueId = body.venueId ?? null;
          // FR-40: the in-conversation control anchors the report to the
          // offer identifier (the pair) and optionally to one message in it.
          // Both reads run under RLS, so a pair or message the reporter is
          // not part of is simply "not found" — membership is proven by the
          // row being visible at all.
          let pairId = body.pairId ?? null;
          let messageId = body.messageId ?? null;
          if (messageId) {
            const msg = await c.query("SELECT pair_id FROM messages WHERE message_id = $1", [
              messageId,
            ]);
            if (msg.rows.length === 0) {
              throw Object.assign(new Error("message not found"), { code: 422 });
            }
            const msgPair = msg.rows[0].pair_id as string;
            if (pairId && pairId !== msgPair) {
              throw Object.assign(new Error("message does not belong to this pair"), { code: 422 });
            }
            pairId = msgPair;
          }
          if (pairId) {
            const pair = await c.query(
              "SELECT user_lo, user_hi FROM matches WHERE pair_id = $1",
              [pairId],
            );
            if (pair.rows.length === 0) {
              throw Object.assign(new Error("pair not found"), { code: 422 });
            }
            if (!reported) {
              // A conversation-anchored report defaults to the counterpart.
              reported =
                pair.rows[0].user_lo === req.userId
                  ? (pair.rows[0].user_hi as string)
                  : (pair.rows[0].user_lo as string);
            }
          }
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
            throw Object.assign(new Error("reported, announcementId or pairId is required"), { code: 422 });
          }
          if (reported === req.userId) {
            throw Object.assign(new Error("cannot report yourself"), { code: 422 });
          }
          const r = await c.query(
            `INSERT INTO reports (reporter, reported, venue_id, announcement_id, reason, details, category, pair_id, message_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING report_id`,
            [
              req.userId,
              reported,
              venueId,
              body.announcementId ?? null,
              body.reason,
              body.details ?? null,
              body.category,
              pairId,
              messageId,
            ],
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
