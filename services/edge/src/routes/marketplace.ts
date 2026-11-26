/**
 * Marketplace routes (SRS Addendum 001 — AMD-MKT-01..05).
 *
 *   POST /v1/marketplace/listings                 — AMD-MKT-01/04: create a
 *     draft listing (kind, taxonomy category, price, market — no free text).
 *   GET  /v1/marketplace/listings                 — browse live listings;
 *     RLS limits visibility to KYC-verified callers, and the projection
 *     carries no seller identity (FR-30).
 *   GET  /v1/marketplace/listings/mine            — own listings, any state.
 *   POST /v1/marketplace/listings/:listingId/list — publish a draft.
 *   POST /v1/marketplace/listings/:listingId/remove — seller takedown of a
 *     draft or listed listing.
 *   POST /v1/marketplace/listings/:listingId/purchase — AMD-MKT-03: one
 *     transaction — the single-milestone AMD-INN-03 escrow, the order, the
 *     listing's move to held.
 *   GET  /v1/marketplace/orders                   — own orders, either role.
 *   POST /v1/marketplace/orders/:orderId/confirm  — buyer confirms receipt;
 *     the escrow releases, the listing sells, atomically.
 *   POST /v1/marketplace/orders/:orderId/dispute  — either party; the value
 *     stays held.
 *   POST /v1/moderation/marketplace/listings/:listingId/remove — AMD-MKT-05:
 *     governed-reason takedown, audited. A held listing is never removed
 *     out from under an escrow.
 *   POST /v1/moderation/marketplace/orders/:orderId/resolve — refund
 *     relists; release completes the sale.
 *
 * Every POST is rate-limited (AMD-OPS-03). Value moves only inside
 * withSettlement behind the WALLET_RAIL kill switch; the definers repeat
 * every gate. No route ever names a raw wallet table.
 */

import { FastifyInstance } from "fastify";
import {
  requireModerator,
  WalletRailUnavailable,
  withModerator,
  withRls,
  withSettlement,
} from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  MARKETPLACE_BROWSE_LIMIT,
  parseListingBody,
  parseListingBrowseQuery,
  parseModerationRemoveBody,
  parseOrderResolution,
} from "../marketplace.js";

const MARKETPLACE_WRITE_RATE_LIMIT = {
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

const LISTING_PROJECTION = `listing_id AS "listingId", kind, category,
       price_minor AS "priceMinor", currency, market, state,
       created_at AS "createdAt", listed_at AS "listedAt", closed_at AS "closedAt"`;

// Browse projects no seller identity (FR-30) and no draft/closed detail.
const BROWSE_PROJECTION = `listing_id AS "listingId", kind, category,
       price_minor AS "priceMinor", currency, market, state,
       listed_at AS "listedAt"`;

const ORDER_PROJECTION = `order_id AS "orderId", listing_id AS "listingId",
       buyer, seller, escrow_id AS "escrowId", state,
       created_at AS "createdAt", resolved_at AS "resolvedAt"`;

function railUnavailable(reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  return reply.code(503).send({ error: "wallet rail disabled (AMD-PAY-15)" });
}

export function registerMarketplaceRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // ------------------------------------------------------- AMD-MKT-01/04 ---
  app.post(
    "/v1/marketplace/listings",
    { config: { rateLimit: MARKETPLACE_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseListingBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT outcome, listing_id AS "listingId"
             FROM create_listing($1, $2, $3, $4)`,
          [parsed.kind, parsed.category, parsed.priceMinor, parsed.market],
        );
        return r.rows[0] as { outcome: string; listingId: string | null };
      });
      if (out.outcome === "created") return reply.code(201).send({ listingId: out.listingId });
      if (out.outcome === "kyc_required") return reply.code(403).send({ error: out.outcome });
      if (out.outcome === "too_many") return reply.code(409).send({ error: out.outcome });
      if (out.outcome === "forbidden") return reply.code(403).send({ error: out.outcome });
      return reply.code(422).send({ error: out.outcome });
    },
  );

  // Browse: RLS keeps the rows live-only for consumers; the projection
  // carries no seller identity (FR-30 — the counterparty is learned through
  // the buyer's own order row at purchase, never in browse).
  app.get("/v1/marketplace/listings", async (req, reply) => {
    const filters = parseListingBrowseQuery(req.query);
    if (!filters) return reply.code(400).send({ error: "invalid query" });
    const rows = await withRls(ctx.pg, req.userId, async (c) => {
      const where: string[] = ["state IN ('listed', 'held')"];
      const params: unknown[] = [];
      if (filters.category !== undefined) {
        params.push(filters.category);
        where.push(`category = $${params.length}`);
      }
      if (filters.kind !== undefined) {
        params.push(filters.kind);
        where.push(`kind = $${params.length}`);
      }
      if (filters.market !== undefined) {
        params.push(filters.market);
        where.push(`market = $${params.length}`);
      }
      const r = await c.query(
        `SELECT ${BROWSE_PROJECTION}
           FROM marketplace_listings
          WHERE ${where.join(" AND ")}
          ORDER BY listed_at DESC NULLS LAST
          LIMIT ${MARKETPLACE_BROWSE_LIMIT}`,
        params,
      );
      return r.rows;
    });
    return reply.send({ listings: rows });
  });

  app.get("/v1/marketplace/listings/mine", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(
        `SELECT ${LISTING_PROJECTION}
           FROM marketplace_listings
          WHERE seller = app_user()
          ORDER BY created_at DESC`,
      );
      return r.rows;
    });
    return reply.send({ listings: rows });
  });

  app.post(
    "/v1/marketplace/listings/:listingId/list",
    {
      config: { rateLimit: MARKETPLACE_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("listingId") },
    },
    async (req, reply) => {
      const { listingId } = req.params as { listingId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT list_listing($1) AS outcome`, [listingId]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "listed") return reply.send({ state: "listed" });
      if (outcome === "unknown_listing") return reply.code(404).send({ error: outcome });
      if (outcome === "illegal_state") return reply.code(409).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );

  app.post(
    "/v1/marketplace/listings/:listingId/remove",
    {
      config: { rateLimit: MARKETPLACE_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("listingId") },
    },
    async (req, reply) => {
      const { listingId } = req.params as { listingId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT delist_listing($1) AS outcome`, [listingId]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "removed") return reply.send({ state: "removed" });
      if (outcome === "unknown_listing") return reply.code(404).send({ error: outcome });
      if (outcome === "illegal_state") return reply.code(409).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );

  // ------------------------------------------------------- AMD-MKT-03 ------
  app.post(
    "/v1/marketplace/listings/:listingId/purchase",
    {
      config: { rateLimit: MARKETPLACE_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("listingId") },
    },
    async (req, reply) => {
      const { listingId } = req.params as { listingId: string };
      try {
        const out = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(
            `SELECT outcome, order_id AS "orderId" FROM purchase_listing($1)`,
            [listingId],
          );
          return r.rows[0] as { outcome: string; orderId: string | null };
        });
        if (out.outcome === "purchased") return reply.code(201).send({ orderId: out.orderId });
        if (out.outcome === "kyc_required") return reply.code(403).send({ error: out.outcome });
        if (out.outcome === "unknown_listing") return reply.code(404).send({ error: out.outcome });
        if (out.outcome === "insufficient_funds" || out.outcome === "invalid_amounts") {
          return reply.code(422).send({ error: out.outcome });
        }
        if (out.outcome === "forbidden") return reply.code(403).send({ error: out.outcome });
        return reply.code(409).send({ error: out.outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.get("/v1/marketplace/orders", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(
        `SELECT ${ORDER_PROJECTION}
           FROM marketplace_orders
          WHERE app_user() IN (buyer, seller)
          ORDER BY created_at DESC`,
      );
      return r.rows;
    });
    return reply.send({ orders: rows });
  });

  app.post(
    "/v1/marketplace/orders/:orderId/confirm",
    {
      config: { rateLimit: MARKETPLACE_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("orderId") },
    },
    async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      try {
        const outcome = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(`SELECT confirm_purchase($1) AS outcome`, [orderId]);
          return r.rows[0].outcome as string;
        });
        if (outcome === "completed") return reply.send({ state: "completed" });
        if (outcome === "unknown_order") return reply.code(404).send({ error: outcome });
        if (outcome === "forbidden") return reply.code(403).send({ error: outcome });
        return reply.code(409).send({ error: outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.post(
    "/v1/marketplace/orders/:orderId/dispute",
    {
      config: { rateLimit: MARKETPLACE_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("orderId") },
    },
    async (req, reply) => {
      const { orderId } = req.params as { orderId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT dispute_purchase($1) AS outcome`, [orderId]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "disputed") return reply.send({ state: "disputed" });
      if (outcome === "unknown_order") return reply.code(404).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );

  // ------------------------------------------------------- AMD-MKT-05 ------
  app.post(
    "/v1/moderation/marketplace/listings/:listingId/remove",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: uuidParam("listingId") },
    },
    async (req, reply) => {
      const parsed = parseModerationRemoveBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const { listingId } = req.params as { listingId: string };
      const outcome = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `SELECT moderate_listing($1, $2, $3) AS outcome`,
          [listingId, parsed.reasonCode, req.userId],
        );
        return r.rows[0].outcome as string;
      });
      if (outcome === "removed") return reply.send({ state: "removed" });
      if (outcome === "unknown_listing") return reply.code(404).send({ error: outcome });
      if (outcome === "reason_required") return reply.code(400).send({ error: outcome });
      if (outcome === "illegal_state") return reply.code(409).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );

  app.post(
    "/v1/moderation/marketplace/orders/:orderId/resolve",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: uuidParam("orderId") },
    },
    async (req, reply) => {
      const parsed = parseOrderResolution(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const { orderId } = req.params as { orderId: string };
      try {
        const outcome = await withSettlement(
          ctx.pg,
          req.userId,
          async (c) => {
            const r = await c.query(`SELECT resolve_purchase($1, $2) AS outcome`, [
              orderId,
              parsed.decision,
            ]);
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
        if (outcome === "unknown_order") return reply.code(404).send({ error: outcome });
        if (outcome === "invalid_decision") return reply.code(400).send({ error: outcome });
        if (outcome === "forbidden") return reply.code(403).send({ error: outcome });
        return reply.code(409).send({ error: outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );
}
