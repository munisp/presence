/**
 * Announcement routes (PRS-SRS-001 §4.10) — broadcast announcements with a
 * trust floor, and inverted-consent responses.
 *
 *   POST /v1/announcements                                — FR-93/95/96/97:
 *     publish. Declared, unblocked accounts at least 24 h old only; one live
 *     announcement per account; one publish per 24 h; TTL capped at 4 h;
 *     body screened; 'work' reserved for verified-organisation tokens (BR-33).
 *   POST /v1/announcements/:announcementId/respond        — FR-94/95: one
 *     screened response per account per announcement.
 *   GET  /v1/announcements/:announcementId/responses      — SEC-38: publisher
 *     only, at most five, responder identity masked until acceptance.
 *   POST /v1/announcements/:announcementId/responses/:responseId/accept
 *                                                         — FR-94: accepting
 *     reveals the responder to the publisher.
 *
 * Auto-removal (FR-98) lives in the reports route: two reports in ten
 * minutes remove an announcement; the evidence is retained.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import {
  ANNOUNCEMENT_CATEGORIES,
  canPublishCategory,
  effectiveTtlMinutes,
  isTrustedPublisher,
  publicResponse,
  RESPONSES_SHOWN_MAX,
} from "../announcements.js";
import { EdgeContext } from "../context.js";
import { venueFeatureEnabled } from "../features.js";
import { SCREENING_EXPLANATION, screenText } from "../screening.js";

export function registerAnnouncementRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/announcements",
    {
      // TR-23: strict body — unknown fields fail validation with a 400.
      schema: {
        body: {
          type: "object",
          required: ["body", "category"],
          additionalProperties: false,
          properties: {
            venueId: { type: "string" },
            body: { type: "string", minLength: 1, maxLength: 500 },
            category: { type: "string", enum: [...ANNOUNCEMENT_CATEGORIES] },
            ttlMinutes: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
    const { venueId, body, category, ttlMinutes } = req.body as {
      venueId?: string;
      body: string;
      category: string;
      ttlMinutes?: number;
    };
    const userId = req.userId;

    // FR-63: venues can switch the announcement surface off.
    if (venueId && !(await venueFeatureEnabled(ctx.pg, venueId, "announcements"))) {
      return reply.code(403).send({ error: "announcements are disabled at this venue (FR-63)" });
    }

    // FR-93 trust floor: declared, unblocked, at least 24 h old.
    const account = await ctx.pg.query(
      "SELECT created_at, age_declared_at, age_blocked, deleted_at FROM users WHERE user_id = $1",
      [userId],
    );
    if (
      account.rows.length === 0 ||
      !isTrustedPublisher({
        createdAt: account.rows[0].created_at,
        ageDeclaredAt: account.rows[0].age_declared_at,
        ageBlocked: account.rows[0].age_blocked,
        deletedAt: account.rows[0].deleted_at,
      })
    ) {
      return reply.code(403).send({
        error: "announcements require an account at least 24 hours old (FR-93)",
      });
    }

    // FR-97: the work category is reserved for verified organisations (BR-33).
    const claims = (req as unknown as { user?: { verified_org?: unknown } }).user;
    const verifiedOrg = claims?.verified_org === true;
    if (!canPublishCategory(category, verifiedOrg)) {
      return reply.code(403).send({
        error: "the work category requires a verified organisation (FR-97)",
      });
    }

    // FR-96/SEC-37: bodies are screened before storage; the explanation
    // names categories, never the matched text.
    const findings = screenText(body);
    if (findings.length > 0) {
      const categories = [...new Set(findings.map((f) => SCREENING_EXPLANATION[f.category]))];
      return reply.code(422).send({
        error: `announcement cannot contain ${categories.join(", ")}`,
        categories: findings.map((f) => f.category),
      });
    }

    // FR-95: one live announcement per account.
    const live = await ctx.pg.query(
      `SELECT 1 FROM announcements
        WHERE publisher = $1 AND expire_at > now() AND removed_at IS NULL
        LIMIT 1`,
      [userId],
    );
    if (live.rows.length > 0) {
      return reply.code(409).send({ error: "one live announcement per account (FR-95)" });
    }

    // FR-95: one publish per 24 h.
    const recent = await ctx.pg.query(
      "SELECT max(publish_at) AS last FROM announcements WHERE publisher = $1",
      [userId],
    );
    const last = recent.rows[0]?.last as Date | null;
    if (last && Date.now() - new Date(last).getTime() < 24 * 3_600_000) {
      return reply.code(429).send({ error: "one announcement per 24 hours (FR-95)" });
    }

    const ttl = effectiveTtlMinutes(ttlMinutes);
    const inserted = await ctx.pg.query(
      `INSERT INTO announcements (venue_id, publisher, body, category, publish_at, expire_at)
       VALUES ($1, $2, $3, $4, now(), now() + ($5 || ' minutes')::interval)
       RETURNING announcement_id, publish_at, expire_at`,
      [venueId ?? null, userId, body, category, ttl],
    );
    const row = inserted.rows[0];
    return reply.code(201).send({
      announcementId: row.announcement_id,
      category,
      ttlMinutes: ttl,
      publishAt: row.publish_at,
      expireAt: row.expire_at,
    });
    },
  );

  app.post(
    "/v1/announcements/:announcementId/respond",
    {
      // TR-23: strict body.
      schema: {
        body: {
          type: "object",
          required: ["body"],
          additionalProperties: false,
          properties: { body: { type: "string", minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (req, reply) => {
    const { announcementId } = req.params as { announcementId: string };
    const { body } = req.body as { body: string };

    // FR-96/SEC-37: responses are screened like announcement bodies.
    const findings = screenText(body);
    if (findings.length > 0) {
      const categories = [...new Set(findings.map((f) => SCREENING_EXPLANATION[f.category]))];
      return reply.code(422).send({
        error: `response cannot contain ${categories.join(", ")}`,
        categories: findings.map((f) => f.category),
      });
    }

    try {
      const responseId = await withRls(ctx.pg, req.userId, async (c) => {
        const ann = await c.query(
          `SELECT publisher, expire_at, removed_at FROM announcements
            WHERE announcement_id = $1`,
          [announcementId],
        );
        if (ann.rows.length === 0) {
          throw Object.assign(new Error("announcement not found"), { code: 404 });
        }
        const row = ann.rows[0];
        if (row.removed_at || new Date(row.expire_at) <= new Date()) {
          throw Object.assign(new Error("announcement is no longer live"), { code: 409 });
        }
        if (row.publisher === req.userId) {
          throw Object.assign(new Error("cannot respond to your own announcement"), { code: 409 });
        }
        // FR-95: one response per account per announcement — the UNIQUE
        // (announcement_id, responder) constraint is the enforcement.
        const ins = await c.query(
          `INSERT INTO announcement_responses (announcement_id, responder, body)
           VALUES ($1, $2, $3) RETURNING response_id`,
          [announcementId, req.userId, body],
        );
        return ins.rows[0].response_id as string;
      });
      return reply.code(201).send({ ok: true, responseId });
    } catch (err) {
      const e = err as { code?: number | string; message?: string };
      if (e.code === 404) return reply.code(404).send({ error: "announcement not found" });
      if (e.code === 409) return reply.code(409).send({ error: e.message });
      if (e.code === "23505") {
        return reply.code(409).send({ error: "one response per announcement (FR-95)" });
      }
      throw err;
    }
    },
  );

  app.get("/v1/announcements/:announcementId/responses", async (req, reply) => {
    const { announcementId } = req.params as { announcementId: string };
    try {
      const rows = await withRls(ctx.pg, req.userId, async (c) => {
        const ann = await c.query(
          "SELECT publisher FROM announcements WHERE announcement_id = $1",
          [announcementId],
        );
        if (ann.rows.length === 0) {
          throw Object.assign(new Error("announcement not found"), { code: 404 });
        }
        // SEC-38: only the publisher may enumerate responses at all.
        if (ann.rows[0].publisher !== req.userId) {
          throw Object.assign(new Error("only the publisher can read responses (SEC-38)"), {
            code: 403,
          });
        }
        // FR-95: at most five responses are ever shown.
        return c.query(
          `SELECT response_id, responder, body, created_at, accepted_at
             FROM announcement_responses
            WHERE announcement_id = $1 AND withdrawn_at IS NULL
            ORDER BY created_at ASC
            LIMIT ${RESPONSES_SHOWN_MAX}`,
          [announcementId],
        );
      });

      // FR-94/SEC-38: responder identity is masked until acceptance.
      return reply.send({
        announcementId,
        responses: rows.rows.map((r: Record<string, unknown>) =>
          publicResponse({
            responseId: r.response_id as string,
            body: r.body as string,
            createdAt: r.created_at,
            acceptedAt: r.accepted_at,
            responder: r.responder as string,
          }),
        ),
      });
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e.code === 404) return reply.code(404).send({ error: "announcement not found" });
      if (e.code === 403) return reply.code(403).send({ error: e.message });
      throw err;
    }
  });

  app.post(
    "/v1/announcements/:announcementId/responses/:responseId/accept",
    async (req, reply) => {
    const { announcementId, responseId } = req.params as {
      announcementId: string;
      responseId: string;
    };
    try {
      await withRls(ctx.pg, req.userId, async (c) => {
        const ann = await c.query(
          "SELECT publisher FROM announcements WHERE announcement_id = $1",
          [announcementId],
        );
        if (ann.rows.length === 0) {
          throw Object.assign(new Error("announcement not found"), { code: 404 });
        }
        if (ann.rows[0].publisher !== req.userId) {
          throw Object.assign(new Error("only the publisher can accept responses (FR-94)"), {
            code: 403,
          });
        }
        // FR-94: acceptance reveals the responder to the publisher.
        const updated = await c.query(
          `UPDATE announcement_responses
              SET accepted_at = now()
            WHERE response_id = $1 AND announcement_id = $2 AND accepted_at IS NULL
            RETURNING response_id`,
          [responseId, announcementId],
        );
        if (updated.rows.length === 0) {
          throw Object.assign(new Error("response not found or already accepted"), { code: 404 });
        }
      });
      return reply.send({ ok: true, responseId, accepted: true });
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e.code === 404) return reply.code(404).send({ error: e.message });
      if (e.code === 403) return reply.code(403).send({ error: e.message });
      throw err;
    }
    },
  );
}
