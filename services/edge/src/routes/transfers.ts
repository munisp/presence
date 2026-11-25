/**
 * P2P transfer routes (SRS Addendum 001 — AMD-PAY-01..08).
 *
 *   POST /v1/transfers                          — AMD-PAY-05/06: propose a
 *     structured transfer to the other side of an OPEN conversation. The
 *     propose_transfer definer decides everything: both parties
 *     KYC-verified, no payment suspension, per-transfer and rolling
 *     24 h caps, the 100 bps fee computed and stored, the one-hour
 *     acceptance window. The route only maps the outcome.
 *   GET  /v1/transfers                          — the requester's transfers,
 *     party-scoped by RLS; stale proposals are lazily expired first so no
 *     proposal outlives its window. AMD-PAY-03: the row is amount,
 *     currency, fee and state — there is no free text to return.
 *   POST /v1/transfers/:transferId/accept       — the recipient consents
 *     (dual consent, AMD-PAY-04); the definer re-proves KYC and the OPEN
 *     pair at this second moment (AMD-PAY-06).
 *   POST /v1/transfers/:transferId/decline      — the recipient refuses;
 *     always available while proposed.
 *   POST /v1/transfers/:transferId/cancel       — the sender retracts
 *     while proposed.
 *   POST /v1/transfers/:transferId/dispute      — either party disputes an
 *     accepted or settled transfer; the reason is a closed category,
 *     never free text (AMD-PAY-03).
 *   POST /v1/moderation/transfers/:transferId/resolve — AMD-PAY-04/07:
 *     workforce resolution of a dispute, gated by requireModerator and
 *     executed inside the app.moderator GUC; the definer enforces the
 *     outcome vocabulary and writes both the ledger row and the admin
 *     audit entry.
 *
 * AMD-PAY-08: there is deliberately no settle route — 'settled' is
 * reachable only through the app.transfer_settlement GUC that no P0
 * component sets. The TECH-23 deployment gate stands.
 *
 * TR-23: strict bodies — unknown fields fail validation with a 400.
 */

import { FastifyInstance, FastifyReply } from "fastify";
import { requireModerator, withModerator, withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  parseDisputeOutcome,
  parseTransferDispute,
  parseTransferProposal,
} from "../transfers.js";

export function registerTransferRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/transfers",
    {
      schema: {
        body: {
          type: "object",
          required: ["recipient", "amountMinor"],
          additionalProperties: false,
          properties: {
            recipient: { type: "string", format: "uuid" },
            amountMinor: { type: "integer" },
          },
        },
      },
    },
    async (req, reply) => {
      const proposal = parseTransferProposal(req.body);
      if (proposal === null) {
        return reply.code(422).send({ error: "a transfer is a recipient and an amount (AMD-PAY-03)" });
      }
      const rows = await withRls(ctx.pg, req.userId, async (c) =>
        c.query(
          `SELECT outcome, transfer_id AS "transferId", fee_minor AS "feeMinor",
                  expires_at AS "expiresAt"
             FROM propose_transfer($1, $2, $3)`,
          [req.userId, proposal.recipient, proposal.amountMinor],
        ),
      );
      const out = rows.rows[0] as {
        outcome: string;
        transferId: string | null;
        feeMinor: number | null;
        expiresAt: Date | null;
      };
      if (out.outcome === "proposed") {
        return reply.code(201).send({
          transferId: out.transferId,
          feeMinor: out.feeMinor,
          expiresAt: out.expiresAt,
        });
      }
      if (out.outcome === "over_transfer_cap" || out.outcome === "over_daily_cap") {
        return reply.code(422).send({ error: "the amount exceeds a platform cap (AMD-PAY-05)" });
      }
      if (out.outcome === "invalid_amount") {
        return reply.code(422).send({ error: "the amount is not transferable (AMD-PAY-05)" });
      }
      if (out.outcome === "not_kyc_verified") {
        return reply.code(403).send({ error: "both sides must be verified to send money (AMD-PAY-06)" });
      }
      if (out.outcome === "suspended") {
        return reply.code(403).send({ error: "transfers are suspended for this pair (AMD-PAY-06)" });
      }
      if (out.outcome === "no_open_conversation") {
        return reply.code(403).send({ error: "money moves only inside an open conversation (AMD-PAY-06)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  app.get("/v1/transfers", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) => {
      // AMD-PAY-06: no proposal outlives its one-hour window.
      await c.query("SELECT expire_stale_transfers()");
      return c.query(
        `SELECT transfer_id AS "transferId",
                CASE WHEN sender = $1 THEN recipient ELSE sender END AS "counterpart",
                CASE WHEN sender = $1 THEN 'sender' ELSE 'recipient' END AS "role",
                amount_minor AS "amountMinor",
                fee_minor AS "feeMinor",
                currency,
                state,
                proposed_at AS "proposedAt",
                expires_at AS "expiresAt",
                resolved_outcome AS "resolvedOutcome"
           FROM transfers
          WHERE $1 IN (sender, recipient)
          ORDER BY proposed_at DESC LIMIT 100`,
        [req.userId],
      );
    });
    return reply.send({ transfers: rows.rows });
  });

  const mapEventOutcome = (
    outcome: string,
    reply: FastifyReply,
    transferId: string,
    state: string,
  ) => {
    if (outcome === "recorded") return reply.send({ transferId, state });
    if (outcome === "unknown_transfer") return reply.code(404).send({ error: "transfer not found" });
    if (outcome === "illegal_transition") {
      return reply.code(409).send({ error: "illegal transfer transition (AMD-PAY-04)" });
    }
    if (outcome === "not_kyc_verified") {
      return reply.code(403).send({ error: "both sides must be verified to send money (AMD-PAY-06)" });
    }
    if (outcome === "pair_not_open") {
      return reply.code(403).send({ error: "money moves only inside an open conversation (AMD-PAY-06)" });
    }
    return reply.code(403).send({ error: "forbidden" });
  };

  const transferParams = {
    type: "object",
    required: ["transferId"],
    additionalProperties: false,
    properties: { transferId: { type: "string", format: "uuid" } },
  } as const;

  app.post(
    "/v1/transfers/:transferId/accept",
    { schema: { params: transferParams } },
    async (req, reply) => {
      const { transferId } = req.params as { transferId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT record_transfer_event($1, $2, 'accepted') AS outcome`,
          [transferId, req.userId],
        );
        return (r.rows[0] as { outcome: string }).outcome;
      });
      return mapEventOutcome(outcome, reply, transferId, "accepted");
    },
  );

  app.post(
    "/v1/transfers/:transferId/decline",
    { schema: { params: transferParams } },
    async (req, reply) => {
      const { transferId } = req.params as { transferId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT record_transfer_event($1, $2, 'declined') AS outcome`,
          [transferId, req.userId],
        );
        return (r.rows[0] as { outcome: string }).outcome;
      });
      return mapEventOutcome(outcome, reply, transferId, "declined");
    },
  );

  app.post(
    "/v1/transfers/:transferId/cancel",
    { schema: { params: transferParams } },
    async (req, reply) => {
      const { transferId } = req.params as { transferId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT record_transfer_event($1, $2, 'cancelled') AS outcome`,
          [transferId, req.userId],
        );
        return (r.rows[0] as { outcome: string }).outcome;
      });
      return mapEventOutcome(outcome, reply, transferId, "cancelled");
    },
  );

  app.post(
    "/v1/transfers/:transferId/dispute",
    {
      schema: {
        params: transferParams,
        body: {
          type: "object",
          required: ["reason"],
          additionalProperties: false,
          properties: {
            reason: { type: "string", enum: ["not-received", "wrong-amount", "unauthorised"] },
          },
        },
      },
    },
    async (req, reply) => {
      const { transferId } = req.params as { transferId: string };
      const dispute = parseTransferDispute(req.body);
      if (dispute === null) {
        return reply.code(422).send({ error: "a dispute is a category, never free text (AMD-PAY-03)" });
      }
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT record_transfer_event($1, $2, 'disputed', jsonb_build_object('reason', $3)) AS outcome`,
          [transferId, req.userId, dispute.reason],
        );
        return (r.rows[0] as { outcome: string }).outcome;
      });
      return mapEventOutcome(outcome, reply, transferId, "disputed");
    },
  );

  app.post(
    "/v1/moderation/transfers/:transferId/resolve",
    {
      preHandler: requireModerator,
      schema: {
        params: transferParams,
        body: {
          type: "object",
          required: ["outcome"],
          additionalProperties: false,
          properties: {
            outcome: { type: "string", enum: ["upheld", "rejected"] },
          },
        },
      },
    },
    async (req, reply) => {
      const { transferId } = req.params as { transferId: string };
      const resolution = parseDisputeOutcome(req.body);
      if (resolution === null) {
        return reply.code(422).send({ error: "outcome must be upheld or rejected (AMD-PAY-04)" });
      }
      const outcome = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `SELECT record_transfer_event($1, $2, 'resolved', jsonb_build_object('outcome', $3)) AS outcome`,
          [transferId, req.userId, resolution.outcome],
        );
        return (r.rows[0] as { outcome: string }).outcome;
      });
      if (outcome === "unknown_transfer") return reply.code(404).send({ error: "transfer not found" });
      if (outcome === "illegal_transition") {
        return reply.code(409).send({ error: "illegal transfer transition (AMD-PAY-04)" });
      }
      if (outcome !== "recorded") return reply.code(403).send({ error: "forbidden" });
      return reply.send({ transferId, state: "resolved", outcome: resolution.outcome });
    },
  );
}
