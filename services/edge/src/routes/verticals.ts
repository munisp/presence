/**
 * Vertical flag routes (SRS Addendum 001 — AMD-VERT-01..05).
 *
 *   GET /v1/account/verticals — AMD-VERT-04: the onboarding/settings read
 *     model. The full catalogue in display order with the caller's
 *     effective state, eligibility and reason, and whether the caller
 *     holds an explicit row.
 *   PUT /v1/account/verticals — AMD-VERT-05: the batch toggle write behind
 *     the onboarding screen ("onboarding") and the settings screen
 *     ("settings"). Body: { patch: { vertical: boolean, ... }, source }.
 *     All-or-nothing; enabling a gated vertical re-proves eligibility.
 *
 * No value moves here — every call runs inside withRls. PUT is naturally
 * idempotent (the patch is a target state); an Idempotency-Key header is
 * honoured like everywhere else in the scope (TR-24). The locked core is
 * part of the read model so the client can render it as always-on, but it
 * can never be narrowed.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import { parseVerticalsPatchBody } from "../verticals.js";

const VERTICAL_WRITE_RATE_LIMIT = {
  max: 30,
  timeWindow: "1 minute",
  keyGenerator: (req: { userId: string }) => req.userId,
} as const;

interface VerticalRow {
  vertical: string;
  label: string;
  summary: string;
  locked: boolean;
  eligible: boolean;
  reason: string | null;
  enabled: boolean;
  explicit_choice: boolean;
  source: string | null;
  sort_order: number;
}

export function registerVerticalRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get("/v1/account/verticals", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(`SELECT * FROM list_my_verticals()`);
      return r.rows as VerticalRow[];
    });
    return reply.send({
      verticals: rows.map((r) => ({
        vertical: r.vertical,
        label: r.label,
        summary: r.summary,
        locked: r.locked,
        eligible: r.eligible,
        ...(r.reason === null ? {} : { reason: r.reason }),
        enabled: r.enabled,
        explicitChoice: r.explicit_choice,
        ...(r.source === null ? {} : { source: r.source }),
      })),
    });
  });

  app.put(
    "/v1/account/verticals",
    { config: { rateLimit: VERTICAL_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseVerticalsPatchBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT set_user_verticals($1::jsonb, $2) AS outcome`,
          [JSON.stringify(parsed.patch), parsed.source],
        );
        return r.rows[0].outcome as string;
      });
      if (outcome === "updated") return reply.send({ state: "updated" });
      if (outcome === "invalid_patch" || outcome === "unknown_vertical") {
        return reply.code(400).send({ error: outcome });
      }
      // locked | kyc_required | underage | forbidden
      return reply.code(outcome === "locked" ? 409 : 403).send({ error: outcome });
    },
  );
}
