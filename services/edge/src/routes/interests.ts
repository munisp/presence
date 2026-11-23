/**
 * Interest popularity (PRS-SRS-001 §3.6).
 *
 *   GET /v1/interests/:nodeId/popularity — FR-13: how many people near the
 *   requester carry this interest. "Near" is the requester's live H3 cell;
 *   the count includes declarations of the node itself and of its taxonomy
 *   descendants (taxonomy_closure). Every figure passes through kSuppressed
 *   (BR-13): below k, the venue/requester sees "suppressed", never the small
 *   number. Sensitive nodes are invisible to the endpoint (TR-22).
 */

import { FastifyInstance } from "fastify";
import { kSuppressed, K_MIN } from "../aggregate.js";
import { EdgeContext } from "../context.js";

export function registerInterestRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get(
    "/v1/interests/:nodeId/popularity",
    {
      schema: {
        params: {
          type: "object",
          required: ["nodeId"],
          additionalProperties: false,
          properties: { nodeId: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const { nodeId } = req.params as { nodeId: string };

      const node = await ctx.pg.query(
        "SELECT sensitive FROM taxonomy_nodes WHERE node_id = $1",
        [nodeId],
      );
      // Unknown and sensitive nodes share one refusal — the endpoint must not
      // confirm that a sensitive node exists (TR-22).
      if (node.rows.length === 0 || node.rows[0].sensitive === true) {
        return reply.code(404).send({ error: "unknown interest" });
      }

      // FR-13: "local" is the requester's live cell.
      const presence = await ctx.valkey.get(`presence:user:${req.userId}`);
      if (!presence) {
        return reply.code(409).send({ error: "no live presence; enter a venue first" });
      }
      const { cell } = JSON.parse(presence) as { cell: string };
      const members = await ctx.valkey.smembers(`presence:cell:${cell}`);
      // Filter stale set entries the same way the match service does.
      let live: string[] = [];
      if (members.length > 0) {
        const pipe = ctx.valkey.pipeline();
        for (const m of members) pipe.exists(`presence:user:${m}`);
        const res = await pipe.exec();
        live = members.filter((_: string, i: number) => res?.[i]?.[1] === 1);
      }

      let count = 0;
      if (live.length > 0) {
        // Declarations of the node itself plus its descendants (the closure
        // table has no self-hop, hence the OR).
        const r = await ctx.pg.query(
          `SELECT count(DISTINCT pi.user_id) AS n
             FROM profile_interests pi
             LEFT JOIN taxonomy_closure tc ON tc.node_id = pi.node_id
            WHERE (pi.node_id = $1 OR tc.ancestor_id = $1)
              AND pi.user_id = ANY($2::uuid[])`,
          [nodeId, live],
        );
        count = Number(r.rows[0].n);
      }

      // BR-13: k-anonymity suppression — below k the figure is withheld.
      return reply.send({
        nodeId,
        count: kSuppressed(count),
        suppressed: kSuppressed(count) === null,
        k: K_MIN,
      });
    },
  );
}
