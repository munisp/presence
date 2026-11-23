/**
 * Intent routes (PRS-SRS-001 §4) — FR-17.
 *
 *   PUT    /v1/presence/intent — declare an intent from the governed
 *                                vocabulary; requires live presence, expires
 *                                with presence or after 60 minutes
 *   GET    /v1/presence/intent — my current intent (204 when none)
 *   DELETE /v1/presence/intent — clear it early; idempotent
 *
 * The store is Valkey only: the intent is presence ephemera, never a
 * profile fact, so nothing about it reaches Postgres.
 */

import { FastifyInstance } from "fastify";
import { EdgeContext } from "../context.js";
import { INTENT_TTL_S, INTENT_VOCABULARY, parseIntent } from "../intents.js";

export function registerIntentRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.put(
    "/v1/presence/intent",
    {
      schema: {
        body: {
          type: "object",
          required: ["intent"],
          additionalProperties: false,
          properties: { intent: { type: "string", enum: [...INTENT_VOCABULARY] } },
        },
      },
    },
    async (req, reply) => {
      const parsed = parseIntent(req.body);
      if (!parsed.ok) return reply.code(422).send({ error: "intent must be from the governed vocabulary (FR-17)" });
      // An intent rides on presence: no live presence, nothing to attach to.
      const presence = await ctx.valkey.get(`presence:user:${req.userId}`);
      if (!presence) {
        return reply.code(409).send({ error: "no live presence; enter a venue first" });
      }
      await ctx.valkey.set(
        `intent:${req.userId}`,
        JSON.stringify({ intent: parsed.intent }),
        "EX",
        INTENT_TTL_S,
      );
      return reply.send({ intent: parsed.intent, expiresInSeconds: INTENT_TTL_S });
    },
  );

  app.get("/v1/presence/intent", async (req, reply) => {
    const raw = await ctx.valkey.get(`intent:${req.userId}`);
    if (!raw) return reply.code(204).send();
    const stored = JSON.parse(raw) as { intent: string };
    return reply.send({ intent: stored.intent });
  });

  app.delete("/v1/presence/intent", async (req, reply) => {
    await ctx.valkey.del(`intent:${req.userId}`);
    return reply.send({ ok: true });
  });
}
