/**
 * Next-gen maps routes (SRS Addendum 001 — AMD-MAP-02/05; TR-44).
 *
 * Member surface (INSIDE the authed scope):
 *   GET /v1/maps/manifest          — the serving tile bundle's manifest
 *     ({available:false} when none is published — never an error).
 *   GET /v1/maps/venues?cell=&limit= — partner venues near the member's
 *     own r9 presence cell. Two honest modes: the RN client passes the
 *     cell it computed on-device (TR-29 — the cell it already publishes);
 *     the zero-dependency PWA has no h3, so it passes NO cell and the
 *     edge resolves the member's live presence from Valkey — the lite
 *     client's cell never crosses the wire at all. No live presence
 *     answers {venues:[], presence:"absent"}, a first-class state.
 *
 * Console surface (venue-ops, the AMD-MAP-02 registry):
 *   GET  /v1/ops/maps/bundles            — every bundle, newest first.
 *   POST /v1/ops/maps/bundles            — register a rendered bundle draft.
 *   POST /v1/ops/maps/bundles/:id/publish — version-monotonic publication;
 *                                            the definer supersedes the
 *                                            serving bundle atomically.
 *
 * Tiles themselves are NEVER proxied here — nginx serves them statically
 * (AMD-MAP-06). The edge governs discovery and the read model only.
 */

import { FastifyInstance } from "fastify";
import { isValidCell } from "h3-js";
import { EdgeContext } from "../context.js";
import { requireVenueOps, withRls, withVenueOps } from "../auth.js";
import { mapQueries } from "../metrics.js";
import {
  bboxToPolygonGeoJSON,
  normalizeManifest,
  normalizeVenues,
  parseBundleRegistration,
  parseMapCell,
  parseMapLimit,
} from "../maps.js";

const MEMBER_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;

export function registerMapRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get(
    "/v1/maps/manifest",
    { config: { rateLimit: MEMBER_RATE_LIMIT } },
    async (req, reply) => {
      const row = await withRls(ctx.pg, req.userId, async (client) => {
        const out = await client.query(
          "SELECT active_tile_manifest() AS manifest");
        return out.rows[0]?.manifest ?? null;
      });
      const manifest = normalizeManifest(row);
      mapQueries().inc({ route: "manifest", result: manifest.available ? "ok" : "empty" });
      // The manifest is bundle-versioned, so a fresh copy is cheap to
      // revalidate and a stale one is never wrong-by-undetectable: the
      // version inside is the cache key the client pins on (AMD-MAP-03).
      return reply
        .header("Cache-Control", "no-cache, must-revalidate")
        .send(manifest);
    },
  );

  app.get(
    "/v1/maps/venues",
    { config: { rateLimit: MEMBER_RATE_LIMIT } },
    async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const limit = parseMapLimit(q.limit);
      let cell: string | null;
      let presence: "presented" | "live" | "absent";
      if (q.cell === undefined || q.cell === null || q.cell === "") {
        // AMD-MAP-05 PWA mode: resolve the member's own live presence.
        const raw = await ctx.valkey.get(`presence:user:${req.userId}`);
        if (raw === null) {
          mapQueries().inc({ route: "venues", result: "absent" });
          return reply
            .header("Cache-Control", "private, no-store")
            .send({ cell: null, presence: "absent", venues: [] });
        }
        try {
          const entry = JSON.parse(raw) as { cell?: unknown };
          cell = typeof entry.cell === "string" ? entry.cell : null;
        } catch {
          cell = null;
        }
        // The live entry may be at the market's busy resolution (TR-12),
        // not necessarily r9 — validate it as a cell, not as an r9 cell;
        // the definer's grid disk works at whatever resolution arrives.
        if (cell === null || !/^[0-9a-f]{15}$/.test(cell) || !isValidCell(cell)) {
          mapQueries().inc({ route: "venues", result: "absent" });
          return reply
            .header("Cache-Control", "private, no-store")
            .send({ cell: null, presence: "absent", venues: [] });
        }
        presence = "live";
      } else {
        cell = parseMapCell(q.cell);
        presence = "presented";
        if (cell === null) {
          mapQueries().inc({ route: "venues", result: "rejected" });
          return reply.code(422).send({
            error:
              "cell must be a resolution-9 h3 index; limit must be 1..40 (AMD-MAP-05)",
          });
        }
      }
      if (limit < 0) {
        mapQueries().inc({ route: "venues", result: "rejected" });
        return reply.code(422).send({
          error:
            "cell must be a resolution-9 h3 index; limit must be 1..40 (AMD-MAP-05)",
        });
      }
      const payload = await withRls(ctx.pg, req.userId, async (client) => {
        const out = await client.query(
          "SELECT venues_near_cell($1::h3index, $2) AS venues",
          [cell, limit]);
        return out.rows[0]?.venues ?? [];
      });
      const venues = normalizeVenues(payload);
      mapQueries().inc({ route: "venues", result: "ok" });
      return reply
        .header("Cache-Control", "private, no-store")
        .send({ cell, presence, venues });
    },
  );
}

export function registerMapOpsRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get(
    "/v1/ops/maps/bundles",
    { preHandler: requireVenueOps },
    async (_req, reply) => {
      const bundles = await withVenueOps(ctx.pg, async (client) => {
        const out = await client.query("SELECT list_tile_bundles() AS bundles");
        return out.rows[0]?.bundles ?? [];
      });
      mapQueries().inc({ route: "ops_list", result: "ok" });
      return reply.send({ bundles });
    },
  );

  app.post(
    "/v1/ops/maps/bundles",
    {
      preHandler: requireVenueOps,
      schema: {
        body: {
          type: "object",
          required: [
            "version", "label", "bbox", "minZoom", "maxZoom",
            "tileCount", "tilesSha256", "attribution",
          ],
          additionalProperties: false,
          properties: {
            version: { type: "string" },
            label: { type: "string" },
            bbox: {
              type: "object",
              required: ["west", "south", "east", "north"],
              additionalProperties: false,
              properties: {
                west: { type: "number" },
                south: { type: "number" },
                east: { type: "number" },
                north: { type: "number" },
              },
            },
            minZoom: { type: "integer" },
            maxZoom: { type: "integer" },
            tileCount: { type: "integer" },
            tilesSha256: { type: "string" },
            attribution: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const reg = parseBundleRegistration(req.body);
      if (reg === null) {
        mapQueries().inc({ route: "ops_register", result: "rejected" });
        return reply.code(422).send({
          error: "malformed bundle registration (AMD-MAP-02)",
        });
      }
      try {
        const bundleId = await withVenueOps(ctx.pg, async (client) => {
          const out = await client.query(
            "SELECT register_tile_bundle($1, $2, ST_GeomFromGeoJSON($3)," +
              " $4, $5, $6, $7, $8) AS id",
            [
              reg.version, reg.label, bboxToPolygonGeoJSON(reg.bbox),
              reg.minZoom, reg.maxZoom, reg.tileCount, reg.tilesSha256,
              reg.attribution,
            ]);
          return out.rows[0]?.id as string;
        });
        mapQueries().inc({ route: "ops_register", result: "ok" });
        return reply.code(201).send({ bundleId, state: "draft" });
      } catch (err) {
        // Unique version or a definer refusal — surface as a conflict.
        mapQueries().inc({ route: "ops_register", result: "conflict" });
        return reply.code(409).send({
          error: `bundle registration refused: ${(err as Error).message}`,
        });
      }
    },
  );

  app.post(
    "/v1/ops/maps/bundles/:bundleId/publish",
    {
      preHandler: requireVenueOps,
      schema: {
        params: {
          type: "object",
          required: ["bundleId"],
          properties: { bundleId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (req, reply) => {
      const { bundleId } = req.params as { bundleId: string };
      const result = await withVenueOps(ctx.pg, async (client) => {
        const out = await client.query(
          "SELECT publish_tile_bundle($1) AS result", [bundleId]);
        return out.rows[0]?.result as string;
      });
      if (result === "published") {
        mapQueries().inc({ route: "ops_publish", result: "ok" });
        return reply.send({ bundleId, state: "published" });
      }
      const status = result === "unknown" ? 404 : 409;
      mapQueries().inc({ route: "ops_publish", result });
      return reply.code(status).send({
        error:
          result === "unknown"
            ? "unknown bundle"
            : result === "not_draft"
              ? "only a draft bundle can be published"
              : "publication is version-monotonic — this version is not newer than the serving bundle",
      });
    },
  );
}
