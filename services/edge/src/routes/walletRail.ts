/**
 * Wallet rail provider webhooks (SRS Addendum 001 — AMD-PAY-16/17/22).
 *
 * These are NOT user routes: they are registered outside the authed scope
 * and authenticate the caller as the payment provider by an HMAC-SHA256
 * signature over the canonical field string (pinned in wallets.ts), using
 * a shared secret from the environment. An unset secret answers 503 — the
 * wire exists, the credential arrives with the provider integration.
 * AMD-PAY-22 adds freshness: the provider stamps every callback with the
 * unix epoch in x-wallet-timestamp and signs the timestamp TOGETHER with
 * the fields, so a replayed signature ages out within RAIL_SIGNATURE_SKEW_S.
 *
 *   POST /v1/webhooks/wallet-funding — AMD-PAY-16: fund-in. The provider
 *     confirms a bank/mobile-money collection; fund_wallet credits the
 *     wallet, idempotent on the reference (wallet_rail_events).
 *   POST /v1/webhooks/wallet-payout  — AMD-PAY-17: payout completion.
 *     outcome 'completed' posts the hold and debits the wallet;
 *     'failed' voids the hold and returns the reservation.
 *
 * Both run inside withRailCallback — the settlement GUC plus the matching
 * callback GUC (app.funding_callback / app.payout_callback) — behind the
 * WALLET_RAIL kill switch. The definers re-check every gate in the
 * database; these routes only authenticate and map outcomes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { FastifyInstance } from "fastify";
import { WalletRailUnavailable, withRailCallback } from "../auth.js";
import { EdgeContext } from "../context.js";
import { walletWebhookResults } from "../metrics.js";
import {
  RAIL_SIGNATURE_SKEW_S,
  fundingSignaturePayload,
  parseFundingCallback,
  parsePayoutCallback,
  parseRailTimestamp,
  payoutSignaturePayload,
} from "../wallets.js";

/** Webhooks are machine traffic: generous burst, per-source-IP window. */
const WEBHOOK_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

/** AMD-PAY-22: freshness window — reject callbacks older than the skew. */
function timestampFresh(header: unknown): number | null {
  const at = parseRailTimestamp(header);
  if (at === null) return null;
  const nowS = Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - at) > RAIL_SIGNATURE_SKEW_S) return null;
  return at;
}

/** Constant-time signature check; a missing or malformed header refuses. */
function signatureValid(secret: string, payload: string, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
}

export function registerWalletRailRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/webhooks/wallet-funding",
    {
      config: { rateLimit: WEBHOOK_RATE_LIMIT },
      schema: {
        body: {
          type: "object",
          required: ["walletId", "amountMinor", "reference"],
          additionalProperties: false,
          properties: {
            walletId: { type: "string", format: "uuid" },
            amountMinor: { type: "integer" },
            reference: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
      },
    },
    async (req, reply) => {
      const secret = process.env.WALLET_FUNDING_SECRET;
      if (!secret) {
        walletWebhookResults().inc({ route: "funding", result: "unconfigured" });
        return reply.code(503).send({ error: "funding callback not configured (AMD-PAY-16)" });
      }
      const parsed = parseFundingCallback(req.body);
      if (parsed === null) {
        walletWebhookResults().inc({ route: "funding", result: "rejected" });
        return reply.code(422).send({ error: "a funding callback is a wallet, an amount and a reference (AMD-PAY-16)" });
      }
      // AMD-PAY-22: freshness is checked BEFORE the signature — a stale
      // callback is refused even when the signature itself is valid.
      const at = timestampFresh(req.headers["x-wallet-timestamp"]);
      if (at === null) {
        walletWebhookResults().inc({ route: "funding", result: "rejected" });
        return reply.code(401).send({ error: "stale or missing timestamp (AMD-PAY-22)" });
      }
      const payload = fundingSignaturePayload(String(at), parsed.walletId, parsed.amountMinor, parsed.reference);
      if (!signatureValid(secret, payload, req.headers["x-wallet-signature"])) {
        walletWebhookResults().inc({ route: "funding", result: "rejected" });
        return reply.code(401).send({ error: "bad signature" });
      }
      let rows;
      try {
        rows = await withRailCallback(ctx.pg, "app.funding_callback", async (c) =>
          c.query(
            `SELECT outcome, balance_minor AS "balanceMinor" FROM fund_wallet($1, $2, $3)`,
            [parsed.walletId, parsed.amountMinor, parsed.reference],
          ),
        );
      } catch (err) {
        if (err instanceof WalletRailUnavailable) {
          return reply.code(503).send({ error: "the wallet rail is disabled by operations (AMD-PAY-15)" });
        }
        throw err;
      }
      const out = rows.rows[0] as { outcome: string; balanceMinor: number | null };
      // AMD-PAY-16: a replayed callback is a success — value moved once.
      if (out.outcome === "funded" || out.outcome === "duplicate_reference") {
        walletWebhookResults().inc({ route: "funding", result: "accepted" });
        return reply.send({ ok: true, outcome: out.outcome });
      }
      walletWebhookResults().inc({ route: "funding", result: "rejected" });
      if (out.outcome === "unknown_wallet") return reply.code(404).send({ error: "wallet not found" });
      if (out.outcome === "invalid_amount" || out.outcome === "over_funding_cap") {
        return reply.code(422).send({ error: "the amount is outside the funding caps (AMD-PAY-16)" });
      }
      if (out.outcome === "wallet_not_active") {
        return reply.code(409).send({ error: "the wallet is not active (AMD-PAY-10)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  app.post(
    "/v1/webhooks/wallet-payout",
    {
      config: { rateLimit: WEBHOOK_RATE_LIMIT },
      schema: {
        body: {
          type: "object",
          required: ["requestId", "outcome", "reference"],
          additionalProperties: false,
          properties: {
            requestId: { type: "string", format: "uuid" },
            outcome: { type: "string", enum: ["completed", "failed"] },
            reference: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
      },
    },
    async (req, reply) => {
      const secret = process.env.WALLET_PAYOUT_SECRET;
      if (!secret) {
        walletWebhookResults().inc({ route: "payout", result: "unconfigured" });
        return reply.code(503).send({ error: "payout callback not configured (AMD-PAY-17)" });
      }
      const parsed = parsePayoutCallback(req.body);
      if (parsed === null) {
        walletWebhookResults().inc({ route: "payout", result: "rejected" });
        return reply.code(422).send({ error: "a payout callback is a request, an outcome and a reference (AMD-PAY-17)" });
      }
      const at = timestampFresh(req.headers["x-wallet-timestamp"]);
      if (at === null) {
        walletWebhookResults().inc({ route: "payout", result: "rejected" });
        return reply.code(401).send({ error: "stale or missing timestamp (AMD-PAY-22)" });
      }
      const payload = payoutSignaturePayload(String(at), parsed.requestId, parsed.outcome, parsed.reference);
      if (!signatureValid(secret, payload, req.headers["x-wallet-signature"])) {
        walletWebhookResults().inc({ route: "payout", result: "rejected" });
        return reply.code(401).send({ error: "bad signature" });
      }
      try {
        if (parsed.outcome === "completed") {
          const rows = await withRailCallback(ctx.pg, "app.payout_callback", async (c) =>
            c.query(
              `SELECT outcome, balance_minor AS "balanceMinor" FROM complete_withdrawal($1, $2)`,
              [parsed.requestId, parsed.reference],
            ),
          );
          const out = rows.rows[0] as { outcome: string };
          if (out.outcome === "paid" || out.outcome === "duplicate_reference") {
            walletWebhookResults().inc({ route: "payout", result: "accepted" });
            return reply.send({ ok: true, outcome: out.outcome });
          }
          walletWebhookResults().inc({ route: "payout", result: "rejected" });
          if (out.outcome === "unknown_request") return reply.code(404).send({ error: "withdrawal not found" });
          if (out.outcome === "illegal_state") {
            return reply.code(409).send({ error: "the withdrawal is not processing (AMD-PAY-17)" });
          }
          if (out.outcome === "insufficient_funds") {
            return reply.code(409).send({ error: "the wallet cannot cover the payout (AMD-PAY-17)" });
          }
          return reply.code(403).send({ error: "forbidden" });
        }
        const outcome = await withRailCallback(ctx.pg, "app.payout_callback", async (c) => {
          const r = await c.query(`SELECT fail_withdrawal($1, $2) AS outcome`, [parsed.requestId, parsed.reference]);
          return (r.rows[0] as { outcome: string }).outcome;
        });
        if (outcome === "failed" || outcome === "duplicate_reference") {
          walletWebhookResults().inc({ route: "payout", result: "accepted" });
          return reply.send({ ok: true, outcome });
        }
        walletWebhookResults().inc({ route: "payout", result: "rejected" });
        if (outcome === "unknown_request") return reply.code(404).send({ error: "withdrawal not found" });
        if (outcome === "illegal_state") {
          return reply.code(409).send({ error: "the withdrawal is not processing (AMD-PAY-17)" });
        }
        return reply.code(403).send({ error: "forbidden" });
      } catch (err) {
        if (err instanceof WalletRailUnavailable) {
          return reply.code(503).send({ error: "the wallet rail is disabled by operations (AMD-PAY-15)" });
        }
        throw err;
      }
    },
  );
}
