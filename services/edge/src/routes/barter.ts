/**
 * Barter swap routes (SRS Addendum 001 — AMD-SWP-01..05).
 *
 *   POST /v1/swaps/listings                        — AMD-SWP-01: create a
 *     swap listing (have category, want set, value estimate, market — no
 *     free text), live immediately.
 *   GET  /v1/swaps/listings/mine                   — own swap listings, any
 *     state.
 *   GET  /v1/swaps/candidates                      — AMD-SWP-02: reciprocal,
 *     KYC-gated, block-aware candidates; the projection carries no owner.
 *   POST /v1/swaps/listings/:listingId/remove      — owner takedown of a
 *     listed swap; a held swap resolves its agreement first.
 *   POST /v1/swaps/proposals                       — AMD-SWP-03: propose
 *     listing-for-listing with an optional cash balancer reserved from the
 *     proposer's wallet at propose time.
 *   POST /v1/swaps/:agreementId/respond            — counterparty accepts
 *     (KYC re-proof + both required bonds active) or rejects (unwinds).
 *   POST /v1/swaps/:agreementId/cancel             — proposer withdraws an
 *     unanswered proposal; everything unwinds.
 *   POST /v1/swaps/:agreementId/stake-bond         — AMD-SWP-04: stake the
 *     pinned ₦1,000 bond on a bond-required agreement.
 *   POST /v1/swaps/:agreementId/confirm            — either party confirms
 *     the exchange; the second confirmation settles atomically.
 *   POST /v1/swaps/:agreementId/dispute            — either party; the
 *     balancer and the bonds stay frozen.
 *   GET  /v1/swaps/agreements                      — own agreements, either
 *     role.
 *   GET  /v1/swaps/agreements/:agreementId         — one agreement, party
 *     only.
 *   GET  /v1/moderation/swaps/disputed             — AMD-SWP-05: the
 *     dispute queue.
 *   POST /v1/moderation/swaps/:agreementId/resolve — refund unwinds and
 *     relists; release completes the swap; an optional bond forfeits TO
 *     THE COUNTERPARTY. Audited.
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
  parseSwapListingBody,
  parseSwapProposalBody,
  parseSwapResolutionBody,
  parseSwapResponseBody,
} from "../barter.js";

const SWAP_WRITE_RATE_LIMIT = {
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

const LISTING_PROJECTION = `swap_listing_id AS "swapListingId", have_category AS "haveCategory",
       want_categories AS "wantCategories",
       value_estimate_minor AS "valueEstimateMinor", currency, market, state,
       created_at AS "createdAt", closed_at AS "closedAt"`;

const AGREEMENT_PROJECTION = `agreement_id AS "agreementId",
       proposer_listing AS "proposerListing",
       counterparty_listing AS "counterpartyListing",
       proposer, counterparty, balance_minor AS "balanceMinor",
       requires_bond AS "requiresBond", state,
       proposer_confirmed_at AS "proposerConfirmedAt",
       counterparty_confirmed_at AS "counterpartyConfirmedAt",
       created_at AS "createdAt", decided_at AS "decidedAt",
       disputed_at AS "disputedAt", completed_at AS "completedAt"`;

function railUnavailable(reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  return reply.code(503).send({ error: "wallet rail disabled (AMD-PAY-15)" });
}

export function registerBarterRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // ------------------------------------------------------- AMD-SWP-01 ------
  app.post(
    "/v1/swaps/listings",
    { config: { rateLimit: SWAP_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseSwapListingBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT outcome, swap_listing_id AS "swapListingId"
             FROM create_swap_listing($1, $2, $3, $4)`,
          [parsed.haveCategory, parsed.wantCategories,
           parsed.valueEstimateMinor, parsed.market],
        );
        return r.rows[0] as { outcome: string; swapListingId: string | null };
      });
      if (out.outcome === "created") {
        return reply.code(201).send({ swapListingId: out.swapListingId });
      }
      if (out.outcome === "kyc_required" || out.outcome === "forbidden") {
        return reply.code(403).send({ error: out.outcome });
      }
      if (out.outcome === "too_many") return reply.code(409).send({ error: out.outcome });
      return reply.code(422).send({ error: out.outcome });
    },
  );

  app.get("/v1/swaps/listings/mine", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(
        `SELECT ${LISTING_PROJECTION}
           FROM swap_listings
          WHERE owner = app_user()
          ORDER BY created_at DESC`,
      );
      return r.rows;
    });
    return reply.send({ listings: rows });
  });

  // AMD-SWP-02: reciprocal candidates. The definer enforces the KYC gate,
  // the own-listing requirement, the block check and the LIMIT 50; the
  // projection carries no owner (FR-30).
  app.get("/v1/swaps/candidates", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(
        `SELECT swap_listing_id AS "swapListingId",
                have_category AS "haveCategory",
                want_categories AS "wantCategories",
                value_estimate_minor AS "valueEstimateMinor",
                market, listed_at AS "listedAt"
           FROM swap_candidates()`,
      );
      return r.rows;
    });
    return reply.send({ candidates: rows });
  });

  app.post(
    "/v1/swaps/listings/:listingId/remove",
    {
      config: { rateLimit: SWAP_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("listingId") },
    },
    async (req, reply) => {
      const { listingId } = req.params as { listingId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT delist_swap_listing($1) AS outcome`, [listingId]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "removed") return reply.send({ state: "removed" });
      if (outcome === "unknown_listing") return reply.code(404).send({ error: outcome });
      if (outcome === "illegal_state") return reply.code(409).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );

  // ------------------------------------------------------- AMD-SWP-03 ------
  app.post(
    "/v1/swaps/proposals",
    { config: { rateLimit: SWAP_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseSwapProposalBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      try {
        const out = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(
            `SELECT outcome, agreement_id AS "agreementId"
               FROM propose_swap($1, $2, $3, $4)`,
            [parsed.myListingId, parsed.theirListingId,
             parsed.balanceMinor, parsed.requiresBond],
          );
          return r.rows[0] as { outcome: string; agreementId: string | null };
        });
        if (out.outcome === "proposed") {
          return reply.code(201).send({ agreementId: out.agreementId });
        }
        if (out.outcome === "forbidden" || out.outcome === "kyc_required"
            || out.outcome === "blocked") {
          return reply.code(403).send({ error: out.outcome });
        }
        if (out.outcome === "unknown_listing") {
          return reply.code(404).send({ error: out.outcome });
        }
        if (out.outcome === "insufficient_funds") {
          return reply.code(422).send({ error: out.outcome });
        }
        return reply.code(409).send({ error: out.outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.post(
    "/v1/swaps/:agreementId/respond",
    {
      config: { rateLimit: SWAP_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("agreementId") },
    },
    async (req, reply) => {
      const parsed = parseSwapResponseBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const { agreementId } = req.params as { agreementId: string };
      try {
        const outcome = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(`SELECT respond_swap($1, $2) AS outcome`, [
            agreementId,
            parsed.accept,
          ]);
          return r.rows[0].outcome as string;
        });
        if (outcome === "accepted") return reply.send({ state: "accepted" });
        if (outcome === "cancelled") return reply.send({ state: "cancelled" });
        if (outcome === "unknown_agreement") {
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
    "/v1/swaps/:agreementId/cancel",
    {
      config: { rateLimit: SWAP_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("agreementId") },
    },
    async (req, reply) => {
      const { agreementId } = req.params as { agreementId: string };
      try {
        const outcome = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(`SELECT cancel_swap($1) AS outcome`, [agreementId]);
          return r.rows[0].outcome as string;
        });
        if (outcome === "cancelled") return reply.send({ state: "cancelled" });
        if (outcome === "unknown_agreement") {
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

  // ------------------------------------------------------- AMD-SWP-04 ------
  app.post(
    "/v1/swaps/:agreementId/stake-bond",
    {
      config: { rateLimit: SWAP_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("agreementId") },
    },
    async (req, reply) => {
      const { agreementId } = req.params as { agreementId: string };
      try {
        const out = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(
            `SELECT outcome, swap_bond_id AS "bondId"
               FROM stake_swap_bond($1)`,
            [agreementId],
          );
          return r.rows[0] as { outcome: string; bondId: string | null };
        });
        if (out.outcome === "staked") return reply.code(201).send({ bondId: out.bondId });
        if (out.outcome === "unknown_agreement") {
          return reply.code(404).send({ error: out.outcome });
        }
        if (out.outcome === "forbidden" || out.outcome === "kyc_required") {
          return reply.code(403).send({ error: out.outcome });
        }
        if (out.outcome === "insufficient_funds") {
          return reply.code(422).send({ error: out.outcome });
        }
        return reply.code(409).send({ error: out.outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.post(
    "/v1/swaps/:agreementId/confirm",
    {
      config: { rateLimit: SWAP_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("agreementId") },
    },
    async (req, reply) => {
      const { agreementId } = req.params as { agreementId: string };
      try {
        const outcome = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(`SELECT confirm_swap_exchange($1) AS outcome`, [
            agreementId,
          ]);
          return r.rows[0].outcome as string;
        });
        if (outcome === "confirmed") return reply.send({ state: "confirmed" });
        if (outcome === "completed") return reply.send({ state: "completed" });
        if (outcome === "unknown_agreement") {
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
    "/v1/swaps/:agreementId/dispute",
    {
      config: { rateLimit: SWAP_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("agreementId") },
    },
    async (req, reply) => {
      const { agreementId } = req.params as { agreementId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT dispute_swap($1) AS outcome`, [agreementId]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "disputed") return reply.send({ state: "disputed" });
      if (outcome === "unknown_agreement") {
        return reply.code(404).send({ error: outcome });
      }
      if (outcome === "forbidden") return reply.code(403).send({ error: outcome });
      return reply.code(409).send({ error: outcome });
    },
  );

  app.get("/v1/swaps/agreements", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(
        `SELECT ${AGREEMENT_PROJECTION}
           FROM swap_agreements
          WHERE app_user() IN (proposer, counterparty)
          ORDER BY created_at DESC`,
      );
      return r.rows;
    });
    return reply.send({ agreements: rows });
  });

  app.get(
    "/v1/swaps/agreements/:agreementId",
    { schema: { params: uuidParam("agreementId") } },
    async (req, reply) => {
      const { agreementId } = req.params as { agreementId: string };
      const rows = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT ${AGREEMENT_PROJECTION}
             FROM swap_agreements
            WHERE agreement_id = $1`,
          [agreementId],
        );
        return r.rows;
      });
      // RLS-null answers 404 — agreement existence is never leaked.
      if (rows.length === 0) {
        return reply.code(404).send({ error: "unknown_agreement" });
      }
      return reply.send({ agreement: rows[0] });
    },
  );

  // ------------------------------------------------------- AMD-SWP-05 ------
  app.get(
    "/v1/moderation/swaps/disputed",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
    },
    async (req, reply) => {
      const rows = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT ${AGREEMENT_PROJECTION}
             FROM swap_agreements
            WHERE state = 'disputed'
            ORDER BY disputed_at ASC`,
        );
        return r.rows;
      });
      return reply.send({ disputed: rows });
    },
  );

  app.post(
    "/v1/moderation/swaps/:agreementId/resolve",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: uuidParam("agreementId") },
    },
    async (req, reply) => {
      const parsed = parseSwapResolutionBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const { agreementId } = req.params as { agreementId: string };
      try {
        const outcome = await withSettlement(
          ctx.pg,
          req.userId,
          async (c) => {
            const r = await c.query(
              `SELECT resolve_swap($1, $2, $3) AS outcome`,
              [agreementId, parsed.decision, parsed.forfeitBondId],
            );
            return r.rows[0].outcome as string;
          },
          "app.moderator",
        );
        if (outcome === "resolved") return reply.send({ state: "resolved" });
        if (outcome === "invalid_decision") {
          return reply.code(400).send({ error: outcome });
        }
        if (outcome === "unknown_agreement" || outcome === "unknown_bond") {
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
}
