/**
 * Geofence authoring routes (TR-41; ADR-0008) — the ops-console workflow
 * behind the GeoLibre polygon editor.
 *
 *   POST /v1/ops/geofences                 — author a draft (venue or floor)
 *   GET  /v1/ops/geofences                 — list drafts (console queue)
 *   POST /v1/ops/geofences/:id/submit      — draft -> in_review
 *   POST /v1/ops/geofences/:id/approve     — in_review -> approved;
 *                                            reviewer must not be the author
 *   POST /v1/ops/geofences/:id/reject      — in_review -> rejected (+ note)
 *   POST /v1/ops/geofences/:id/publish     — approved -> published via the
 *                                            SECURITY DEFINER function that
 *                                            re-verifies the second person
 *                                            and the density gate in one txn
 *
 * Everything runs under the venue-ops workforce role and its GUC; the
 * publish path is DB-final so the four-eyes and density rules cannot be
 * bypassed from the edge.
 */

import { FastifyInstance } from "fastify";
import { EdgeContext } from "../context.js";
import { requireVenueOps, withVenueOps } from "../auth.js";
import { densityCheck, parseGeofencePolygon } from "../geofence.js";

const UUID_PARAMS = (names: string[]) => ({
  type: "object",
  required: names,
  properties: Object.fromEntries(names.map((n) => [n, { type: "string", format: "uuid" }])),
});

export function registerGeofenceRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/ops/geofences",
    {
      // TR-23: strict body — unknown fields fail validation with a 400.
      schema: {
        body: {
          type: "object",
          required: ["targetType", "venueId", "polygon"],
          additionalProperties: false,
          properties: {
            targetType: { type: "string", enum: ["venue", "floor"] },
            venueId: { type: "string", format: "uuid" },
            floorId: { type: "string", maxLength: 32 },
            polygon: { type: "object" },
          },
        },
      },
      preHandler: requireVenueOps,
    },
    async (req, reply) => {
      const body = req.body as {
        targetType: "venue" | "floor";
        venueId: string;
        floorId?: string;
        polygon: unknown;
      };
      if (body.targetType === "floor" && !body.floorId) {
        return reply.code(422).send({ error: "floor targets need a floorId" });
      }
      const parsed = parseGeofencePolygon(body.polygon);
      if (!parsed.ok) return reply.code(422).send({ error: parsed.error });
      // Early feedback with precise segment positions; the DB re-verifies
      // at publish time — this mirror is for the editor, not for safety.
      const density = densityCheck(parsed.ring);
      if (!density.ok) return reply.code(422).send({ error: density.error });
      const author = req.userId;
      const r = await withVenueOps(ctx.pg, (c) =>
        c.query(
          `INSERT INTO geofence_drafts (target_type, venue_id, floor_id, polygon, author)
           VALUES ($1, $2, $3, ST_GeomFromGeoJSON($4)::geography, $5)
           RETURNING draft_id, status, created_at`,
          [body.targetType, body.venueId, body.floorId ?? null, JSON.stringify(body.polygon), author],
        ),
      );
      const row = r.rows[0];
      return reply.send({ draftId: row.draft_id, status: row.status, createdAt: row.created_at });
    },
  );

  app.get(
    "/v1/ops/geofences",
    { preHandler: requireVenueOps },
    async (req, reply) => {
      const { status } = req.query as { status?: string };
      const allowed = ["draft", "in_review", "approved", "published", "rejected"];
      const filter = status && allowed.includes(status) ? status : null;
      const r = await withVenueOps(ctx.pg, (c) =>
        c.query(
          `SELECT draft_id, target_type, venue_id, floor_id, author, reviewer,
                  status, message, created_at, reviewed_at, published_at,
                  ST_NPoints(polygon::geometry) AS vertices,
                  ST_Area(polygon) AS area_m2
             FROM geofence_drafts
            WHERE ($1::text IS NULL OR status = $1)
            ORDER BY created_at DESC
            LIMIT 200`,
          [filter],
        ),
      );
      return reply.send({
        drafts: r.rows.map((d) => ({
          draftId: d.draft_id,
          targetType: d.target_type,
          venueId: d.venue_id,
          floorId: d.floor_id,
          author: d.author,
          reviewer: d.reviewer,
          status: d.status,
          message: d.message,
          createdAt: d.created_at,
          reviewedAt: d.reviewed_at,
          publishedAt: d.published_at,
          vertices: Number(d.vertices),
          areaM2: Math.round(Number(d.area_m2) * 10) / 10,
        })),
      });
    },
  );

  app.post(
    "/v1/ops/geofences/:draftId/submit",
    { schema: { params: UUID_PARAMS(["draftId"]) }, preHandler: requireVenueOps },
    async (req, reply) => {
      const { draftId } = req.params as { draftId: string };
      // Only the author submits their own draft for review.
      const r = await withVenueOps(ctx.pg, (c) =>
        c.query(
          `UPDATE geofence_drafts
              SET status = 'in_review'
            WHERE draft_id = $1 AND status = 'draft' AND author = $2
            RETURNING draft_id`,
          [draftId, req.userId],
        ),
      );
      if (r.rows.length === 0) return reply.code(409).send({ error: "draft cannot be submitted" });
      return reply.send({ draftId, status: "in_review" });
    },
  );

  app.post(
    "/v1/ops/geofences/:draftId/approve",
    { schema: { params: UUID_PARAMS(["draftId"]) }, preHandler: requireVenueOps },
    async (req, reply) => {
      const { draftId } = req.params as { draftId: string };
      // TR-41 four-eyes: the reviewer is recorded and must not be the
      // author — the same discipline as taxonomy release approval.
      const r = await withVenueOps(ctx.pg, (c) =>
        c.query(
          `UPDATE geofence_drafts
              SET status = 'approved', reviewer = $2, reviewed_at = now()
            WHERE draft_id = $1 AND status = 'in_review' AND author <> $2
            RETURNING draft_id`,
          [draftId, req.userId],
        ),
      );
      if (r.rows.length === 0) {
        return reply.code(409).send({ error: "draft cannot be approved by this reviewer" });
      }
      return reply.send({ draftId, status: "approved", reviewer: req.userId });
    },
  );

  app.post(
    "/v1/ops/geofences/:draftId/reject",
    {
      schema: {
        params: UUID_PARAMS(["draftId"]),
        body: {
          type: "object",
          required: ["message"],
          additionalProperties: false,
          properties: { message: { type: "string", minLength: 1, maxLength: 500 } },
        },
      },
      preHandler: requireVenueOps,
    },
    async (req, reply) => {
      const { draftId } = req.params as { draftId: string };
      const { message } = req.body as { message: string };
      const r = await withVenueOps(ctx.pg, (c) =>
        c.query(
          `UPDATE geofence_drafts
              SET status = 'rejected', reviewer = $2, reviewed_at = now(), message = $3
            WHERE draft_id = $1 AND status = 'in_review' AND author <> $2
            RETURNING draft_id`,
          [draftId, req.userId, message],
        ),
      );
      if (r.rows.length === 0) {
        return reply.code(409).send({ error: "draft cannot be rejected by this reviewer" });
      }
      return reply.send({ draftId, status: "rejected" });
    },
  );

  app.post(
    "/v1/ops/geofences/:draftId/publish",
    { schema: { params: UUID_PARAMS(["draftId"]) }, preHandler: requireVenueOps },
    async (req, reply) => {
      const { draftId } = req.params as { draftId: string };
      try {
        await withVenueOps(ctx.pg, (c) =>
          c.query("SELECT publish_geofence_draft($1, $2)", [draftId, req.userId]),
        );
      } catch (e) {
        // The DB is the final authority on the state machine, the second
        // person and the density gate; its messages are operator-facing.
        const msg = e instanceof Error ? e.message : "publish failed";
        return reply.code(409).send({ error: msg });
      }
      return reply.send({ draftId, status: "published" });
    },
  );
}
