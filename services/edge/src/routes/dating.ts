/**
 * Dating routes (SRS Addendum 001 — AMD-DATE-01..05).
 *
 *   POST /v1/dating/preferences        — AMD-DATE-01: set or refresh the
 *     caller's dating profile; the definer proves KYC + age at write.
 *   GET  /v1/dating/profile            — own profile (RLS owner read).
 *   POST /v1/dating/state              — AMD-DATE-05: pause / resume;
 *     resuming re-proves both gates.
 *   GET  /v1/dating/compatibility?peer — AMD-DATE-03: a boolean, computed
 *     server-side; the cause is never revealed (FR-34 silence).
 *   GET  /v1/dating/counterpart?peer   — AMD-DATE-04: the counterpart's
 *     dating attributes, only when mutually compatible AND the pair stands
 *     at NUDGED or later. Ranges, never birth years.
 *
 * No value moves here — every call runs inside withRls. Every POST is
 * rate-limited (AMD-OPS-03). The scan-route filter (dating_filter_
 * candidates) lives in routes/scan.ts, applied before any pair surfaces.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  parseDatingPeerQuery,
  parseDatingPreferencesBody,
  parseDatingStateBody,
} from "../dating.js";

const DATING_WRITE_RATE_LIMIT = {
  max: 30,
  timeWindow: "1 minute",
  keyGenerator: (req: { userId: string }) => req.userId,
} as const;

export function registerDatingRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/dating/preferences",
    { config: { rateLimit: DATING_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseDatingPreferencesBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(
          `SELECT set_dating_preferences($1, $2, $3, $4, $5) AS outcome`,
          [parsed.gender, parsed.seeking, parsed.goal, parsed.ageMin, parsed.ageMax],
        );
        return r.rows[0].outcome as string;
      });
      if (outcome === "recorded") return reply.send({ state: "recorded" });
      if (outcome === "invalid_preferences") return reply.code(400).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );

  app.get("/v1/dating/profile", async (req, reply) => {
    const row = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(
        `SELECT gender, seeking, goal,
                age_min AS "ageMin", age_max AS "ageMax", state,
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM dating_profiles
          WHERE user_id = app_user()`,
      );
      return r.rows[0] ?? null;
    });
    return reply.send({ profile: row });
  });

  app.post(
    "/v1/dating/state",
    { config: { rateLimit: DATING_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = parseDatingStateBody(req.body);
      if (!parsed) return reply.code(400).send({ error: "invalid body" });
      const outcome = await withRls(ctx.pg, req.userId, async (c) => {
        const r = await c.query(`SELECT set_dating_state($1) AS outcome`, [parsed.state]);
        return r.rows[0].outcome as string;
      });
      if (outcome === "updated") return reply.send({ state: parsed.state });
      if (outcome === "unknown_profile") return reply.code(404).send({ error: outcome });
      if (outcome === "invalid_state") return reply.code(400).send({ error: outcome });
      return reply.code(403).send({ error: outcome });
    },
  );

  app.get("/v1/dating/compatibility", async (req, reply) => {
    const parsed = parseDatingPeerQuery(req.query);
    if (!parsed) return reply.code(400).send({ error: "invalid query" });
    const compatible = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(`SELECT dating_compatible($1) AS ok`, [parsed.peer]);
      return r.rows[0].ok as boolean;
    });
    return reply.send({ compatible });
  });

  app.get("/v1/dating/counterpart", async (req, reply) => {
    const parsed = parseDatingPeerQuery(req.query);
    if (!parsed) return reply.code(400).send({ error: "invalid query" });
    const profile = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(`SELECT dating_counterpart($1) AS profile`, [parsed.peer]);
      return r.rows[0].profile as unknown;
    });
    return reply.send({ profile });
  });
}
