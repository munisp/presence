/**
 * Linking route (PRS-SRS-001 §4 profile) — FR-09, TECH-09.
 *
 *   POST /v1/profile/interests/link — propose taxonomy nodes for a free-text
 *                                     phrase; per-node confirmation happens
 *                                     client-side and confirmed nodes go
 *                                     through the governed interests
 *                                     endpoint (FR-08). This route never
 *                                     writes interests — test-pinned.
 *
 * The search runs over pgvector (taxonomy_node_embeddings, HNSW cosine);
 * sensitive and redirected nodes are excluded at seed time and again at
 * query time. Nodes the user already declared are excluded so proposals
 * stay novel.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  EMBEDDER_ID,
  LINK_MAX_CANDIDATES,
  LINK_MIN_SIMILARITY,
  LINK_TEXT_MAX_LEN,
  embed,
  parseLinkBody,
  toVectorLiteral,
} from "../linking.js";
import { screenText } from "../screening.js";

export function registerLinkingRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/profile/interests/link",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: { text: { type: "string", maxLength: LINK_TEXT_MAX_LEN } },
        },
      },
    },
    async (req, reply) => {
      const parsed = parseLinkBody(req.body, screenText);
      if (!parsed.ok) return reply.code(422).send({ error: parsed.error });

      const vector = toVectorLiteral(embed(parsed.text));
      const candidates = await withRls(ctx.pg, req.userId, async (client) => {
        // FR-13 discipline: profile_interests is owner-RLS'd, so the
        // exclusion read runs inside the user's GUC, never as the app role.
        const declared = await client.query(
          "SELECT node_id FROM profile_interests WHERE user_id = $1",
          [req.userId],
        );
        const declaredIds = new Set(declared.rows.map((r) => r.node_id as string));
        const res = await client.query(
          "SELECT node_id, label, similarity FROM link_taxonomy_nodes($1::vector, $2)",
          [vector, LINK_MAX_CANDIDATES * 3],
        );
        return (res.rows as Array<{ node_id: string; label: string; similarity: number }>)
          .filter((r) => r.similarity >= LINK_MIN_SIMILARITY && !declaredIds.has(r.node_id))
          .slice(0, LINK_MAX_CANDIDATES);
      });

      return reply.send({
        embedder: EMBEDDER_ID,
        candidates: candidates.map((c) => ({
          nodeId: c.node_id,
          label: c.label,
          similarity: Number(c.similarity),
        })),
      });
    },
  );
}
