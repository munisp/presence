/**
 * Wallet governance routes (SRS Addendum 001 — AMD-PAY-21/23).
 *
 *   GET  /v1/moderation/rail-risk-signals — AMD-PAY-21: the open and
 *     decided velocity signals raised inside the funding and withdrawal
 *     definers. Signals flag; they never block.
 *   POST /v1/moderation/rail-risk-signals/:signalId/ack — acknowledge or
 *     dismiss a signal (strict {decision} body), audited.
 *   GET  /v1/moderation/credit-approvals — AMD-PAY-23: the four-eyes
 *     queue of manual credits above the pinned threshold.
 *   POST /v1/moderation/credit-approvals/:approvalId/approve — execute a
 *     pending approval. Value moves HERE, inside withSettlement behind
 *     the WALLET_RAIL kill switch; the definer refuses self-approval.
 *     The body is strictly empty — the approval row carries the terms.
 *   POST /v1/moderation/credit-approvals/:approvalId/reject — close a
 *     pending approval without moving value (any moderator may reject;
 *     only execution is four-eyes), audited.
 *
 * Every route is moderator-gated by preHandler AND by the definers; the
 * value-moving approve route additionally runs inside withSettlement, so
 * it dies with 503 when operations disables the rail.
 */

import { FastifyInstance } from "fastify";
import {
  requireModerator,
  WalletRailUnavailable,
  withModerator,
  withSettlement,
} from "../auth.js";
import { EdgeContext } from "../context.js";
import { parseEmptyBody, parseSignalDecision } from "../wallets.js";

const MODERATION_RATE_LIMIT = {
  max: 120,
  timeWindow: "1 minute",
  keyGenerator: (req: { userId: string }) => req.userId,
} as const;

const signalParams = {
  type: "object",
  required: ["signalId"],
  additionalProperties: false,
  properties: { signalId: { type: "string", format: "uuid" } },
} as const;

const approvalParams = {
  type: "object",
  required: ["approvalId"],
  additionalProperties: false,
  properties: { approvalId: { type: "string", format: "uuid" } },
} as const;

export function registerWalletGovernanceRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // ------------------------------------------------------- AMD-PAY-21 ---
  app.get(
    "/v1/moderation/rail-risk-signals",
    { preHandler: requireModerator },
    async (req, reply) => {
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(
          `SELECT signal_id AS "signalId", signal_key AS "signalKey",
                  wallet_id AS "walletId", actor, amount_minor AS "amountMinor",
                  state, created_at AS "createdAt"
             FROM list_rail_risk_signals()`,
        ),
      );
      return reply.send({ signals: rows.rows });
    },
  );

  app.post(
    "/v1/moderation/rail-risk-signals/:signalId/ack",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: {
        params: signalParams,
        body: {
          type: "object",
          required: ["decision"],
          additionalProperties: false,
          properties: { decision: { type: "string", enum: ["acknowledge", "dismiss"] } },
        },
      },
    },
    async (req, reply) => {
      const { signalId } = req.params as { signalId: string };
      const parsed = parseSignalDecision(req.body);
      if (parsed === null) {
        return reply.code(422).send({ error: "the decision is not well-formed (AMD-PAY-21)" });
      }
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(`SELECT ack_rail_risk_signal($1, $2) AS outcome`, [signalId, parsed.decision]),
      );
      const outcome = (rows.rows[0] as { outcome: string }).outcome;
      if (outcome === "decided") return reply.send({ signalId, state: parsed.decision === "acknowledge" ? "acknowledged" : "dismissed" });
      if (outcome === "unknown_signal") return reply.code(404).send({ error: "signal not found" });
      if (outcome === "illegal_state") {
        return reply.code(409).send({ error: "the signal is already decided (AMD-PAY-21)" });
      }
      if (outcome === "illegal_decision") {
        return reply.code(422).send({ error: "the decision is not well-formed (AMD-PAY-21)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  // ------------------------------------------------------- AMD-PAY-23 ---
  app.get(
    "/v1/moderation/credit-approvals",
    { preHandler: requireModerator },
    async (req, reply) => {
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(
          `SELECT approval_id AS "approvalId", wallet_id AS "walletId",
                  amount_minor AS "amountMinor", reference,
                  proposed_by AS "proposedBy", state,
                  created_at AS "createdAt", decided_by AS "decidedBy",
                  decided_at AS "decidedAt"
             FROM list_credit_approvals()`,
        ),
      );
      return reply.send({ approvals: rows.rows });
    },
  );

  app.post(
    "/v1/moderation/credit-approvals/:approvalId/approve",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: approvalParams },
    },
    async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string };
      if (parseEmptyBody(req.body ?? {}) === null) {
        return reply.code(422).send({ error: "the approval carries the terms — the body is empty (AMD-PAY-23)" });
      }
      let rows;
      try {
        rows = await withSettlement(
          ctx.pg,
          req.userId,
          async (c) =>
            c.query(
              `SELECT outcome, balance_minor AS "balanceMinor" FROM approve_wallet_credit($1)`,
              [approvalId],
            ),
          "app.moderator",
        );
      } catch (err) {
        if (err instanceof WalletRailUnavailable) {
          return reply.code(503).send({ error: "the wallet rail is disabled by operations (AMD-PAY-15)" });
        }
        throw err;
      }
      const out = rows.rows[0] as { outcome: string; balanceMinor: number | null };
      if (out.outcome === "funded") return reply.send({ approvalId, balanceMinor: out.balanceMinor });
      if (out.outcome === "unknown_approval") return reply.code(404).send({ error: "approval not found" });
      if (out.outcome === "illegal_state") {
        return reply.code(409).send({ error: "the approval is already decided (AMD-PAY-23)" });
      }
      if (out.outcome === "self_approval") {
        return reply.code(409).send({ error: "a moderator cannot approve their own credit (AMD-PAY-23)" });
      }
      if (out.outcome === "wallet_not_active") {
        return reply.code(409).send({ error: "the wallet is not active (AMD-PAY-10)" });
      }
      if (out.outcome === "duplicate_reference") {
        return reply.code(409).send({ error: "the reference was already settled (AMD-PAY-16)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  app.post(
    "/v1/moderation/credit-approvals/:approvalId/reject",
    {
      preHandler: requireModerator,
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: approvalParams },
    },
    async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string };
      if (parseEmptyBody(req.body ?? {}) === null) {
        return reply.code(422).send({ error: "the approval carries the terms — the body is empty (AMD-PAY-23)" });
      }
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(`SELECT reject_wallet_credit($1) AS outcome`, [approvalId]),
      );
      const outcome = (rows.rows[0] as { outcome: string }).outcome;
      if (outcome === "rejected") return reply.send({ approvalId, state: "rejected" });
      if (outcome === "unknown_approval") return reply.code(404).send({ error: "approval not found" });
      if (outcome === "illegal_state") {
        return reply.code(409).send({ error: "the approval is already decided (AMD-PAY-23)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );
}
