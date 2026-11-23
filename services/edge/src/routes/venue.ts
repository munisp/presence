/**
 * Venue dashboard route (PRS-SRS-001 §3.6, BR-12/BR-13).
 *
 *   GET /v1/venues/:venueId/dashboard — aggregate-only metrics for venue
 *   partners. Every figure passes through k-anonymity suppression (BR-13,
 *   k = 11): when fewer than k individuals stand behind a number the venue
 *   sees null, never the small number. No user-level data is ever served.
 *
 * Access is limited to tokens carrying the venue id in their venue_ids
 * claim (BR-12): a partner sees their own venues only.
 *
 * Metric breadth note: the dashboard covers presence, scan volume, live
 * offers and live announcements; match-funnel attribution arrives with the
 * FR-43 analytics milestone.
 */

import { FastifyInstance } from "fastify";
import { kSuppressed, K_MIN } from "../aggregate.js";
import { EdgeContext } from "../context.js";

export function registerVenueRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get("/v1/venues/:venueId/dashboard", async (req, reply) => {
    const { venueId } = req.params as { venueId: string };

    // BR-12: venue partner tokens only, and only for their own venues. The
    // venue_ids claim is populated by jwtVerify from the access token.
    const claims = (req as unknown as { user?: { venue_ids?: unknown } }).user;
    const venueIds = Array.isArray(claims?.venue_ids) ? (claims!.venue_ids as string[]) : [];
    if (!venueIds.includes(venueId)) {
      return reply.code(403).send({ error: "venue partner token required (BR-12)" });
    }

    const livePresence = await ctx.valkey.scard(`presence:venue:${venueId}`);
    const scansRaw = await ctx.valkey.get(`stats:venue:${venueId}:scans:h`);
    const scansLastHour = scansRaw ? Number.parseInt(scansRaw, 10) : 0;

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
    });
  });
}
