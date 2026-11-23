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
        const id = await withRls(ctx.pg, req.userId, async (c) => {
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
          const r = await c.query(
            `INSERT INTO messages (pair_id, sender, envelope)
             VALUES ($1, $2, decode($3, 'base64')) RETURNING message_id, sent_at`,
            [pairId, req.userId, envelope],
          );
          return r.rows[0];
        });
        return reply.code(201).send({ messageId: id.message_id, sentAt: id.sent_at });
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
          `SELECT message_id, sender, encode(envelope, 'base64') AS envelope, sent_at
             FROM messages
            WHERE pair_id = $1 AND ($2::timestamptz IS NULL OR sent_at > $2)
            ORDER BY sent_at ASC LIMIT 200`,
          [pairId, after ?? null],
        ),
      );
      return reply.send({ messages: rows.rows });
    },
  );
}
