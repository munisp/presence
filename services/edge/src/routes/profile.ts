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
 *   PUT /v1/profile/identity  — FR-06: handle (set-once), optional display
 *     name (<=80 chars, defaults to the handle when unset) and a one-line
 *     bio of at most 140 characters. Free text is screened like prompts.
 *   GET /v1/profile/identity  — the requester's own identity block.
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
        "SELECT node_id, sensitive, redirect_to FROM taxonomy_nodes WHERE node_id = ANY($1::text[])",
        [nodeIds],
      );
      const found = new Map(
        rows.rows.map((r) => [r.node_id as string, { sensitive: r.sensitive as boolean, redirectTo: r.redirect_to as string | null }]),
      );
      for (const i of interests) {
        const node = found.get(i.nodeId);
        if (node === undefined) {
          return reply.code(422).send({ error: `unknown taxonomy node: ${i.nodeId}` });
        }
        if (node.redirectTo !== null) {
          // TR-19: deprecation is a redirect — the editor follows it to the
          // live successor rather than storing a dead id.
          return reply.code(422).send({ error: "that interest has moved", redirectTo: node.redirectTo });
        }
        if (node.sensitive) {
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
    // FR-11: the discoverability floor counts NON-sensitive interests — a
    // node flipped sensitive by taxonomy governance (FR-59) after it was
    // declared no longer counts. When the profile falls below the floor the
    // response says so and explains why, so the editor can show the reason
    // before the user leaves the screen.
    const flags = await ctx.pg.query(
      "SELECT node_id, sensitive FROM taxonomy_nodes WHERE node_id = ANY($1::text[])",
      [rows.rows.map((r) => r.nodeId)],
    );
    const sensitive = new Map(flags.rows.map((r) => [r.node_id as string, r.sensitive as boolean]));
    const nonSensitive = rows.rows.filter((r) => sensitive.get(r.nodeId) === false).length;
    const discoverable = nonSensitive >= 2;
    return reply.send({
      interests: rows.rows,
      discoverable,
      ...(discoverable
        ? {}
        : {
            discoverabilityNote:
              "Your profile is not discoverable: it has fewer than two non-sensitive " +
              "interests. Add interests to re-enter discovery (FR-11).",
          }),
    });
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

  // FR-06: handle, optional display name (defaults to the handle), one-line
  // bio of at most 140 characters. The photo is uploaded out of band and
  // stays hidden until OPEN (identity_after_open RLS) — it is not set here.
  const IDENTITY_PROPS = {
    handle: { type: "string", pattern: "^[a-z0-9_]{3,24}$" },
    displayName: { type: ["string", "null"], minLength: 1, maxLength: 80 },
    bio: { type: ["string", "null"], maxLength: 140 },
  } as const;

  app.put(
    "/v1/profile/identity",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: IDENTITY_PROPS,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        handle?: string;
        displayName?: string | null;
        bio?: string | null;
      };
      if (body.handle === undefined && body.displayName === undefined && body.bio === undefined) {
        return reply.code(422).send({ error: "nothing to update" });
      }
      // FR-06/SEC-37: free text is screened like prompts — the explanation
      // names categories, never the matched text.
      for (const [field, value] of [["displayName", body.displayName], ["bio", body.bio]] as const) {
        if (typeof value !== "string") continue;
        const findings = screenText(value);
        if (findings.length > 0) {
          const categories = [...new Set(findings.map((f) => SCREENING_EXPLANATION[f.category]))];
          return reply.code(422).send({
            error: `${field} cannot contain ${categories.join(", ")}`,
            categories: findings.map((f) => f.category),
          });
        }
      }
      const result = await withRls(ctx.pg, req.userId, async (c) => {
        const existing = await c.query(
          "SELECT handle FROM user_identities WHERE user_id = $1",
          [req.userId],
        );
        if (existing.rows.length === 0) {
          // First write: the handle is required to anchor the identity.
          if (body.handle === undefined) {
            return { status: 422 as const, error: "handle is required on first write (FR-06)" };
          }
          await c.query(
            `INSERT INTO user_identities (user_id, handle, display_name, bio, updated_at)
             VALUES ($1, $2, $3, $4, now())`,
            [req.userId, body.handle, body.displayName ?? null, body.bio ?? null],
          );
        } else {
          // The handle is set-once: a different handle is a conflict.
          if (body.handle !== undefined && body.handle !== existing.rows[0].handle) {
            return { status: 409 as const, error: "handle is set-once (FR-06)" };
          }
          const sets: string[] = ["updated_at = now()"];
          const vals: unknown[] = [req.userId];
          if (body.displayName !== undefined) {
            vals.push(body.displayName);
            sets.push(`display_name = $${vals.length}`);
          }
          if (body.bio !== undefined) {
            vals.push(body.bio);
            sets.push(`bio = $${vals.length}`);
          }
          await c.query(
            `UPDATE user_identities SET ${sets.join(", ")} WHERE user_id = $1`,
            vals,
          );
        }
        const row = await c.query(
          `SELECT handle, COALESCE(display_name, handle) AS "displayName", bio,
                  photo_url AS "photoUrl", updated_at AS "updatedAt"
             FROM user_identities WHERE user_id = $1`,
          [req.userId],
        );
        return { status: 200 as const, identity: row.rows[0] };
      });
      if (result.status !== 200) {
        return reply.code(result.status).send({ error: result.error });
      }
      return reply.send(result.identity);
    },
  );

  app.get("/v1/profile/identity", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        `SELECT handle, COALESCE(display_name, handle) AS "displayName", bio,
                photo_url AS "photoUrl", updated_at AS "updatedAt"
           FROM user_identities WHERE user_id = $1`,
        [req.userId],
      ),
    );
    if (rows.rows.length === 0) {
      return reply.code(404).send({ error: "identity not set up yet (FR-06)" });
    }
    return reply.send(rows.rows[0]);
  });
}
