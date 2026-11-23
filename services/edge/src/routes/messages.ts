/**
 * Message relay (PRS-SRS-001 §5.4, FR-36). Clients encrypt with MLS; the edge
 * relays and stores opaque envelopes only. The RLS policy on `messages` makes
 * the OPEN gate non-negotiable — a pre-OPEN pair cannot exchange envelopes
 * even with a stolen token.
 *
 * FR-38/SEC-21: the first message each sender posts to a pair is screened for
 * links, phone numbers, e-mail addresses, bypass and scam phrases before
 * storage. A violation is rejected inline with a category-level explanation;
 * nothing is stored or relayed. P0 envelopes are UTF-8 text; with MLS the
 * same classifier runs in the client compose path (see screening.ts).
 *
 * TR-23: params/body/query carry strict JSON Schemas — unknown fields fail
 * validation (400) before the handler runs.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import { screenEnvelope, screeningErrorMessage } from "../screening.js";
import { recordTelemetry } from "../telemetry.js";

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

interface ScreeningError extends Error {
  code: number;
  categories: string[];
}

export function registerMessageRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/pairs/:pairId/messages",
    {
      schema: {
        params: {
          type: "object",
          required: ["pairId"],
          additionalProperties: false,
          properties: { pairId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["envelope"],
          additionalProperties: false,
          properties: { envelope: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const { pairId } = req.params as { pairId: string };
      const { envelope } = req.body as { envelope: string };
      if (!BASE64_RE.test(envelope) || envelope.length % 4 !== 0) {
        return reply.code(422).send({ error: "envelope must be base64 MLS ciphertext" });
      }
      try {
        const out = await withRls(ctx.pg, req.userId, async (c) => {
          // FR-38: the sender's first message to this pair is screened.
          const prior = await c.query(
            "SELECT 1 FROM messages WHERE pair_id = $1 AND sender = $2 LIMIT 1",
            [pairId, req.userId],
          );
          if (prior.rows.length === 0) {
            const findings = screenEnvelope(Buffer.from(envelope, "base64"));
            if (findings && findings.length > 0) {
              const err = new Error(screeningErrorMessage(findings)) as ScreeningError;
              err.code = 422;
              err.categories = findings.map((f) => f.category);
              throw err;
            }
          }
          // NFR-32/TR-34: is this the pair's first message from either side?
          // (Pair-level; concurrent firsts can double-count by a hair —
          // product telemetry is approximate by design, never financial.)
          const pairPrior = await c.query("SELECT 1 FROM messages WHERE pair_id = $1 LIMIT 1", [pairId]);
          const r = await c.query(
            `INSERT INTO messages (pair_id, sender, envelope)
             VALUES ($1, $2, decode($3, 'base64')) RETURNING message_id, sent_at`,
            [pairId, req.userId, envelope],
          );
          return { row: r.rows[0], firstInPair: pairPrior.rows.length === 0 };
        });
        if (out.firstInPair) recordTelemetry(ctx, "pair.first_message");
        return reply.code(201).send({ messageId: out.row.message_id, sentAt: out.row.sent_at });
      } catch (err) {
        const e = err as { code?: number; message?: string; categories?: string[] };
        if (e.code === 422) {
          // FR-38: inline explanation by category; nothing was stored.
          return reply.code(422).send({ error: e.message, categories: e.categories });
        }
        if (e.message?.includes("row-level security") || e.message?.includes("new row violates")) {
          return reply.code(403).send({ error: "messages require an OPEN pair (FR-30/FR-36)" });
        }
        throw err;
      }
    },
  );

  app.get(
    "/v1/pairs/:pairId/messages",
    {
      schema: {
        params: {
          type: "object",
          required: ["pairId"],
          additionalProperties: false,
          properties: { pairId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { after: { type: "string", format: "date-time" } },
        },
      },
    },
    async (req, reply) => {
      const { pairId } = req.params as { pairId: string };
      const { after } = req.query as { after?: string };
      const rows = await withRls(ctx.pg, req.userId, async (c) =>
        c.query(
          `SELECT message_id, sender,
                  CASE WHEN revoked_at IS NULL THEN encode(envelope, 'base64') ELSE NULL END AS envelope,
                  sent_at, revoked_at IS NOT NULL AS revoked
             FROM messages
            WHERE pair_id = $1 AND ($2::timestamptz IS NULL OR sent_at > $2)
            ORDER BY sent_at ASC LIMIT 200`,
          [pairId, after ?? null],
        ),
      );
      return reply.send({ messages: rows.rows });
    },
  );

  // FR-41: a sender may revoke their own message within 24 hours — the
  // envelope is blanked and the row tombstoned (revoked_at). After the
  // window the message is permanent. The DELETE grant is column-limited and
  // the RESTRICTIVE policy makes revocation sender-only (migration 0006).
  app.delete(
    "/v1/pairs/:pairId/messages/:messageId",
    {
      schema: {
        params: {
          type: "object",
          required: ["pairId", "messageId"],
          additionalProperties: false,
          properties: {
            pairId: { type: "string", format: "uuid" },
            messageId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (req, reply) => {
      const { pairId, messageId } = req.params as { pairId: string; messageId: string };
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `UPDATE messages
              SET revoked_at = now(), envelope = ''::bytea
            WHERE message_id = $1 AND pair_id = $2 AND sender = $3
              AND revoked_at IS NULL
              AND sent_at > now() - interval '24 hours'
            RETURNING message_id`,
          [messageId, pairId, req.userId],
        );
        if (r.rows.length > 0) return "revoked" as const;
        const probe = await c.query(
          "SELECT sender, revoked_at FROM messages WHERE message_id = $1 AND pair_id = $2",
          [messageId, pairId],
        );
        if (probe.rows.length === 0 || probe.rows[0].sender !== req.userId) return "missing" as const;
        if (probe.rows[0].revoked_at) return "revoked" as const; // idempotent replay
        return "expired" as const;
      });
      if (outcome === "revoked") return reply.send({ ok: true });
      if (outcome === "missing") return reply.code(404).send({ error: "message not found" });
      return reply.code(410).send({ error: "the 24-hour revocation window has closed (FR-41)" });
    },
  );
}
