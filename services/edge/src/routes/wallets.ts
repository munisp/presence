/**
 * Wallet routes (SRS Addendum 001 — AMD-PAY-10..20).
 *
 *   POST /v1/wallets                       — AMD-PAY-10: create the
 *     caller's wallet. Self-serve, KYC-verified only; the create_wallet
 *     definer decides (owner is the caller, idempotent 'exists'). The
 *     body is strictly empty — the currency is the launch currency.
 *   GET  /v1/wallets                       — the caller's wallets with
 *     derived balances (AMD-PAY-11): balance, held, available. Owner-
 *     scoped by RLS; the platform fee wallet is never visible here.
 *   GET  /v1/wallets/:walletId/entries     — the append-only ledger and
 *     hold history for one of the caller's wallets. An id the caller
 *     does not own answers 404 — wallet existence is not leaked.
 *   POST /v1/wallets/:walletId/withdrawals — AMD-PAY-17: request a payout.
 *     The request_withdrawal definer decides: ownership, caps (per-
 *     withdrawal and rolling 24 h, mirroring AMD-PAY-05), availability,
 *     and places the reserving hold in the same transaction.
 *   GET  /v1/wallets/:walletId/withdrawals — the caller's payout history.
 *   POST /v1/wallets/:walletId/withdrawals/:requestId/cancel — owner
 *     cancel while 'requested'; the hold is voided.
 *   POST /v1/moderation/wallets/:walletId/freeze   — AMD-KYC-05
 *   POST /v1/moderation/wallets/:walletId/unfreeze — composability:
 *     workforce wallet suspension via the set_wallet_status definer.
 *   POST /v1/moderation/wallets/:walletId/credit — AMD-PAY-16: manual
 *     fund-in during the pilot, via the fund_wallet definer, audited.
 *   POST /v1/moderation/withdrawals/:requestId/decide — AMD-PAY-17:
 *     approve (→ processing, the provider is instructed) or reject
 *     (→ failed, hold voided); audited.
 *   GET  /v1/moderation/wallets/reconciliation — AMD-PAY-19: re-derive
 *     every balance from the ledger and prove the fee account.
 *
 * AMD-PAY-15: the wallet rail is live. The value-moving wires run inside
 * withSettlement — the only writer of app.transfer_settlement — behind
 * the WALLET_RAIL operational kill switch; the definers keep their
 * database gate as defence in depth. The external settlement rails
 * (Mojaloop/TigerBeetle) stay TECH-23-gated; the fund-in and payout
 * provider callbacks live in routes/walletRail.ts outside the user
 * scope, authenticated by HMAC signature.
 *
 * TR-23: strict bodies — unknown fields fail validation with a 400.
 */

import { FastifyInstance, FastifyReply } from "fastify";
import {
  requireModerator,
  WalletRailUnavailable,
  withModerator,
  withRls,
  withSettlement,
} from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  parseWithdrawalDecision,
  parseWithdrawalRequest,
  parseWalletCreation,
} from "../wallets.js";

export function registerWalletRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/wallets",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    },
    async (req, reply) => {
      if (parseWalletCreation(req.body) === null) {
        return reply.code(422).send({ error: "wallet creation takes no fields (AMD-PAY-10)" });
      }
      const rows = await withRls(ctx.pg, req.userId, async (c) =>
        c.query(`SELECT outcome, wallet_id AS "walletId" FROM create_wallet($1)`, [req.userId]),
      );
      const out = rows.rows[0] as { outcome: string; walletId: string | null };
      if (out.outcome === "created") {
        return reply.code(201).send({ walletId: out.walletId, currency: "NGN", status: "active" });
      }
      if (out.outcome === "exists") {
        return reply.code(200).send({ walletId: out.walletId, currency: "NGN" });
      }
      if (out.outcome === "not_kyc_verified") {
        return reply.code(403).send({ error: "verify your identity to open a wallet (AMD-PAY-01)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  app.get("/v1/wallets", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        `SELECT w.wallet_id AS "walletId",
                b.currency,
                w.status,
                b.balance_minor AS "balanceMinor",
                b.held_minor AS "heldMinor",
                b.available_minor AS "availableMinor",
                w.created_at AS "createdAt"
           FROM wallets w
           JOIN wallet_balances b ON b.wallet_id = w.wallet_id
          WHERE w.owner = $1
          ORDER BY w.created_at`,
        [req.userId],
      ),
    );
    return reply.send({ wallets: rows.rows });
  });

  const walletParams = {
    type: "object",
    required: ["walletId"],
    additionalProperties: false,
    properties: { walletId: { type: "string", format: "uuid" } },
  } as const;

  app.get(
    "/v1/wallets/:walletId/entries",
    { schema: { params: walletParams } },
    async (req, reply) => {
      const { walletId } = req.params as { walletId: string };
      const result = await withRls(ctx.pg, req.userId, async (c) => {
        const owned = await c.query(
          `SELECT wallet_id FROM wallets WHERE wallet_id = $1 AND owner = $2`,
          [walletId, req.userId],
        );
        if (owned.rows.length === 0) return null;
        const entries = await c.query(
          `SELECT entry_id AS "entryId", kind,
                  amount_minor AS "amountMinor",
                  balance_after AS "balanceAfter",
                  transfer_id AS "transferId", at
             FROM wallet_entries
            WHERE wallet_id = $1
            ORDER BY entry_id DESC LIMIT 100`,
          [walletId],
        );
        const holds = await c.query(
          `SELECT hold_id AS "holdId", amount_minor AS "amountMinor",
                  state, transfer_id AS "transferId",
                  created_at AS "createdAt", resolved_at AS "resolvedAt"
             FROM wallet_holds
            WHERE wallet_id = $1
            ORDER BY created_at DESC LIMIT 100`,
          [walletId],
        );
        return { entries: entries.rows, holds: holds.rows };
      });
      if (result === null) {
        return reply.code(404).send({ error: "wallet not found" });
      }
      return reply.send(result);
    },
  );

  const mapStatusOutcome = (
    outcome: string,
    reply: FastifyReply,
    walletId: string,
    status: string,
  ) => {
    if (outcome === "updated") return reply.send({ walletId, status });
    if (outcome === "unknown_wallet") return reply.code(404).send({ error: "wallet not found" });
    if (outcome === "illegal_status") {
      return reply.code(409).send({ error: "illegal wallet status (AMD-PAY-10)" });
    }
    return reply.code(403).send({ error: "forbidden" });
  };

  app.post(
    "/v1/moderation/wallets/:walletId/freeze",
    { preHandler: requireModerator, schema: { params: walletParams } },
    async (req, reply) => {
      const { walletId } = req.params as { walletId: string };
      const outcome = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `SELECT set_wallet_status($1, 'frozen') AS outcome`,
          [walletId],
        );
        return (r.rows[0] as { outcome: string }).outcome;
      });
      return mapStatusOutcome(outcome, reply, walletId, "frozen");
    },
  );

  app.post(
    "/v1/moderation/wallets/:walletId/unfreeze",
    { preHandler: requireModerator, schema: { params: walletParams } },
    async (req, reply) => {
      const { walletId } = req.params as { walletId: string };
      const outcome = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `SELECT set_wallet_status($1, 'active') AS outcome`,
          [walletId],
        );
        return (r.rows[0] as { outcome: string }).outcome;
      });
      return mapStatusOutcome(outcome, reply, walletId, "active");
    },
  );

  // ------------------------------------------------------- AMD-PAY-17 ---
  const withdrawalBody = {
    type: "object",
    required: ["amountMinor", "destinationRef"],
    additionalProperties: false,
    properties: {
      amountMinor: { type: "integer" },
      destinationRef: { type: "string", minLength: 8, maxLength: 128 },
    },
  } as const;

  app.post(
    "/v1/wallets/:walletId/withdrawals",
    { schema: { params: walletParams, body: withdrawalBody } },
    async (req, reply) => {
      const { walletId } = req.params as { walletId: string };
      const parsed = parseWithdrawalRequest(req.body);
      if (parsed === null) {
        return reply.code(422).send({ error: "a withdrawal is an amount and a destination reference (AMD-PAY-17)" });
      }
      let rows;
      try {
        rows = await withSettlement(ctx.pg, req.userId, async (c) =>
          c.query(
            `SELECT outcome, request_id AS "requestId" FROM request_withdrawal($1, $2, $3)`,
            [walletId, parsed.amountMinor, parsed.destinationRef],
          ),
        );
      } catch (err) {
        if (err instanceof WalletRailUnavailable) {
          return reply.code(503).send({ error: "the wallet rail is disabled by operations (AMD-PAY-15)" });
        }
        throw err;
      }
      const out = rows.rows[0] as { outcome: string; requestId: string | null };
      if (out.outcome === "requested") return reply.code(201).send({ requestId: out.requestId, state: "requested" });
      if (out.outcome === "unknown_wallet") return reply.code(404).send({ error: "wallet not found" });
      if (out.outcome === "invalid_amount" || out.outcome === "invalid_destination") {
        return reply.code(422).send({ error: "the withdrawal is not well-formed (AMD-PAY-17)" });
      }
      if (out.outcome === "over_withdrawal_cap" || out.outcome === "over_daily_cap") {
        return reply.code(422).send({ error: "the amount exceeds a platform cap (AMD-PAY-17)" });
      }
      if (out.outcome === "insufficient_funds") {
        return reply.code(409).send({ error: "the available balance cannot cover this withdrawal (AMD-PAY-17)" });
      }
      if (out.outcome === "wallet_not_active") {
        return reply.code(409).send({ error: "the wallet is not active (AMD-PAY-10)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  app.get(
    "/v1/wallets/:walletId/withdrawals",
    { schema: { params: walletParams } },
    async (req, reply) => {
      const { walletId } = req.params as { walletId: string };
      const result = await withRls(ctx.pg, req.userId, async (c) => {
        const owned = await c.query(
          `SELECT wallet_id FROM wallets WHERE wallet_id = $1 AND owner = $2`,
          [walletId, req.userId],
        );
        if (owned.rows.length === 0) return null;
        const rows = await c.query(
          `SELECT request_id AS "requestId", amount_minor AS "amountMinor",
                  state, created_at AS "createdAt", resolved_at AS "resolvedAt"
             FROM withdrawal_requests
            WHERE wallet_id = $1
            ORDER BY created_at DESC LIMIT 100`,
          [walletId],
        );
        return { withdrawals: rows.rows };
      });
      if (result === null) {
        return reply.code(404).send({ error: "wallet not found" });
      }
      // AMD-PAY-17: the destination reference is the owner's own data on
      // the detail export (AMD-PAY-20); the list stays minimal.
      return reply.send(result);
    },
  );

  const withdrawalParams = {
    type: "object",
    required: ["walletId", "requestId"],
    additionalProperties: false,
    properties: {
      walletId: { type: "string", format: "uuid" },
      requestId: { type: "string", format: "uuid" },
    },
  } as const;

  app.post(
    "/v1/wallets/:walletId/withdrawals/:requestId/cancel",
    { schema: { params: withdrawalParams } },
    async (req, reply) => {
      const { requestId } = req.params as { walletId: string; requestId: string };
      let outcome: string;
      try {
        outcome = await withSettlement(ctx.pg, req.userId, async (c) => {
          const r = await c.query(`SELECT cancel_withdrawal($1) AS outcome`, [requestId]);
          return (r.rows[0] as { outcome: string }).outcome;
        });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) {
          return reply.code(503).send({ error: "the wallet rail is disabled by operations (AMD-PAY-15)" });
        }
        throw err;
      }
      if (outcome === "cancelled") return reply.send({ requestId, state: "cancelled" });
      if (outcome === "unknown_request") return reply.code(404).send({ error: "withdrawal not found" });
      if (outcome === "illegal_state") {
        return reply.code(409).send({ error: "only a requested withdrawal can be cancelled (AMD-PAY-17)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  // ------------------------------------------------------- AMD-PAY-16 ---
  app.post(
    "/v1/moderation/wallets/:walletId/credit",
    {
      preHandler: requireModerator,
      schema: {
        params: walletParams,
        body: {
          type: "object",
          required: ["amountMinor", "reference"],
          additionalProperties: false,
          properties: {
            amountMinor: { type: "integer" },
            reference: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
      },
    },
    async (req, reply) => {
      const { walletId } = req.params as { walletId: string };
      const { amountMinor, reference } = req.body as { amountMinor: number; reference: string };
      let rows;
      try {
        rows = await withSettlement(
          ctx.pg,
          req.userId,
          async (c) =>
            c.query(
              `SELECT outcome, balance_minor AS "balanceMinor" FROM fund_wallet($1, $2, $3)`,
              [walletId, amountMinor, reference],
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
      if (out.outcome === "funded") return reply.send({ walletId, balanceMinor: out.balanceMinor });
      if (out.outcome === "duplicate_reference") {
        return reply.code(200).send({ walletId, duplicate: true });
      }
      if (out.outcome === "unknown_wallet") return reply.code(404).send({ error: "wallet not found" });
      if (out.outcome === "invalid_amount" || out.outcome === "over_funding_cap" || out.outcome === "invalid_reference") {
        return reply.code(422).send({ error: "the credit is not well-formed (AMD-PAY-16)" });
      }
      if (out.outcome === "wallet_not_active") {
        return reply.code(409).send({ error: "the wallet is not active (AMD-PAY-10)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  // ------------------------------------------------------- AMD-PAY-17 ---
  const decideParams = {
    type: "object",
    required: ["requestId"],
    additionalProperties: false,
    properties: { requestId: { type: "string", format: "uuid" } },
  } as const;

  app.post(
    "/v1/moderation/withdrawals/:requestId/decide",
    {
      preHandler: requireModerator,
      schema: {
        params: decideParams,
        body: {
          type: "object",
          required: ["decision"],
          additionalProperties: false,
          properties: { decision: { type: "string", enum: ["approve", "reject"] } },
        },
      },
    },
    async (req, reply) => {
      const { requestId } = req.params as { requestId: string };
      const parsed = parseWithdrawalDecision(req.body);
      if (parsed === null) {
        return reply.code(422).send({ error: "decision must be approve or reject (AMD-PAY-17)" });
      }
      let outcome: string;
      try {
        outcome = await withSettlement(
          ctx.pg,
          req.userId,
          async (c) => {
            const r = await c.query(`SELECT decide_withdrawal($1, $2) AS outcome`, [requestId, parsed.decision]);
            return (r.rows[0] as { outcome: string }).outcome;
          },
          "app.moderator",
        );
      } catch (err) {
        if (err instanceof WalletRailUnavailable) {
          return reply.code(503).send({ error: "the wallet rail is disabled by operations (AMD-PAY-15)" });
        }
        throw err;
      }
      if (outcome === "decided") {
        return reply.send({ requestId, state: parsed.decision === "approve" ? "processing" : "failed" });
      }
      if (outcome === "unknown_request") return reply.code(404).send({ error: "withdrawal not found" });
      if (outcome === "illegal_state" || outcome === "illegal_decision") {
        return reply.code(409).send({ error: "illegal withdrawal decision (AMD-PAY-17)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  // ------------------------------------------------------- AMD-PAY-19 ---
  app.get(
    "/v1/moderation/wallets/reconciliation",
    { preHandler: requireModerator },
    async (req, reply) => {
      const report = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(`SELECT wallet_reconciliation() AS report`);
        return (r.rows[0] as { report: unknown }).report;
      });
      return reply.send(report);
    },
  );
}
