/**
 * Service booking routes (SRS Addendum 001 — AMD-SVC-01..05).
 *
 *   POST /v1/services/bookings                       — AMD-SVC-02: book a
 *     service listing. One transaction — the AMD-INN-03 milestone escrow
 *     (even split, the last part absorbs the remainder) IS the booking;
 *     the listing stays listed.
 *   GET  /v1/services/bookings/mine                  — own bookings, either
 *     role.
 *   GET  /v1/services/bookings/:bookingId            — one booking plus its
 *     append-only event stream, party only (RLS-null answers 404).
 *   POST /v1/services/bookings/:bookingId/start      — the provider marks
 *     work begun; starting stops the 168 h ghosting clock. No value moves.
 *   POST /v1/services/bookings/:bookingId/milestones/:milestone/confirm —
 *     the customer releases one milestone; the last release completes the
 *     escrow and the booking together.
 *   POST /v1/services/bookings/:bookingId/dispute    — either party; the
 *     escrow freezes until moderation resolves.
 *   GET  /v1/moderation/services/disputed            — AMD-SVC-03: the
 *     dispute queue.
 *   POST /v1/moderation/services/:bookingId/resolve  — refund cancels and
 *     returns the remaining milestones; release completes the booking. The
 *     AMD-ESC-01 four-eyes gate applies unchanged above 1,000,000 minor of
 *     remaining value — approval_required answers 202. Audited.
 *
 * AMD-SVC-04 (the stale-booking clocks) is a scheduled definer, not a
 * route: expire_stale_services() runs on the same housekeeping cadence as
 * the swap expirer.
 *
 * Every POST is rate-limited (AMD-OPS-03). Value moves only inside
 * withSettlement behind the WALLET_RAIL kill switch; the definers repeat
 * every gate. No route ever names a raw wallet table.
 */

import { FastifyInstance } from "fastify";
import {
  requireModerator,
  WalletRailUnavailable,
  withRls,
  withSettlement,
} from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  parseServiceBookingBody,
  parseServiceResolutionBody,
  SERVICE_MAX_MILESTONES,
} from "../services.js";

const SERVICE_WRITE_RATE_LIMIT = {
  max: 30,
  timeWindow: "1 minute",
  keyGenerator: (req: { userId: string }) => req.userId,
} as const;

const MODERATION_RATE_LIMIT = {
  max: 120,
  timeWindow: "1 minute",
  keyGenerator: (req: { userId: string }) => req.userId,
} as const;

const uuidParam = (name: string) =>
  ({
    type: "object",
    required: [name],
    additionalProperties: false,
    properties: { [name]: { type: "string", format: "uuid" } },
  }) as const;

const milestoneParams = {
  type: "object",
  required: ["bookingId", "milestone"],
  additionalProperties: false,
  properties: {
    bookingId: { type: "string", format: "uuid" },
    milestone: { type: "integer", minimum: 1, maximum: SERVICE_MAX_MILESTONES },
  },
} as const;

const BOOKING_PROJECTION = `booking_id AS "bookingId", listing_id AS "listingId",
       customer, provider, agreed_minor AS "agreedMinor", currency, milestones,
       escrow_id AS "escrowId", state,
       created_at AS "createdAt", started_at AS "startedAt",
       completed_at AS "completedAt", cancelled_at AS "cancelledAt",
       disputed_at AS "disputedAt"`;

const EVENT_PROJECTION = `event_id AS "eventId", actor,
       from_state AS "fromState", to_state AS "toState", at`;

function railUnavailable(reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  return reply.code(503).send({ error: "wallet rail disabled (AMD-PAY-15)" });
}

export function registerServiceRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // ------------------------------------------------------- AMD-SVC-02 ------
  app.post(
    "/v1/services/bookings",
    { config: { rateLimit: SERVICE_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseServiceBookingBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      try {
        const out = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(
            `SELECT outcome, booking_id AS "bookingId"
               FROM book_service($1, $2, $3)`,
            [parsed.listingId, parsed.agreedMinor, parsed.milestones],
          );
          return r.rows[0] as { outcome: string; bookingId: string | null };
        });
        if (out.outcome === "booked") {
          return reply.code(201).send({ bookingId: out.bookingId });
        }
        if (out.outcome === "forbidden" || out.outcome === "kyc_required"
            || out.outcome === "blocked") {
          return reply.code(403).send({ error: out.outcome });
        }
        if (out.outcome === "unknown_listing") {
          return reply.code(404).send({ error: out.outcome });
        }
        if (out.outcome === "insufficient_funds"
            || out.outcome === "invalid_amount"
            || out.outcome === "invalid_milestones"
            || out.outcome === "invalid_amounts"
            || out.outcome === "wallet_unavailable"
            || out.outcome === "not_a_service"
            || out.outcome === "self") {
          return reply.code(422).send({ error: out.outcome });
        }
        return reply.code(409).send({ error: out.outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.get("/v1/services/bookings/mine", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(
        `SELECT ${BOOKING_PROJECTION}
           FROM service_bookings
          WHERE app_user() IN (customer, provider)
          ORDER BY created_at DESC`,
      );
      return r.rows;
    });
    return reply.send({ bookings: rows });
  });

  app.get(
    "/v1/services/bookings/:bookingId",
    { schema: { params: uuidParam("bookingId") } },
    async (req, reply) => {
      const { bookingId } = req.params as { bookingId: string };
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const b = await c.query(
          `SELECT ${BOOKING_PROJECTION}
             FROM service_bookings
            WHERE booking_id = $1`,
          [bookingId],
        );
        if (b.rows.length === 0) return null;
        const e = await c.query(
          `SELECT ${EVENT_PROJECTION}
             FROM service_events
            WHERE booking_id = $1
            ORDER BY at ASC, event_id ASC`,
          [bookingId],
        );
        return { booking: b.rows[0], events: e.rows };
      });
      // RLS-null answers 404 — booking existence is never leaked.
      if (out === null) {
        return reply.code(404).send({ error: "unknown_booking" });
      }
      return reply.send(out);
    },
  );

  app.post(
    "/v1/services/bookings/:bookingId/start",
    {
      config: { rateLimit: SERVICE_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("bookingId") },
    },
    async (req, reply) => {
      const { bookingId } = req.params as { bookingId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT start_service($1) AS outcome`, [bookingId]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "started") return reply.send({ state: "started" });
      if (outcome === "unknown_booking") return reply.code(404).send({ error: outcome });
      if (outcome === "forbidden") return reply.code(403).send({ error: outcome });
      return reply.code(409).send({ error: outcome });
    },
  );

  app.post(
    "/v1/services/bookings/:bookingId/milestones/:milestone/confirm",
    {
      config: { rateLimit: SERVICE_WRITE_RATE_LIMIT },
      schema: { params: milestoneParams },
    },
    async (req, reply) => {
      const { bookingId, milestone } = req.params as {
        bookingId: string;
        milestone: number;
      };
      try {
        const outcome = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(
            `SELECT confirm_service_milestone($1, $2::smallint) AS outcome`,
            [bookingId, milestone],
          );
          return r.rows[0].outcome as string;
        });
        if (outcome === "confirmed") return reply.send({ state: "confirmed" });
        if (outcome === "completed") return reply.send({ state: "completed" });
        if (outcome === "unknown_booking" || outcome === "unknown_escrow"
            || outcome === "unknown_milestone") {
          return reply.code(404).send({ error: outcome });
        }
        if (outcome === "forbidden") return reply.code(403).send({ error: outcome });
        return reply.code(409).send({ error: outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.post(
    "/v1/services/bookings/:bookingId/dispute",
    {
      config: { rateLimit: SERVICE_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("bookingId") },
    },
    async (req, reply) => {
      const { bookingId } = req.params as { bookingId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT dispute_service($1) AS outcome`, [bookingId]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "disputed") return reply.send({ state: "disputed" });
      if (outcome === "unknown_booking") return reply.code(404).send({ error: outcome });
      if (outcome === "forbidden") return reply.code(403).send({ error: outcome });
      return reply.code(409).send({ error: outcome });
    },
  );

  // ------------------------------------------------------- AMD-SVC-03 ------
  app.get(
    "/v1/moderation/services/disputed",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
    },
    async (req, reply) => {
      const rows = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT ${BOOKING_PROJECTION}
             FROM service_bookings
            WHERE state = 'disputed'
            ORDER BY disputed_at ASC`,
        );
        return r.rows;
      });
      return reply.send({ disputed: rows });
    },
  );

  app.post(
    "/v1/moderation/services/:bookingId/resolve",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: uuidParam("bookingId") },
    },
    async (req, reply) => {
      const parsed = parseServiceResolutionBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const { bookingId } = req.params as { bookingId: string };
      try {
        const outcome = await withSettlement(
          ctx.pg,
          req.userId,
          async (c) => {
            const r = await c.query(
              `SELECT resolve_service($1, $2) AS outcome`,
              [bookingId, parsed.decision],
            );
            return r.rows[0].outcome as string;
          },
          "app.moderator",
        );
        if (outcome === "resolved") return reply.send({ state: "resolved" });
        // AMD-ESC-01: above the four-eyes threshold the request is recorded
        // and no value moves — a second moderator must approve.
        if (outcome === "approval_required") {
          return reply.code(202).send({ state: "approval_required" });
        }
        if (outcome === "invalid_decision") {
          return reply.code(400).send({ error: outcome });
        }
        if (outcome === "unknown_booking") return reply.code(404).send({ error: outcome });
        if (outcome === "forbidden") return reply.code(403).send({ error: outcome });
        return reply.code(409).send({ error: outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );
}
