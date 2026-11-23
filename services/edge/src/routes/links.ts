/**
 * Post-OPEN external link sharing (PRS-SRS-001 §4, FR-65/SEC-34).
 *
 *   PUT /v1/pairs/:pairId/link — share (or replace) your one allowlisted
 *     social link with the counterpart. The pair must be OPEN; the RLS
 *     policy makes that non-negotiable. Non-allowlisted or non-https links
 *     are rejected inline with a 422.
 *   GET /v1/pairs/:pairId/link — read the counterpart's link, and only the
 *     counterpart's. The response is plain text plus the interstitial flag
 *     the client renders as a leaving-the-app warning sheet (SEC-34). The
 *     server stores and returns the string; it never fetches it — there is
 *     no network code on this path.
 *
 * TR-23: strict params/body throughout.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import { parseSharedLink } from "../links.js";

const PAIR_PARAMS = {
  type: "object" as const,
  required: ["pairId"],
  additionalProperties: false as const,
  properties: { pairId: { type: "string", format: "uuid" } },
};

const NOT_OPEN = { error: "link sharing opens once the pair is OPEN" };

export function registerLinkRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.put(
    "/v1/pairs/:pairId/link",
    {
      schema: {
        params: PAIR_PARAMS,
        body: {
          type: "object",
          required: ["url"],
          additionalProperties: false,
          properties: { url: { type: "string", minLength: 1, maxLength: 300 } },
        },
      },
    },
    async (req, reply) => {
      const { pairId } = req.params as { pairId: string };
      const { url } = req.body as { url: string };
      const parsed = parseSharedLink(url);
      if (!parsed.ok) {
        return reply.code(422).send({ error: parsed.error });
      }
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const m = await c.query("SELECT state FROM matches WHERE pair_id = $1", [pairId]);
        if (m.rows.length === 0) return { status: 404 as const };
        if (m.rows[0].state !== "OPEN") return { status: 409 as const };
        const r = await c.query(
          `INSERT INTO pair_links (pair_id, owner, url)
           VALUES ($1, $2, $3)
           ON CONFLICT (pair_id, owner)
           DO UPDATE SET url = EXCLUDED.url, updated_at = now()
           RETURNING shared_at, updated_at`,
          [pairId, req.userId, parsed.link.url],
        );
        return {
          status: 200 as const,
          sharedAt: r.rows[0].shared_at as string,
          updatedAt: r.rows[0].updated_at as string,
        };
      });
      if (out.status === 404) return reply.code(404).send({ error: "pair not found" });
      if (out.status === 409) return reply.code(409).send(NOT_OPEN);
      return reply.send({
        url: parsed.link.url,
        domain: parsed.link.domain,
        interstitial: true, // SEC-34: the client renders the warning sheet
        sharedAt: out.sharedAt,
        updatedAt: out.updatedAt,
      });
    },
  );

  app.get(
    "/v1/pairs/:pairId/link",
    { schema: { params: PAIR_PARAMS } },
    async (req, reply) => {
      const { pairId } = req.params as { pairId: string };
      const out = await withRls(ctx.pg, req.userId, async (c) => {
        const m = await c.query("SELECT state FROM matches WHERE pair_id = $1", [pairId]);
        if (m.rows.length === 0) return { status: 404 as const };
        if (m.rows[0].state !== "OPEN") return { status: 409 as const };
        // FR-65: the counterpart's link, never your own.
        const r = await c.query(
          "SELECT url, shared_at, updated_at FROM pair_links WHERE pair_id = $1 AND owner <> $2",
          [pairId, req.userId],
        );
        if (r.rows.length === 0) return { status: 204 as const };
        return {
          status: 200 as const,
          url: r.rows[0].url as string,
          sharedAt: r.rows[0].shared_at as string,
          updatedAt: r.rows[0].updated_at as string,
        };
      });
      if (out.status === 404) return reply.code(404).send({ error: "pair not found" });
      if (out.status === 409) return reply.code(409).send(NOT_OPEN);
      if (out.status === 204) return reply.code(204).send();
      // The stored URL was validated at write time; re-derive the display
      // domain defensively rather than trusting the row.
      const domain = parseSharedLink(out.url);
      return reply.send({
        url: out.url,
        domain: domain.ok ? domain.link.domain : null,
        interstitial: true, // SEC-34: plain text; client shows the sheet
        sharedAt: out.sharedAt,
        updatedAt: out.updatedAt,
      });
    },
  );
}
