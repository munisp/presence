/**
 * Venue routes (PRS-SRS-001 §3.6, BR-12/BR-13/BR-14, FR-42).
 *
 *   GET  /v1/venues/:venueId/dashboard — aggregate-only metrics for venue
 *     partners. Every figure passes through k-anonymity suppression (BR-13,
 *     k = 11): when fewer than k individuals stand behind a number the
 *     venue sees null, never the small number. No user-level data is ever
 *     served.
 *   GET  /v1/venues/:venueId/registry — FR-42: the venue's registry entry:
 *     geospatial cells (the attribution projection), partner status and
 *     operating schedule.
 *   PUT  /v1/venues/:venueId/schedule — FR-42: replace the operating
 *     schedule (validated server-side by the registry constraint).
 *   POST /v1/venues/:venueId/suspend — BR-14: self-serve suspension. The
 *     venue flips inactive immediately and its live presence set is
 *     purged — the suspension is effective well within one presence TTL.
 *   POST /v1/venues/:venueId/resume — BR-14: end a self-serve suspension.
 *   POST /v1/venues/:venueId/offboard — venue-ops console only: terminal
 *     offboarding.
 *
 * Partner access is limited to tokens carrying the venue id in their
 * venue_ids claim (BR-12): a partner sees and operates their own venues
 * only. Every registry mutation lands in admin_audit (FR-60) via the
 * SECURITY DEFINER functions — the app role holds no write grant on
 * venues.
 *
 * Metric breadth note: the dashboard covers presence, scan volume, live
 * offers and live announcements; match-funnel attribution arrives with
 * the FR-43 analytics milestone.
 */

import { FastifyInstance } from "fastify";
import { kSuppressed, K_MIN } from "../aggregate.js";
import { requireVenueOps } from "../auth.js";
import { EdgeContext } from "../context.js";

const UUID_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: { venueId: { type: "string", format: "uuid" } },
  required: ["venueId"],
} as const;

const SCHEDULE_BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    schedule: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        timezone: { type: "string", minLength: 1, maxLength: 64 },
        weekly: {
          type: "array",
          maxItems: 21,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["day", "open", "close"],
            properties: {
              day: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
              open: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
              close: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
            },
          },
        },
      },
    },
  },
  required: ["schedule"],
} as const;

/** BR-12: the venue_ids claim must carry the venue being operated. */
function venueClaimOk(req: unknown, venueId: string): boolean {
  const claims = (req as { user?: { venue_ids?: unknown } }).user;
  const venueIds = Array.isArray(claims?.venue_ids) ? (claims!.venue_ids as string[]) : [];
  return venueIds.includes(venueId);
}

/**
 * BR-14: a suspension takes effect at once — the venue's live presence set
 * is dropped and each member's entry loses its venue attribution (cell
 * presence is untouched; the TTL still bounds what remains).
 * FR-43: event attribution goes with the venue — entries lose their eventId
 * and leave the per-event live sets they were attributed to.
 */
export async function purgeVenuePresence(ctx: EdgeContext, venueId: string): Promise<void> {
  const members = await ctx.valkey.smembers(`presence:venue:${venueId}`);
  const pipe = ctx.valkey.pipeline();
  for (const uid of members) {
    pipe.get(`presence:user:${uid}`);
  }
  const entries = members.length > 0 ? await pipe.exec() : [];
  const writes = ctx.valkey.pipeline();
  for (const [i, uid] of members.entries()) {
    const raw = entries?.[i]?.[1] as string | null;
    if (!raw) continue;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    if (entry.venueId !== venueId) continue;
    delete entry.venueId;
    delete entry.floorId;
    if (typeof entry.eventId === "string") {
      writes.srem(`presence:event:${entry.eventId}`, uid);
      delete entry.eventId;
    }
    // Preserve the remaining TTL — presence still expires on schedule. XX
    // keeps a key that expired between the read and this write from being
    // resurrected without a TTL.
    writes.set(`presence:user:${uid}`, JSON.stringify(entry), "KEEPTTL", "XX");
  }
  writes.del(`presence:venue:${venueId}`);
  await writes.exec();
}

export function registerVenueRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get("/v1/venues/:venueId/dashboard", async (req, reply) => {
    const { venueId } = req.params as { venueId: string };

    // BR-12: venue partner tokens only, and only for their own venues. The
    // venue_ids claim is populated by jwtVerify from the access token.
    if (!venueClaimOk(req, venueId)) {
      return reply.code(403).send({ error: "venue partner token required (BR-12)" });
    }

    const livePresence = await ctx.valkey.scard(`presence:venue:${venueId}`);
    const scansRaw = await ctx.valkey.get(`stats:venue:${venueId}:scans:h`);
    const scansLastHour = scansRaw ? Number.parseInt(scansRaw, 10) : 0;

    // FR-43: when the venue hosts a live event, the dashboard reports it —
    // presence inside the window is attributable to the event, and the
    // per-event live set feeds the (k-suppressed) event presence figure.
    const ev = await ctx.pg.query(
      `SELECT event_id AS "eventId", name,
              starts_at AS "startsAt", ends_at AS "endsAt"
         FROM events
        WHERE venue_id = $1 AND starts_at <= now() AND ends_at > now()
        ORDER BY starts_at DESC
        LIMIT 1`,
      [venueId],
    );
    const liveEvent = ev.rows.length > 0 ? ev.rows[0] : null;
    const liveEventPresence = liveEvent
      ? await ctx.valkey.scard(`presence:event:${liveEvent.eventId}`)
      : 0;

    const offerRows = await ctx.pg.query(
      "SELECT count(*)::int AS n FROM offers WHERE venue_id = $1 AND starts_at <= now() AND ends_at > now()",
      [venueId],
    );
    const announcementRows = await ctx.pg.query(
      `SELECT count(*)::int AS n FROM announcements
        WHERE venue_id = $1 AND publish_at <= now() AND expire_at > now() AND removed_at IS NULL`,
      [venueId],
    );

    // BR-13: every figure is k-suppressed — below k the value is null.
    return reply.send({
      venueId,
      k: K_MIN,
      livePresence: kSuppressed(livePresence),
      scansLastHour: kSuppressed(scansLastHour),
      activeOffers: kSuppressed(offerRows.rows[0].n),
      liveAnnouncements: kSuppressed(announcementRows.rows[0].n),
      liveEvent,
      liveEventPresence: kSuppressed(liveEventPresence),
    });
  });

  // FR-42: the registry entry — cells, partner status, operating schedule.
  app.get(
    "/v1/venues/:venueId/registry",
    { schema: { params: UUID_PARAMS } },
    async (req, reply) => {
      const { venueId } = req.params as { venueId: string };
      if (!venueClaimOk(req, venueId)) {
        return reply.code(403).send({ error: "venue partner token required (BR-12)" });
      }
      const venue = await ctx.pg.query(
        `SELECT venue_id AS "venueId", name, partner_status AS "partnerStatus",
                operating_schedule AS "operatingSchedule", suspended_at AS "suspendedAt",
                h3_res AS "h3Res"
           FROM venues WHERE venue_id = $1`,
        [venueId],
      );
      if (venue.rows.length === 0) {
        return reply.code(404).send({ error: "venue not found" });
      }
      const cells = await ctx.pg.query(
        "SELECT cell FROM cell_attribution WHERE venue_id = $1 ORDER BY cell",
        [venueId],
      );
      // FR-43: the registry names the event currently live at the venue, if
      // any, so an operator can see what the presence window attributes to.
      const ev = await ctx.pg.query(
        `SELECT event_id AS "eventId", name,
                starts_at AS "startsAt", ends_at AS "endsAt"
           FROM events
          WHERE venue_id = $1 AND starts_at <= now() AND ends_at > now()
          ORDER BY starts_at DESC
          LIMIT 1`,
        [venueId],
      );
      return reply.send({
        ...venue.rows[0],
        cells: cells.rows.map((r) => r.cell as string),
        liveEvent: ev.rows.length > 0 ? ev.rows[0] : null,
      });
    },
  );

  // FR-42: replace the operating schedule. The database constraint is the
  // final arbiter of the shape; the route schema rejects malformed input
  // early with the usual 400.
  app.put(
    "/v1/venues/:venueId/schedule",
    { schema: { params: UUID_PARAMS, body: SCHEDULE_BODY } },
    async (req, reply) => {
      const { venueId } = req.params as { venueId: string };
      if (!venueClaimOk(req, venueId)) {
        return reply.code(403).send({ error: "venue partner token required (BR-12)" });
      }
      const { schedule } = req.body as { schedule: unknown };
      try {
        const res = await ctx.pg.query(
          "SELECT venue_set_schedule($1::uuid, $2::uuid, $3::jsonb) AS result",
          [venueId, req.userId, JSON.stringify(schedule ?? null)],
        );
        return reply.send(res.rows[0].result);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "P0002") return reply.code(404).send({ error: "venue not found" });
        if (code === "23514") {
          return reply.code(422).send({ error: "invalid operating schedule shape (FR-42)" });
        }
        throw e;
      }
    },
  );

  // BR-14: self-serve suspension — the venue's own decision, effective at
  // once (well within the one-business-day allowance and the 15-minute
  // presence TTL the spec binds it to).
  app.post(
    "/v1/venues/:venueId/suspend",
    { schema: { params: UUID_PARAMS } },
    async (req, reply) => {
      const { venueId } = req.params as { venueId: string };
      if (!venueClaimOk(req, venueId)) {
        return reply.code(403).send({ error: "venue partner token required (BR-12)" });
      }
      try {
        const res = await ctx.pg.query(
          "SELECT venue_suspend($1::uuid, $2::uuid) AS result",
          [venueId, req.userId],
        );
        await purgeVenuePresence(ctx, venueId);
        return reply.send(res.rows[0].result);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "P0002") return reply.code(404).send({ error: "venue not found" });
        if (code === "P0001") return reply.code(409).send({ error: "venue is offboarded" });
        throw e;
      }
    },
  );

  // BR-14: resume reverses a self-serve suspension.
  app.post(
    "/v1/venues/:venueId/resume",
    { schema: { params: UUID_PARAMS } },
    async (req, reply) => {
      const { venueId } = req.params as { venueId: string };
      if (!venueClaimOk(req, venueId)) {
        return reply.code(403).send({ error: "venue partner token required (BR-12)" });
      }
      try {
        const res = await ctx.pg.query(
          "SELECT venue_resume($1::uuid, $2::uuid) AS result",
          [venueId, req.userId],
        );
        return reply.send(res.rows[0].result);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "P0002") return reply.code(404).send({ error: "venue not found" });
        if (code === "P0001") return reply.code(409).send({ error: "venue is not suspended" });
        throw e;
      }
    },
  );

  // FR-42: offboarding is terminal and venue-ops only — never self-serve.
  app.post(
    "/v1/venues/:venueId/offboard",
    { schema: { params: UUID_PARAMS }, preHandler: requireVenueOps },
    async (req, reply) => {
      const { venueId } = req.params as { venueId: string };
      try {
        const res = await ctx.pg.query(
          "SELECT venue_offboard($1::uuid, $2::uuid) AS result",
          [venueId, req.userId],
        );
        await purgeVenuePresence(ctx, venueId);
        return reply.send(res.rows[0].result);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "P0002") return reply.code(404).send({ error: "venue not found" });
        if (code === "P0001") return reply.code(409).send({ error: "venue is already offboarded" });
        throw e;
      }
    },
  );
}
