/**
 * Message relay (PRS-SRS-001 §5.4, FR-36). Clients encrypt with MLS; the edge
 * relays and stores opaque envelopes only. The RLS policy on `messages` makes
 * the OPEN gate non-negotiable — a pre-OPEN pair cannot exchange envelopes
 * even with a stolen token.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";

export function registerMessageRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post("/v1/pairs/:pairId/messages", async (req, reply) => {
    const { pairId } = req.params as { pairId: string };
    const { envelope } = req.body as { envelope?: string };
    if (!envelope || typeof envelope !== "string") {
      return reply.code(422).send({ error: "envelope (base64 MLS ciphertext) is required" });
    }
    try {
      const id = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `INSERT INTO messages (pair_id, sender, envelope)
           VALUES ($1, $2, decode($3, 'base64')) RETURNING message_id, sent_at`,
          [pairId, req.userId, envelope],
        );
        return r.rows[0];
      });
      return reply.code(201).send({ messageId: id.message_id, sentAt: id.sent_at });
    } catch (err) {
      const e = err as { message?: string };
      if (e.message?.includes("row-level security") || e.message?.includes("new row violates")) {
        return reply.code(403).send({ error: "messages require an OPEN pair (FR-30/FR-36)" });
      }
      throw err;
    }
  });

  app.get("/v1/pairs/:pairId/messages", async (req, reply) => {
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
  });
}
