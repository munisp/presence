/**
 * Account routes (PRS-SRS-001 §4.1, §4.9) — age declaration, DSAR export and
 * account erasure.
 *
 *   POST   /v1/account/age-declaration — FR-02: declare a birth year; under-18
 *                                        sets age_blocked, which closes every
 *                                        discovery surface with a neutral 403
 *   GET    /v1/account/export          — FR-62/SEC-14: everything held on the
 *                                        requester, one JSON document
 *   DELETE /v1/account                 — FR-03/04: one call erases the account;
 *                                        presence, envelopes, profile and
 *                                        blocks go immediately, pairs close
 *                                        with neutral reasons
 *
 * The block is deliberately neutral: the response never says "under 18" —
 * discovery is simply "not available on this account".
 */

import { FastifyInstance } from "fastify";
import { EdgeContext } from "../context.js";

export const AGE_LIMIT = 18; // FR-02

/**
 * FR-02: year-only precision, failing toward the block at the boundary — a
 * user who turns 18 this calendar year is still blocked until it ends.
 */
export function isUnderage(birthYear: number, refYear = new Date().getUTCFullYear()): boolean {
  return refYear - birthYear < AGE_LIMIT;
}

/**
 * Discovery gate (FR-02/FR-04): age-blocked and deleted accounts cannot
 * publish presence or scan. Accounts without a row (pre-onboarding dev
 * flows) are allowed; the declaration endpoint creates the row.
 */
export async function isDiscoveryAllowed(ctx: EdgeContext, userId: string): Promise<boolean> {
  const r = await ctx.pg.query("SELECT age_blocked, deleted_at FROM users WHERE user_id = $1", [userId]);
  if (r.rows.length === 0) return true;
  return !r.rows[0].age_blocked && !r.rows[0].deleted_at;
}

export const DISCOVERY_BLOCKED_ERROR = "discovery is not available on this account";

export function registerAccountRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post("/v1/account/age-declaration", async (req, reply) => {
    const { birthYear } = req.body as { birthYear?: unknown };
    const thisYear = new Date().getUTCFullYear();
    if (typeof birthYear !== "number" || !Number.isInteger(birthYear) || birthYear < 1900 || birthYear > thisYear) {
      return reply.code(422).send({ error: "birthYear must be a valid year" });
    }
    const blocked = isUnderage(birthYear, thisYear);
    await ctx.pg.query(
      `INSERT INTO users (user_id, birth_year, age_declared_at, age_blocked)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (user_id) DO UPDATE
          SET birth_year = $2, age_declared_at = now(), age_blocked = $3`,
      [req.userId, birthYear, blocked],
    );
    // Neutral response: the shape is identical either way; the client renders
    // a plain "discovery unavailable" notice, never a reason.
    return reply.send({ ok: true, discovery: !blocked });
  });

  app.get("/v1/account/export", async (req, reply) => {
    // FR-62/SEC-14: the assemble half of the DSAR tooling. The function runs
    // as owner (INSERT-only reports policy, blocked-side rows, etc. stay
    // unreachable through the app role) and applies FR-32/34 masking itself.
    const r = await ctx.pg.query("SELECT dsar_export($1::uuid) AS doc", [req.userId]);
    return reply.send(r.rows[0].doc);
  });

  app.delete("/v1/account", async (req, reply) => {
    const userId = req.userId;

    // FR-04, index removal: presence, cell/venue membership, and every
    // suppression/block key naming this user — synchronously, well inside 60 s.
    const previous = await ctx.valkey.get(`presence:user:${userId}`);
    if (previous) {
      const prev = JSON.parse(previous) as { cell: string; venueId?: string | null };
      const pipe = ctx.valkey.pipeline();
      pipe.srem(`presence:cell:${prev.cell}`, userId);
      if (prev.venueId) pipe.srem(`presence:venue:${prev.venueId}`, userId);
      pipe.del(`presence:user:${userId}`);
      await pipe.exec();
    }
    for (const pattern of [
      `suppress:${userId}:*`,
      `suppress:*:${userId}`,
      `block:${userId}:*`,
      `block:*:${userId}`,
    ]) {
      let cursor = "0";
      do {
        const [next, keys] = await ctx.valkey.scan(cursor, "MATCH", pattern, "COUNT", 200);
        cursor = next;
        if (keys.length) await ctx.valkey.unlink(...keys);
      } while (cursor !== "0");
    }

    // FR-03/04: envelopes, pairs (closed with neutral reasons), blocks,
    // profile, identity — gone; the account row becomes an anonymous
    // tombstone; ledger attribution is anonymised after the 90-day hold.
    await ctx.pg.query("SELECT delete_account($1::uuid)", [userId]);
    return reply.code(204).send();
  });
}
