/**
 * Offer-lifecycle routes (PRS-SRS-001 §5.4).
 *
 *   POST /v1/consent/:pairId/decline — FR-32 silent decline: the pair closes,
 *                                      the counterpart sees only 'expired'
 *   POST /v1/consent/:pairId/keep    — FR-37 keep vote on an OPEN conversation;
 *                                      when both sides keep, the 24-h clock clears
 *   POST /v1/blocks                  — FR-34 block a user: immediate, silent,
 *                                      permanent mutual discovery removal
 *   GET  /v1/blocks                  — the caller's own block list (blocker side only)
 *
 * Decline and block never reveal themselves: decline answers 204 and publishes
 * an 'expired' event; block answers 201 and publishes nothing.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import { blockKey, maskCloseReason } from "../lifecycle.js";

export function registerLifecycleRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post("/v1/consent/:pairId/decline", async (req, reply) => {
    const { pairId } = req.params as { pairId: string };
    const result = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(
        `UPDATE matches
            SET closed_at = now(), close_reason = 'declined', declined_by = $2
          WHERE pair_id = $1
            AND closed_at IS NULL
            AND state <> 'OPEN'
            AND (expires_at IS NULL OR expires_at > now())
          RETURNING pair_id`,
        [pairId, req.userId],
      );
      return r.rows.length === 1;
    });
    if (!result) {
      // Already closed, already OPEN, or not a live offer — the response is
      // identical either way (decline must be indistinguishable from expiry).
      return reply.code(204).send();
    }
    // FR-32: the counterpart's realtime channel hears 'expired', never 'declined'.
    await fetch(`${ctx.centrifugoUrl}/api/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `apikey ${ctx.centrifugoApiKey}` },
      body: JSON.stringify({ channel: `pair:${pairId}`, data: { type: "expired" } }),
    }).catch((err) => console.error("centrifugo publish failed", err));
    return reply.code(204).send();
  });

  app.post("/v1/consent/:pairId/keep", async (req, reply) => {
    const { pairId } = req.params as { pairId: string };
    const row = await withRls(ctx.pg, req.userId, async (c) => {
      // FR-37: set the caller's keep flag; when both are set the 24-h clock
      // clears (closes_at -> NULL) and the conversation stays open.
      const r = await c.query(
        `UPDATE matches
            SET keep_lo   = CASE WHEN user_lo = $2 THEN true ELSE keep_lo END,
                keep_hi   = CASE WHEN user_hi = $2 THEN true ELSE keep_hi END,
                closes_at = CASE
                              WHEN (user_lo = $2 AND keep_hi) OR (user_hi = $2 AND keep_lo) THEN NULL
                              ELSE closes_at
                            END
          WHERE pair_id = $1
            AND state = 'OPEN'
            AND closed_at IS NULL
          RETURNING keep_lo, keep_hi, closes_at`,
        [pairId, req.userId],
      );
      return r.rows[0] ?? null;
    });
    if (!row) return reply.code(404).send({ error: "no open conversation for this pair" });
    return reply.send({ pairId, kept: row.keep_lo && row.keep_hi, closesAt: row.closes_at });
  });

  app.post("/v1/blocks", async (req, reply) => {
    const { userId: target } = req.body as { userId?: string };
    if (!target || typeof target !== "string" || target === req.userId) {
      return reply.code(422).send({ error: "userId of the user to block is required" });
    }
    await withRls(ctx.pg, req.userId, async (c) => {
      await c.query(
        "INSERT INTO blocks (blocker, blocked) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [req.userId, target],
      );
      // FR-34: any existing pair closes immediately and silently.
      await c.query(
        `UPDATE matches
            SET closed_at = now(), close_reason = 'blocked'
          WHERE closed_at IS NULL
            AND ((user_lo = $1 AND user_hi = $2) OR (user_lo = $2 AND user_hi = $1))`,
        [req.userId, target],
      );
    });
    // Permanent discovery suppression in both directions (no TTL — FR-23's
    // ten-minute window is for transient surfacing; a block never expires).
    await ctx.valkey.set(blockKey(req.userId, target), "1");
    // No realtime event: the removal is silent.
    return reply.code(201).send({ blocked: true });
  });

  app.get("/v1/blocks", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query("SELECT blocked, created_at FROM blocks ORDER BY created_at DESC", []),
    );
    return reply.send({ blocks: rows.rows.map((r) => ({ userId: r.blocked, at: r.created_at })) });
  });
}

export { maskCloseReason };
