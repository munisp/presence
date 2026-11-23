/**
 * Profile routes (PRS-SRS-001 §4.2).
 *
 *   PUT /v1/profile/interests — FR-08: replace the declared interest set
 *     (3-20 nodes). Nodes must exist in the governed taxonomy; sensitive
 *     nodes are rejected at write time (TR-22/FR-10), never stored. The
 *     searchable picker itself is client work.
 *   GET /v1/profile/interests — the requester's declared set.
 *   PUT /v1/profile/prompts   — FR-64: structured prompts, at most three of
 *     120 characters, screened like announcement bodies. They are reason
 *     material for surfaced candidates — never searchable, never indexed.
 *   GET /v1/profile/prompts   — the requester's own prompts.
 *
 * TR-23: strict bodies — unknown fields fail validation with a 400.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import { parseInterests, parsePrompts, PROMPT_MAX_COUNT, PROMPT_MAX_LEN } from "../profile.js";
import { SCREENING_EXPLANATION, screenText } from "../screening.js";

export function registerProfileRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.put(
    "/v1/profile/interests",
    {
      schema: {
        body: {
          type: "object",
          required: ["interests"],
          additionalProperties: false,
          properties: {
            interests: {
              type: "array",
              items: {
                type: "object",
                required: ["nodeId"],
                additionalProperties: false,
                properties: {
                  nodeId: { type: "string", minLength: 1, maxLength: 200 },
                  weight: { type: "number", exclusiveMinimum: 0, maximum: 1 },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { interests: raw } = req.body as { interests: unknown };
      const interests = parseInterests(raw);
      if (!interests) {
        return reply.code(422).send({
          error: "declare 3-20 unique interests with weights in (0, 1] (FR-08)",
        });
      }
      const nodeIds = interests.map((i) => i.nodeId);
      const rows = await ctx.pg.query(
        "SELECT node_id, sensitive FROM taxonomy_nodes WHERE node_id = ANY($1::text[])",
        [nodeIds],
      );
      const found = new Map(rows.rows.map((r) => [r.node_id as string, r.sensitive as boolean]));
      for (const i of interests) {
        const sensitive = found.get(i.nodeId);
        if (sensitive === undefined) {
          return reply.code(422).send({ error: `unknown taxonomy node: ${i.nodeId}` });
        }
        if (sensitive) {
          // TR-22/FR-10: sensitive nodes never enter a profile.
          return reply.code(422).send({ error: "that interest cannot be declared" });
        }
      }
      await withRls(ctx.pg, req.userId, async (c) => {
        await c.query("DELETE FROM profile_interests WHERE user_id = $1", [req.userId]);
        for (const i of interests) {
          await c.query(
            "INSERT INTO profile_interests (user_id, node_id, weight) VALUES ($1, $2, $3)",
            [req.userId, i.nodeId, i.weight],
          );
        }
      });
      return reply.send({ ok: true, count: interests.length });
    },
  );

  app.get("/v1/profile/interests", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        "SELECT node_id AS \"nodeId\", weight FROM profile_interests WHERE user_id = $1 ORDER BY node_id",
        [req.userId],
      ),
    );
    return reply.send({ interests: rows.rows });
  });

  app.put(
    "/v1/profile/prompts",
    {
      schema: {
        body: {
          type: "object",
          required: ["prompts"],
          additionalProperties: false,
          properties: {
            prompts: {
              type: "array",
              maxItems: PROMPT_MAX_COUNT,
              items: {
                type: "object",
                required: ["slot", "body"],
                additionalProperties: false,
                properties: {
                  slot: { type: "integer", minimum: 1, maximum: PROMPT_MAX_COUNT },
                  body: { type: "string", minLength: 1, maxLength: PROMPT_MAX_LEN },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { prompts: raw } = req.body as { prompts: unknown };
      const prompts = parsePrompts(raw);
      if (!prompts) {
        return reply.code(422).send({
          error: `prompts are at most ${PROMPT_MAX_COUNT} unique slots of <=${PROMPT_MAX_LEN} characters (FR-64)`,
        });
      }
      // FR-64/SEC-37: prompts are screened like announcement bodies; the
      // explanation names categories, never the matched text.
      for (const p of prompts) {
        const findings = screenText(p.body);
        if (findings.length > 0) {
          const categories = [...new Set(findings.map((f) => SCREENING_EXPLANATION[f.category]))];
          return reply.code(422).send({
            error: `prompts cannot contain ${categories.join(", ")}`,
            categories: findings.map((f) => f.category),
          });
        }
      }
      await withRls(ctx.pg, req.userId, async (c) => {
        const slots = prompts.map((p) => p.slot);
        await c.query(
          "DELETE FROM profile_prompts WHERE user_id = $1 AND NOT (slot = ANY($2::smallint[]))",
          [req.userId, slots],
        );
        for (const p of prompts) {
          await c.query(
            `INSERT INTO profile_prompts (user_id, slot, body)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, slot) DO UPDATE SET body = $3, updated_at = now()`,
            [req.userId, p.slot, p.body],
          );
        }
      });
      return reply.send({ ok: true, prompts });
    },
  );

  app.get("/v1/profile/prompts", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        "SELECT slot, body FROM profile_prompts WHERE user_id = $1 ORDER BY slot",
        [req.userId],
      ),
    );
    return reply.send({ prompts: rows.rows });
  });
}
