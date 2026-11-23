/**
 * Consent routes (PRS-SRS-001 §5.4) — the FR-29 state machine over the
 * append-only ledger (FR-35), with identity gated behind OPEN (FR-30).
 *
 *   POST /v1/consent/:pairId/express — express interest; when the counterpart
 *                                      has already expressed, the pair
 *                                      advances to MUTUAL
 *   POST /v1/consent/:pairId/open    — open the channel from MUTUAL; only now
 *                                      does identity become visible
 *   GET  /v1/consent                 — my pairs and their states
 *
 * Illegal transitions are rejected by the database trigger — the edge computes
 * intent, Postgres enforces legality.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext, publishRealtime, ROTATION_TTL_S, rotationKey } from "../context.js";
import { CloseReason, maskCloseReason } from "../lifecycle.js";
import { WAVE_DAILY_MAX } from "../velocity.js";

type State = "DETECTED" | "NUDGED" | "EXPRESSED" | "MUTUAL" | "OPEN";

export function registerConsentRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get("/v1/consent", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        `SELECT pair_id, state, opened_at, closed_at, close_reason, expires_at, closes_at,
                user_lo = $1::uuid AS am_lo,
                CASE WHEN user_lo = $1::uuid THEN user_hi ELSE user_lo END AS counterpart
           FROM matches
          WHERE (close_reason IS NULL OR close_reason <> 'blocked')  -- FR-34: blocks are invisible
            AND (closed_at IS NULL OR closed_at > now() - interval '24 hours')  -- NFR-19 window
          ORDER BY opened_at DESC NULLS LAST`,
        [req.userId],
      ),
    );
    return reply.send({
      pairs: rows.rows.map((r) => ({
        pairId: r.pair_id,
        state: r.state as State,
        // FR-30: the counterpart id itself is pseudonymous pre-OPEN; the
        // client renders traits/reasons, not identity.
        counterpart: r.state === "OPEN" && !r.closed_at ? r.counterpart : null,
        opened: r.opened_at,
        // FR-32: closure is masked — 'declined' is reported as 'expired';
        // 'blocked' rows never reach this list at all (filtered above).
        closed: r.closed_at ? maskCloseReason(r.close_reason as CloseReason) : null,
        offerExpiresAt: r.state === "OPEN" ? null : r.expires_at,
        conversationClosesAt: r.state === "OPEN" && !r.closed_at ? r.closes_at : null,
      })),
    });
  });

  app.post("/v1/consent/:pairId/express", async (req, reply) => {
    const { pairId } = req.params as { pairId: string };

    // SEC-20: daily wave ceiling — a wave is a consent express.
    const daily = await ctx.valkey.incr(`rl:wave:d:${req.userId}`);
    if (daily === 1) await ctx.valkey.expire(`rl:wave:d:${req.userId}`, 86400);
    if (daily > WAVE_DAILY_MAX) {
      return reply.code(429).send({ error: "daily wave limit reached (SEC-20)" });
    }

    try {
      const state = await withRls(ctx.pg, req.userId, async (c) => {
        const cur = await c.query(
          "SELECT state, closed_at, expires_at, user_lo, user_hi FROM matches WHERE pair_id = $1",
          [pairId],
        );
        if (cur.rows.length === 0) throw Object.assign(new Error("pair not found"), { code: 404 });
        const { state: from, closed_at: closedAt, expires_at: expiresAt } = cur.rows[0];
        // FR-33: a closed offer, or one past its window, rejects new actions.
        if (closedAt || (expiresAt && new Date(expiresAt) <= new Date())) {
          throw Object.assign(new Error("offer expired (FR-33)"), { code: 409 });
        }
        // One side expressing: EXPRESSED. The second side: MUTUAL.
        const last = await c.query(
          "SELECT actor, to_state FROM consent_ledger WHERE pair_id = $1 ORDER BY seq DESC LIMIT 1",
          [pairId],
        );
        const counterpartExpressed =
          from === "EXPRESSED" && last.rows[0]?.actor && last.rows[0].actor !== req.userId;
        const to: State = counterpartExpressed ? "MUTUAL" : "EXPRESSED";
        await c.query(
          "INSERT INTO consent_ledger (pair_id, actor, from_state, to_state) VALUES ($1, $2, $3, $4)",
          [pairId, req.userId, from, to],
        );
        // FR-33: every action renews the 30-minute offer window.
        await c.query(
          "UPDATE matches SET expires_at = now() + interval '30 minutes' WHERE pair_id = $1 AND closed_at IS NULL",
          [pairId],
        );
        return { to, lo: cur.rows[0].user_lo as string, hi: cur.rows[0].user_hi as string };
      });
      // FR-91: an acted-on offer rotates out of both users' scan results for
      // seven days — a declined or expired offer is not re-served.
      await ctx.valkey.set(rotationKey(state.lo, state.hi), "1", "EX", ROTATION_TTL_S);
      if (state.to === "MUTUAL") await publish(ctx, pairId, { type: "mutual" });
      return reply.send({ pairId, state: state.to });
    } catch (err) {
      return consentError(reply, err);
    }
  });

  app.post("/v1/consent/:pairId/open", async (req, reply) => {
    const { pairId } = req.params as { pairId: string };
    try {
      await withRls(ctx.pg, req.userId, async (c) => {
        const cur = await c.query(
          "SELECT state, closed_at, expires_at FROM matches WHERE pair_id = $1",
          [pairId],
        );
        if (cur.rows.length === 0) throw Object.assign(new Error("pair not found"), { code: 404 });
        const { state: from, closed_at: closedAt, expires_at: expiresAt } = cur.rows[0];
        if (closedAt || (expiresAt && new Date(expiresAt) <= new Date())) {
          throw Object.assign(new Error("offer expired (FR-33)"), { code: 409 });
        }
        await c.query(
          "INSERT INTO consent_ledger (pair_id, actor, from_state, to_state) VALUES ($1, $2, $3, 'OPEN')",
          [pairId, req.userId, from],
        );
        // FR-37: the offer window ends; the 24-hour conversation clock starts.
        await c.query(
          `UPDATE matches
              SET expires_at = NULL,
                  closes_at = now() + interval '24 hours',
                  keep_lo = false,
                  keep_hi = false
            WHERE pair_id = $1 AND closed_at IS NULL`,
          [pairId],
        );
      });
      await publish(ctx, pairId, { type: "open" });
      return reply.send({ pairId, state: "OPEN" });
    } catch (err) {
      return consentError(reply, err);
    }
  });
}

/** Realtime fan-out through Centrifugo's server API (PRS-ARC-002 P0). */
async function publish(ctx: EdgeContext, pairId: string, event: object): Promise<void> {
  await publishRealtime(ctx, `pair:${pairId}`, event as Record<string, unknown>).catch((err) =>
    console.error("centrifugo publish failed", err),
  );
}

async function consentError(reply: any, err: unknown) {
  const e = err as { code?: number; message?: string };
  if (e.code === 404) return reply.code(404).send({ error: "pair not found" });
  if (e.code === 409) return reply.code(409).send({ error: e.message });
  if (e.message?.includes("illegal consent transition")) {
    return reply.code(409).send({ error: "illegal consent transition (FR-29)" });
  }
  throw err;
}
