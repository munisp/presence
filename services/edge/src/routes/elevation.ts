/**
 * SEC-03: just-in-time workforce elevation routes (migration 0022).
 *
 * Requester surface (workforce realm + elevation-eligible role):
 *
 *   POST /v1/console/elevation/requests        — request a time-boxed grant
 *   GET  /v1/console/elevation/requests/mine   — my requests and their state
 *
 * Decision surface (workforce realm + moderator role, under the
 * app.moderator GUC):
 *
 *   GET  /v1/moderation/elevation                      — the queue: pending
 *                                                        first, then recent
 *                                                        decisions
 *   POST /v1/moderation/elevation/:requestId/approve   — four-eyes approve;
 *                                                        binds the realm role
 *   POST /v1/moderation/elevation/:requestId/reject    — decline the request
 *   POST /v1/moderation/elevation/:requestId/revoke    — end a live grant
 *                                                        early; unbinds the
 *                                                        realm role
 *
 * The grant itself is a Postgres record (source of truth, audited inside the
 * definers); the Keycloak role binding is the automated replay of the grant
 * window — env-gated and fire-and-forget, so a binding outage never blocks
 * a moderation decision (keycloakAdmin.ts).
 */

import { FastifyInstance } from "fastify";
import { AuthedRequest, requireModerator, withModerator } from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  parseElevationRequestBody,
  requireElevationEligible,
} from "../elevation.js";
import {
  KeycloakAdminConfig,
  bindModeratorRole,
  keycloakAdminFromEnv,
} from "../keycloakAdmin.js";

const UUID_PARAMS = (names: string[]) => ({
  type: "object" as const,
  required: names,
  additionalProperties: false as const,
  properties: Object.fromEntries(names.map((n) => [n, { type: "string", format: "uuid" }])),
});

const QUEUE_LIMIT = 50;
const DECIDED_LIMIT = 20;

let adminConfig: KeycloakAdminConfig | null | undefined;

/** Lazy env gate — same discipline as the FR-56 push providers. */
function keycloakConfig(): KeycloakAdminConfig | null {
  if (adminConfig === undefined) adminConfig = keycloakAdminFromEnv();
  return adminConfig;
}

/** Map the definer's clean errors onto status codes. */
function elevationErrorCode(message: string): number {
  if (message.includes("not found")) return 404;
  return 409; // not pending / not active / four-eyes violation
}

export function registerElevationRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // ------------------------------------------------------- requester ----
  // The whole point of JIT elevation: eligible members do NOT hold standing
  // administrative access, so this gate is elevation-eligible, not moderator.
  app.post(
    "/v1/console/elevation/requests",
    {
      preHandler: [requireElevationEligible],
      schema: {
        body: {
          type: "object",
          required: ["justification"],
          additionalProperties: false,
          properties: {
            scope: { type: "string", enum: ["moderation"] },
            justification: { type: "string", minLength: 10, maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = parseElevationRequestBody(req.body);
      if (!parsed.ok) return reply.code(422).send({ error: parsed.error });
      const subject = (req as AuthedRequest).userId;
      const rows = await ctx.pg.query(
        "SELECT request_elevation($1::uuid, $2, $3) AS id",
        [subject, parsed.value.scope, parsed.value.justification],
      );
      return reply.code(201).send({ requestId: rows.rows[0].id, status: "pending" });
    },
  );

  app.get(
    "/v1/console/elevation/requests/mine",
    { preHandler: [requireElevationEligible] },
    async (req, reply) => {
      const rows = await ctx.pg.query(
        "SELECT request_id, scope, status, requested_at, decided_at, expires_at FROM my_elevations($1::uuid)",
        [(req as AuthedRequest).userId],
      );
      return reply.send({
        requests: rows.rows.map((r) => ({
          requestId: r.request_id,
          scope: r.scope,
          status: r.status,
          requestedAt: r.requested_at,
          decidedAt: r.decided_at,
          expiresAt: r.expires_at,
        })),
      });
    },
  );

  // -------------------------------------------------------- decisions ----
  // The queue: pending requests oldest-first, then the most recent decisions
  // so approvers can see what has already been actioned.
  app.get(
    "/v1/moderation/elevation",
    { preHandler: [requireModerator] },
    async (req, reply) => {
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(
          `(SELECT request_id, subject, scope, justification, status,
                   requested_at, decided_by, decided_at, expires_at
              FROM elevation_requests WHERE status = 'pending'
              ORDER BY requested_at ASC LIMIT $1)
           UNION ALL
           (SELECT request_id, subject, scope, justification, status,
                   requested_at, decided_by, decided_at, expires_at
              FROM elevation_requests WHERE status <> 'pending'
              ORDER BY decided_at DESC LIMIT $2)`,
          [QUEUE_LIMIT, DECIDED_LIMIT],
        ),
      );
      return reply.send({
        requests: rows.rows.map((r) => ({
          requestId: r.request_id,
          subject: r.subject,
          scope: r.scope,
          justification: r.justification,
          status: r.status,
          requestedAt: r.requested_at,
          decidedBy: r.decided_by,
          decidedAt: r.decided_at,
          expiresAt: r.expires_at,
        })),
      });
    },
  );

  // Four-eyes approve: the definer refuses when actor === requester; the
  // grant window is ELEVATION_GRANT_TTL_MS from the decision. The realm role
  // bind is fire-and-forget — the Postgres grant is authoritative.
  app.post(
    "/v1/moderation/elevation/:requestId/approve",
    { schema: { params: UUID_PARAMS(["requestId"]) }, preHandler: [requireModerator] },
    async (req, reply) => {
      const { requestId } = req.params as { requestId: string };
      const actor = (req as AuthedRequest).userId;
      try {
        const rows = await withModerator(ctx.pg, async (c) =>
          c.query("SELECT subject, expires_at FROM approve_elevation($1::uuid, $2::uuid)", [
            requestId,
            actor,
          ]),
        );
        const { subject, expires_at: expiresAt } = rows.rows[0];
        void bindModeratorRole(keycloakConfig(), "grant", subject);
        return reply.send({ requestId, status: "approved", subject, expiresAt });
      } catch (err) {
        const message = String((err as Error).message ?? err);
        return reply.code(elevationErrorCode(message)).send({ error: message });
      }
    },
  );

  app.post(
    "/v1/moderation/elevation/:requestId/reject",
    { schema: { params: UUID_PARAMS(["requestId"]) }, preHandler: [requireModerator] },
    async (req, reply) => {
      const { requestId } = req.params as { requestId: string };
      const actor = (req as AuthedRequest).userId;
      try {
        const rows = await withModerator(ctx.pg, async (c) =>
          c.query("SELECT reject_elevation($1::uuid, $2::uuid) AS subject", [requestId, actor]),
        );
        return reply.send({ requestId, status: "rejected", subject: rows.rows[0].subject });
      } catch (err) {
        const message = String((err as Error).message ?? err);
        return reply.code(elevationErrorCode(message)).send({ error: message });
      }
    },
  );

  app.post(
    "/v1/moderation/elevation/:requestId/revoke",
    { schema: { params: UUID_PARAMS(["requestId"]) }, preHandler: [requireModerator] },
    async (req, reply) => {
      const { requestId } = req.params as { requestId: string };
      const actor = (req as AuthedRequest).userId;
      try {
        const rows = await withModerator(ctx.pg, async (c) =>
          c.query("SELECT revoke_elevation($1::uuid, $2::uuid) AS subject", [requestId, actor]),
        );
        void bindModeratorRole(keycloakConfig(), "revoke", rows.rows[0].subject);
        return reply.send({ requestId, status: "revoked", subject: rows.rows[0].subject });
      } catch (err) {
        const message = String((err as Error).message ?? err);
        return reply.code(elevationErrorCode(message)).send({ error: message });
      }
    },
  );
}
