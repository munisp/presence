/**
 * Wallet routes (SRS Addendum 001 — AMD-PAY-10..14).
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
 *   POST /v1/moderation/wallets/:walletId/freeze   — AMD-KYC-05
 *   POST /v1/moderation/wallets/:walletId/unfreeze — composability:
 *     workforce wallet suspension via the set_wallet_status definer,
 *     gated by requireModerator and executed inside the app.moderator
 *     GUC; every change lands in the admin audit log.
 *
 * AMD-PAY-13: there is deliberately no route that moves value — no fund,
 * no withdraw, no hold, no settle. wallet_move, place_wallet_hold,
 * void_wallet_hold and settle_transfer_funds stay rail-only behind the
 * app.transfer_settlement GUC that no P0 component sets (AMD-PAY-08
 * extended). The TECH-23 deployment gate stands.
 *
 * TR-23: strict bodies — unknown fields fail validation with a 400.
 */

import { FastifyInstance, FastifyReply } from "fastify";
import { requireModerator, withModerator, withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import { parseWalletCreation } from "../wallets.js";

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
}
