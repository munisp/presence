/**
 * Innovation routes (SRS Addendum 001 — AMD-INN-01..04, 06, 08, 09, 10).
 *
 *   POST /v1/presence/bond                       — AMD-INN-01: place the
 *     pinned bond; the definer reserves it through a wallet hold.
 *   POST /v1/presence/bond/release               — owner releases; hold voids.
 *   POST /v1/moderation/bonds/:bondId/forfeit    — moderator forfeits on a
 *     report; value moves user -> platform inside withSettlement.
 *   POST /v1/met-receipts                        — AMD-INN-02: submit the
 *     caller's half of a co-attestation; reciprocal within 900 s confirms.
 *   GET  /v1/met-receipts                        — own receipts (RLS).
 *   POST /v1/escrows                             — AMD-INN-03: create with a
 *     milestone list; the total is held up front.
 *   GET  /v1/escrows                             — own escrows (RLS).
 *   POST /v1/escrows/:escrowId/milestones/:seq/release — payer releases one.
 *   POST /v1/escrows/:escrowId/dispute           — either party disputes.
 *   POST /v1/moderation/escrows/:escrowId/resolve — moderator resolves;
 *     above the AMD-ESC-01 threshold this answers 202 approval_required and
 *     moves no value.
 *   GET  /v1/moderation/escrow-resolutions       — AMD-ESC-01: the four-eyes
 *     queue of high-value resolution requests (pending first).
 *   POST /v1/moderation/escrow-resolutions/:approvalId/approve — a second
 *     moderator executes the frozen decision; value moves inside
 *     withSettlement. Self-approval is refused.
 *   POST /v1/moderation/escrow-resolutions/:approvalId/reject — close a
 *     request without moving value.
 *   POST /v1/groups/:tableId/stake               — AMD-INN-04: stake a seat.
 *   POST /v1/groups/:tableId/stake/refund        — refund ONLY after the
 *     venue check-in token (FR-100) verifies against venues.checkin_secret.
 *   POST /v1/moderation/sweeps                   — run a pinned sweep
 *     (met receipts, introductions, group-stake forfeiture).
 *   POST /v1/disclosure-grants                   — AMD-INN-06: issue a
 *     single-use claim grant; the secret is returned once.
 *   POST /v1/venues/disclosure-verify            — verifier redeems; learns
 *     the claim and nothing else.
 *   POST /v1/serendipity/windows                 — AMD-INN-08: add a window.
 *   GET  /v1/serendipity/windows                 — own windows (RLS).
 *   POST /v1/serendipity/windows/:windowId/state — pause / resume.
 *   GET  /v1/serendipity/overlap                 — boolean overlap with a peer.
 *   GET  /v1/attestation                        — AMD-INN-09: mint a signed
 *     attestation over the caller's proven claims (KYC-verified only).
 *   POST /v1/attestation/verify                     — UNAUTHED (registered
 *     outside the authed scope): answers valid | expired | invalid, claims
 *     on valid, never identity.
 *   POST /v1/introductions                       — AMD-INN-10: host proposes.
 *   GET  /v1/introductions                       — own introductions (RLS).
 *   POST /v1/introductions/:introId/answer       — a party answers; the
 *     second accept walks the pair to MUTUAL through the FR-29 ledger.
 *
 * Every POST is rate-limited (AMD-OPS-03). Value moves only inside
 * withSettlement behind the WALLET_RAIL kill switch; the definers repeat
 * every gate. No route ever names a raw wallet table.
 */

import { FastifyInstance } from "fastify";
import {
  requireModerator,
  requireVenueOps,
  WalletRailUnavailable,
  withModerator,
  withRls,
  withSettlement,
  withVenueOps,
} from "../auth.js";
import { verifyCheckinToken } from "../checkin.js";
import { EdgeContext } from "../context.js";
import {
  mintAttestationToken,
  parseBondForfeitBody,
  parseDisclosureIssueBody,
  parseDisclosureVerifyBody,
  parseEscrowBody,
  parseEscrowResolution,
  parseIntroductionAnswerBody,
  parseIntroductionBody,
  parseMetReceiptBody,
  parseAttestationVerifyBody,
  parseSerendipityStateBody,
  parseSerendipityWindowBody,
  parseStakeRefundBody,
  verifyAttestationToken,
} from "../innovations.js";
import { attestationVerifyResults } from "../metrics.js";
import { parseEmptyBody } from "../wallets.js";

const INNOVATION_WRITE_RATE_LIMIT = {
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
  required: ["escrowId", "seq"],
  additionalProperties: false,
  properties: {
    escrowId: { type: "string", format: "uuid" },
    seq: { type: "integer", minimum: 1, maximum: 12 },
  },
} as const;

function railUnavailable(reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  return reply.code(503).send({ error: "wallet rail disabled (AMD-PAY-15)" });
}

export function registerInnovationRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // ------------------------------------------------------- AMD-INN-01 ---
  app.post(
    "/v1/presence/bond",
    { config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      try {
        const out = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(
            `SELECT outcome, bond_id AS "bondId" FROM place_presence_bond()`,
          );
          return r.rows[0] as { outcome: string; bondId: string | null };
        });
        if (out.outcome === "placed") return reply.code(201).send({ bondId: out.bondId });
        if (out.outcome === "kyc_required") return reply.code(403).send({ error: out.outcome });
        if (out.outcome === "bond_active") return reply.code(409).send({ error: out.outcome });
        if (out.outcome === "insufficient_funds") return reply.code(422).send({ error: out.outcome });
        return reply.code(409).send({ error: out.outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.post(
    "/v1/presence/bond/release",
    { config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const body = req.body as { bondId?: unknown };
      if (typeof body?.bondId !== "string") {
        return reply.code(400).send({ error: "invalid body" });
      }
      try {
        const outcome = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(`SELECT release_presence_bond($1) AS outcome`, [body.bondId]);
          return r.rows[0].outcome as string;
        });
        if (outcome === "released") return reply.send({ state: "released" });
        if (outcome === "unknown_bond") return reply.code(404).send({ error: outcome });
        return reply.code(403).send({ error: outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.post(
    "/v1/moderation/bonds/:bondId/forfeit",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: uuidParam("bondId") },
    },
    async (req, reply) => {
      const parsed = parseBondForfeitBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const { bondId } = req.params as { bondId: string };
      try {
        const outcome = await withSettlement(
          ctx.pg,
          req.userId,
          async (c) => {
            const r = await c.query(`SELECT forfeit_presence_bond($1, $2) AS outcome`, [
              bondId,
              parsed.reportId,
            ]);
            return r.rows[0].outcome as string;
          },
          "app.moderator",
        );
        if (outcome === "forfeited") return reply.send({ state: "forfeited" });
        if (outcome === "unknown_bond") return reply.code(404).send({ error: outcome });
        if (outcome === "unknown_report") return reply.code(422).send({ error: outcome });
        return reply.code(403).send({ error: outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  // ------------------------------------------------------- AMD-INN-02 ---
  app.post(
    "/v1/met-receipts",
    { config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseMetReceiptBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT outcome, receipt_id AS "receiptId", state FROM submit_met_receipt($1)`,
          [parsed.peer],
        );
        return r.rows[0] as { outcome: string; receiptId: string | null; state: string | null };
      });
      if (out.outcome === "confirmed") {
        return reply.code(201).send({ receiptId: out.receiptId, state: "confirmed" });
      }
      if (out.outcome === "pending") {
        return reply.code(202).send({ receiptId: out.receiptId, state: "pending" });
      }
      if (out.outcome === "self" || out.outcome === "unknown_peer") {
        return reply.code(422).send({ error: out.outcome });
      }
      return reply.code(403).send({ error: out.outcome });
    },
  );

  app.get("/v1/met-receipts", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        `SELECT receipt_id AS "receiptId", state, created_at AS "createdAt"
           FROM met_receipts ORDER BY created_at DESC LIMIT 50`,
      ),
    );
    return reply.send({ receipts: rows.rows });
  });

  // ------------------------------------------------------- AMD-INN-03 ---
  app.post(
    "/v1/escrows",
    { config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseEscrowBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      try {
        const out = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(
            `SELECT outcome, escrow_id AS "escrowId" FROM create_escrow($1, $2::bigint[])`,
            [parsed.payee, `{${parsed.milestones.join(",")}}`],
          );
          return r.rows[0] as { outcome: string; escrowId: string | null };
        });
        if (out.outcome === "created") return reply.code(201).send({ escrowId: out.escrowId });
        if (out.outcome === "kyc_required") return reply.code(403).send({ error: out.outcome });
        if (out.outcome === "invalid_amounts") return reply.code(422).send({ error: out.outcome });
        if (out.outcome === "insufficient_funds") return reply.code(422).send({ error: out.outcome });
        if (out.outcome === "unknown_payee" || out.outcome === "self") {
          return reply.code(422).send({ error: out.outcome });
        }
        return reply.code(409).send({ error: out.outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.get("/v1/escrows", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) => {
      const escrows = await c.query(
        `SELECT escrow_id AS "escrowId", payer, payee,
                total_minor AS "totalMinor", state, created_at AS "createdAt"
           FROM escrow_agreements ORDER BY created_at DESC LIMIT 50`,
      );
      const milestones = await c.query(
        `SELECT escrow_id AS "escrowId", seq, amount_minor AS "amountMinor", state
           FROM escrow_milestones ORDER BY escrow_id, seq`,
      );
      return { escrows: escrows.rows, milestones: milestones.rows };
    });
    return reply.send(rows);
  });

  app.post(
    "/v1/escrows/:escrowId/milestones/:seq/release",
    {
      config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT },
      schema: { params: milestoneParams },
    },
    async (req, reply) => {
      if (!parseEmptyBody(req.body)) return reply.code(400).send({ error: "invalid body" });
      const { escrowId, seq } = req.params as { escrowId: string; seq: number };
      try {
        const outcome = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(
            `SELECT release_escrow_milestone($1, $2::smallint) AS outcome`,
            [escrowId, seq],
          );
          return r.rows[0].outcome as string;
        });
        if (outcome === "released") return reply.send({ state: "released" });
        if (outcome === "completed") return reply.send({ state: "completed" });
        if (outcome === "unknown_escrow" || outcome === "unknown_milestone") {
          return reply.code(404).send({ error: outcome });
        }
        return reply.code(403).send({ error: outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.post(
    "/v1/escrows/:escrowId/dispute",
    {
      config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("escrowId") },
    },
    async (req, reply) => {
      if (!parseEmptyBody(req.body)) return reply.code(400).send({ error: "invalid body" });
      const { escrowId } = req.params as { escrowId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT dispute_escrow($1) AS outcome`, [escrowId]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "disputed") return reply.send({ state: "disputed" });
      if (outcome === "unknown_escrow") return reply.code(404).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );

  app.post(
    "/v1/moderation/escrows/:escrowId/resolve",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: uuidParam("escrowId") },
    },
    async (req, reply) => {
      const parsed = parseEscrowResolution(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const { escrowId } = req.params as { escrowId: string };
      try {
        const outcome = await withSettlement(
          ctx.pg,
          req.userId,
          async (c) => {
            const r = await c.query(`SELECT resolve_escrow($1, $2) AS outcome`, [
              escrowId,
              parsed.decision,
            ]);
            return r.rows[0].outcome as string;
          },
          "app.moderator",
        );
        if (outcome === "resolved") return reply.send({ state: "resolved" });
        // AMD-ESC-01: above the threshold the request is recorded and no
        // value moves — a second moderator must approve.
        if (outcome === "approval_required") {
          return reply.code(202).send({ state: "approval_required" });
        }
        if (outcome === "unknown_escrow") return reply.code(404).send({ error: outcome });
        if (outcome === "invalid_decision") return reply.code(422).send({ error: outcome });
        return reply.code(403).send({ error: outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  // ------------------------------------------------------- AMD-ESC-01 ---
  // The four-eyes queue: high-value dispute resolutions a single moderator
  // may propose but never execute alone.
  app.get(
    "/v1/moderation/escrow-resolutions",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
    },
    async (req, reply) => {
      const rows = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `SELECT approval_id AS "approvalId", escrow_id AS "escrowId",
                  decision, remaining_minor AS "remainingMinor",
                  proposed_by AS "proposedBy", state,
                  created_at AS "createdAt", decided_by AS "decidedBy",
                  decided_at AS "decidedAt"
             FROM list_escrow_resolve_approvals()`,
        );
        return r.rows;
      });
      return reply.send({ resolutions: rows });
    },
  );

  app.post(
    "/v1/moderation/escrow-resolutions/:approvalId/approve",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: uuidParam("approvalId") },
    },
    async (req, reply) => {
      if (!parseEmptyBody(req.body)) return reply.code(400).send({ error: "invalid body" });
      const { approvalId } = req.params as { approvalId: string };
      try {
        const outcome = await withSettlement(
          ctx.pg,
          req.userId,
          async (c) => {
            const r = await c.query(
              `SELECT approve_escrow_resolution($1) AS outcome`,
              [approvalId],
            );
            return r.rows[0].outcome as string;
          },
          "app.moderator",
        );
        if (outcome === "resolved") return reply.send({ state: "resolved" });
        if (outcome === "unknown_approval") return reply.code(404).send({ error: outcome });
        if (outcome === "self_approval") {
          return reply.code(409).send({ error: "a moderator cannot approve their own resolution (AMD-ESC-01)" });
        }
        if (outcome === "illegal_state" || outcome === "escrow_not_disputed") {
          return reply.code(409).send({ error: outcome });
        }
        return reply.code(403).send({ error: outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  app.post(
    "/v1/moderation/escrow-resolutions/:approvalId/reject",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: uuidParam("approvalId") },
    },
    async (req, reply) => {
      if (!parseEmptyBody(req.body)) return reply.code(400).send({ error: "invalid body" });
      const { approvalId } = req.params as { approvalId: string };
      // Rejection moves no value — the moderator GUC alone is sufficient
      // (the AMD-PAY-23 credit-reject shape).
      const outcome = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `SELECT reject_escrow_resolution($1) AS outcome`,
          [approvalId],
        );
        return r.rows[0].outcome as string;
      });
      if (outcome === "rejected") return reply.send({ state: "rejected" });
      if (outcome === "unknown_approval") return reply.code(404).send({ error: outcome });
      if (outcome === "illegal_state") return reply.code(409).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );

  // ------------------------------------------------------- AMD-INN-04 ---
  app.post(
    "/v1/groups/:tableId/stake",
    {
      config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("tableId") },
    },
    async (req, reply) => {
      if (!parseEmptyBody(req.body)) return reply.code(400).send({ error: "invalid body" });
      const { tableId } = req.params as { tableId: string };
      try {
        const out = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(
            `SELECT outcome, stake_id AS "stakeId" FROM place_group_stake($1)`,
            [tableId],
          );
          return r.rows[0] as { outcome: string; stakeId: string | null };
        });
        if (out.outcome === "staked") return reply.code(201).send({ stakeId: out.stakeId });
        if (out.outcome === "kyc_required") return reply.code(403).send({ error: out.outcome });
        if (out.outcome === "unknown_table") return reply.code(404).send({ error: out.outcome });
        if (out.outcome === "insufficient_funds") return reply.code(422).send({ error: out.outcome });
        return reply.code(409).send({ error: out.outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  // Refund ONLY after a venue check-in token (FR-100) verifies against the
  // table's venue — presence proven before value returns.
  app.post(
    "/v1/groups/:tableId/stake/refund",
    {
      config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("tableId") },
    },
    async (req, reply) => {
      const parsed = parseStakeRefundBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const { tableId } = req.params as { tableId: string };
      try {
        const outcome = await withSettlement(ctx.pg, req.userId, async (c) => {
          const stake = await c.query(
            `SELECT t.venue_id AS "venueId"
               FROM group_stakes s JOIN group_tables t ON t.table_id = s.table_id
              WHERE s.stake_id = $1 AND s.table_id = $2
                AND s.user_id = $3 AND s.state = 'staked'`,
            [parsed.stakeId, tableId, req.userId],
          );
          if (stake.rows.length === 0) return "unknown_stake";
          const venue = await c.query(
            `SELECT checkin_secret FROM venues WHERE venue_id = $1 AND active`,
            [stake.rows[0].venueId],
          );
          if (venue.rows.length === 0) return "checkin_invalid";
          const claims = verifyCheckinToken(parsed.checkinToken, venue.rows[0].checkin_secret);
          if (!claims || claims.vid !== stake.rows[0].venueId) return "checkin_invalid";
          const r = await c.query(`SELECT refund_group_stake($1) AS outcome`, [parsed.stakeId]);
          return r.rows[0].outcome as string;
        });
        if (outcome === "refunded") return reply.send({ state: "refunded" });
        if (outcome === "unknown_stake") return reply.code(404).send({ error: outcome });
        if (outcome === "checkin_invalid") {
          return reply.code(401).send({ error: "invalid or expired check-in token (FR-100)" });
        }
        return reply.code(403).send({ error: outcome });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  // -------------------------------------------------- pinned sweeps -------
  // One moderator entry point for the three pinned sweeps: met-receipt
  // expiry, introduction expiry, group-stake forfeiture.
  app.post(
    "/v1/moderation/sweeps",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
    },
    async (req, reply) => {
      const body = req.body as { kind?: unknown };
      const kind = body?.kind;
      if (kind !== "met_receipts" && kind !== "introductions" && kind !== "group_stakes") {
        return reply.code(400).send({ error: "invalid body" });
      }
      try {
        const swept = await withSettlement(
          ctx.pg,
          req.userId,
          async (c) => {
            if (kind === "met_receipts") {
              const r = await c.query(`SELECT expire_met_receipts() AS n`);
              return r.rows[0].n as number;
            }
            if (kind === "introductions") {
              const r = await c.query(`SELECT expire_introductions() AS n`);
              return r.rows[0].n as number;
            }
            const r = await c.query(`SELECT forfeit_group_stakes() AS n`);
            return r.rows[0].n as number;
          },
          "app.moderator",
        );
        return reply.send({ kind, swept });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) return railUnavailable(reply);
        throw err;
      }
    },
  );

  // ------------------------------------------------------- AMD-INN-06 ---
  app.post(
    "/v1/disclosure-grants",
    { config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseDisclosureIssueBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT outcome, grant_id AS "grantId", secret,
                  expires_at AS "expiresAt"
             FROM issue_disclosure_grant($1)`,
          [parsed.claim],
        );
        return r.rows[0] as {
          outcome: string;
          grantId: string | null;
          secret: string | null;
          expiresAt: string | null;
        };
      });
      if (out.outcome === "issued") {
        return reply.code(201).send({
          grantId: out.grantId,
          secret: out.secret,
          expiresAt: out.expiresAt,
        });
      }
      if (out.outcome === "invalid_claim") return reply.code(422).send({ error: out.outcome });
      return reply.code(403).send({ error: out.outcome });
    },
  );

  app.post(
    "/v1/venues/disclosure-verify",
    {
      preHandler: requireVenueOps,
      config: { rateLimit: MODERATION_RATE_LIMIT },
    },
    async (req, reply) => {
      const parsed = parseDisclosureVerifyBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const outcome = await withVenueOps(ctx.pg, async (c) => {
        const r = await c.query(`SELECT redeem_disclosure_grant($1, $2) AS outcome`, [
          parsed.grantId,
          parsed.secret,
        ]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "over_18" || outcome === "kyc_verified") {
        return reply.send({ claim: outcome });
      }
      if (outcome === "invalid") return reply.code(404).send({ error: outcome });
      if (outcome === "used" || outcome === "expired") {
        return reply.code(410).send({ error: outcome });
      }
      return reply.code(403).send({ error: outcome });
    },
  );

  // ------------------------------------------------------- AMD-INN-08 ---
  app.post(
    "/v1/serendipity/windows",
    { config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseSerendipityWindowBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT outcome, window_id AS "windowId"
             FROM add_serendipity_window($1::smallint, $2::smallint, $3::smallint, $4)`,
          [parsed.weekday, parsed.hourStart, parsed.hourEnd, parsed.market],
        );
        return r.rows[0] as { outcome: string; windowId: string | null };
      });
      if (out.outcome === "added") return reply.code(201).send({ windowId: out.windowId });
      if (out.outcome === "invalid_window") return reply.code(422).send({ error: out.outcome });
      if (out.outcome === "too_many") return reply.code(409).send({ error: out.outcome });
      return reply.code(403).send({ error: out.outcome });
    },
  );

  app.get("/v1/serendipity/windows", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        `SELECT window_id AS "windowId", weekday, hour_start AS "hourStart",
                hour_end AS "hourEnd", market, state
           FROM serendipity_windows ORDER BY created_at DESC LIMIT 50`,
      ),
    );
    return reply.send({ windows: rows.rows });
  });

  app.post(
    "/v1/serendipity/windows/:windowId/state",
    {
      config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("windowId") },
    },
    async (req, reply) => {
      const parsed = parseSerendipityStateBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const { windowId } = req.params as { windowId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT set_serendipity_window_state($1, $2) AS outcome`, [
          windowId,
          parsed.state,
        ]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "updated") return reply.send({ state: parsed.state });
      if (outcome === "unknown_window") return reply.code(404).send({ error: outcome });
      if (outcome === "invalid_state") return reply.code(422).send({ error: outcome });
      if (outcome === "too_many") return reply.code(409).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );

  app.get("/v1/serendipity/overlap", async (req, reply) => {
    const { peer } = req.query as { peer?: unknown };
    if (typeof peer !== "string") return reply.code(400).send({ error: "invalid query" });
    const overlap = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(`SELECT serendipity_overlap($1) AS overlap`, [peer]);
      return r.rows[0].overlap as boolean;
    });
    return reply.send({ overlap });
  });

  // ------------------------------------------------------- AMD-INN-09 ---
  app.get("/v1/attestation", async (req, reply) => {
    const secret = process.env.PRESENCE_ATTESTATION_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: "attestation signing unconfigured (AMD-INN-09)" });
    }
    const claims = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(`SELECT attestation_claims() AS claims`);
      return (r.rows[0].claims as { claims: string[] }).claims;
    });
    if (!claims.includes("kyc_verified")) {
      return reply.code(403).send({ error: "kyc_required" });
    }
    const token = mintAttestationToken(req.userId, claims, secret);
    return reply.send({ token, claims });
  });

  // ------------------------------------------------------- AMD-INN-10 ---
  app.post(
    "/v1/introductions",
    { config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseIntroductionBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT outcome, intro_id AS "introId" FROM propose_introduction($1, $2)`,
          [parsed.partyA, parsed.partyB],
        );
        return r.rows[0] as { outcome: string; introId: string | null };
      });
      if (out.outcome === "proposed") return reply.code(201).send({ introId: out.introId });
      if (out.outcome === "kyc_required") return reply.code(403).send({ error: out.outcome });
      if (out.outcome === "invalid_parties") return reply.code(422).send({ error: out.outcome });
      if (out.outcome === "blocked" || out.outcome === "duplicate") {
        return reply.code(409).send({ error: out.outcome });
      }
      return reply.code(403).send({ error: out.outcome });
    },
  );

  app.get("/v1/introductions", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        `SELECT intro_id AS "introId", state, created_at AS "createdAt"
           FROM introductions ORDER BY created_at DESC LIMIT 50`,
      ),
    );
    return reply.send({ introductions: rows.rows });
  });

  app.post(
    "/v1/introductions/:introId/answer",
    {
      config: { rateLimit: INNOVATION_WRITE_RATE_LIMIT },
      schema: { params: uuidParam("introId") },
    },
    async (req, reply) => {
      const parsed = parseIntroductionAnswerBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const { introId } = req.params as { introId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT answer_introduction($1, $2) AS outcome`, [
          introId,
          parsed.decision,
        ]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "accepted") return reply.send({ state: "accepted" });
      if (outcome === "declined") return reply.send({ state: "declined" });
      if (outcome === "recorded") return reply.code(202).send({ state: "recorded" });
      if (outcome === "unknown_introduction") return reply.code(404).send({ error: outcome });
      if (outcome === "invalid_decision") return reply.code(422).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );
}

/**
 * AMD-INN-09: attestation verification is a pure oracle — the caller is a
 * third party (a venue door, a partner app) with no account, so this route
 * lives OUTSIDE the authed scope, like the rail webhooks. It answers
 * valid | expired | invalid and, on valid, the claims — never identity.
 * Every verdict is counted.
 */
export function registerAttestationVerifyRoute(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/attestation/verify",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = parseAttestationVerifyBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const secret = process.env.PRESENCE_ATTESTATION_SECRET;
      if (!secret) {
        attestationVerifyResults().inc({ result: "unconfigured" });
        return reply.code(503).send({ error: "attestation verification unconfigured (AMD-INN-09)" });
      }
      const out = verifyAttestationToken(parsed.token, secret);
      if (out === null) {
        attestationVerifyResults().inc({ result: "invalid" });
        return reply.send({ verdict: "invalid" });
      }
      if (out === "expired") {
        attestationVerifyResults().inc({ result: "expired" });
        return reply.send({ verdict: "expired" });
      }
      attestationVerifyResults().inc({ result: "valid" });
      return reply.send({ verdict: "valid", claims: out.claims });
    },
  );
}
