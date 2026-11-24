/** Edge app assembly: auth, rate limiting, routes. */

import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { authenticate, registerAuth, withModerator } from "./auth.js";
import { EdgeContext } from "./context.js";
import { registerErrorContract } from "./errors.js";
import { registerIdempotency } from "./idempotency.js";
import { scrubLogArgs } from "./logscrub.js";
import { httpDuration, httpRequests, metrics, moderationQueueAge, publishFailures } from "./metrics.js";
import { resolveRequestId } from "./requestid.js";
import { registerCheckinRoutes } from "./routes/checkin.js";
import { registerConsentRoutes } from "./routes/consent.js";
import { registerElevationRoutes } from "./routes/elevation.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerRecoveryRoutes } from "./routes/recovery.js";
import { registerGeofenceRoutes } from "./routes/geofence.js";
import { registerAnnouncementRoutes } from "./routes/announcements.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerInterestRoutes } from "./routes/interests.js";
import { registerIntentRoutes } from "./routes/intents.js";
import { registerLifecycleRoutes } from "./routes/lifecycle.js";
import { registerLinkingRoutes } from "./routes/linking.js";
import { registerLinkRoutes } from "./routes/links.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerModerationRoutes } from "./routes/moderation.js";
import { registerPresenceRoutes } from "./routes/presence.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerRoomRoutes } from "./routes/rooms.js";
import { registerScanRoutes } from "./routes/scan.js";
import { registerTableRoutes } from "./routes/tables.js";
import { registerTaxonomyRoutes } from "./routes/taxonomy.js";
import { registerTelemetryRoutes } from "./routes/telemetry.js";
import { registerVenueRoutes } from "./routes/venue.js";

export async function buildApp(ctx: EdgeContext) {
  // TR-23: ajv strict mode, no silent coercion-stripping — unknown fields in
  // any schema'd body/query/params fail validation with a 400.
  const app = Fastify({
    // SEC-29: every log line is scrubbed — no coordinates, no cell+user
    // pairings, no user content, no bearer material.
    logger: {
      hooks: {
        logMethod(args, method) {
          return method.apply(this, scrubLogArgs(args));
        },
      },
    },
    ajv: { customOptions: { strict: true, removeAdditional: false, allErrors: true } },
    // NFR-31: the gateway (APISIX request-id) assigns X-Request-Id; honor it
    // so edge log lines join the gateway's trace, else mint one.
    genReqId: (req) => resolveRequestId(req.headers["x-request-id"]),
  });

  // NFR-31: the trace id rides back to the caller on every response.
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  // NFR-33: every request feeds the latency histogram and status counter the
  // SLO-burn and error-spike alerts read. Labels are the route template and
  // method only — no user data, ever.
  app.addHook("onResponse", async (req, reply) => {
    const labels = {
      route: req.routeOptions?.url ?? "unmatched",
      method: req.method,
    };
    httpDuration().observe(reply.elapsedTime / 1000, labels);
    httpRequests().inc({ ...labels, status: String(reply.statusCode) });
    // NFR-33: a failed presence publish is a P0 page (PresencePublishFailure)
    // — the discovery surface is down for the affected user (FR-12).
    if (
      labels.route === "/v1/presence" &&
      labels.method === "POST" &&
      reply.statusCode >= 500
    ) {
      publishFailures().inc();
    }
  });

  // TR-25: every error payload carries a stable code and a retry hint; the
  // error handler masks validation detail and internals.
  registerErrorContract(app);

  // TECH-07: Keycloak consumer-realm RS256 via JWKS when KEYCLOAK_ISSUER is
  // set; HS256 dev secret otherwise (ADR-0003).
  await registerAuth(app);
  await app.register(fastifyRateLimit, { global: false });

  // SEC-30: lets the workforce-role gate (auth.ts) reach the audit store
  // without threading the context through every preHandler signature.
  app.decorate("edgeCtx", ctx);

  app.get("/healthz", async () => ({ ok: true }));

  // NFR-33: Prometheus scrape endpoint — outside the authed scope and not
  // under /v1 (it is operational, not API; it stays out of openapi.yaml).
  // Aggregates only. The moderation-queue gauge is refreshed on scrape under
  // the moderator GUC (aggregate age, never row data).
  app.get("/metrics", async (_req, reply) => {
    try {
      const age = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `SELECT EXTRACT(EPOCH FROM now() - min(created_at)) AS age
             FROM reports WHERE status = 'open'`,
        );
        return r.rows[0].age === null ? 0 : Number(r.rows[0].age);
      });
      moderationQueueAge().set(age);
    } catch (err) {
      // A failed refresh must never break the scrape — the last value stands.
      app.log.warn({ err }, "moderation queue-age refresh failed");
    }
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(metrics.render());
  });

  // Everything below requires a verified bearer token (the JWT hook sets
  // request.userId, which withRls() turns into the RLS context).
  await app.register(async (authed) => {
    authed.addHook("onRequest", authenticate);
    // TR-24: Idempotency-Key dedupe on every mutating endpoint in the scope.
    registerIdempotency(authed, ctx);
    registerPresenceRoutes(authed, ctx);
    registerScanRoutes(authed, ctx);
    registerConsentRoutes(authed, ctx);
    registerLifecycleRoutes(authed, ctx);
    registerAccountRoutes(authed, ctx);
    registerRecoveryRoutes(authed, ctx);
    registerContentRoutes(authed, ctx);
    registerAnnouncementRoutes(authed, ctx);
    registerVenueRoutes(authed, ctx);
    registerCheckinRoutes(authed, ctx);
    registerMessageRoutes(authed, ctx);
    registerProfileRoutes(authed, ctx);
    registerInterestRoutes(authed, ctx);
    registerTableRoutes(authed, ctx);
    registerLinkRoutes(authed, ctx);
    registerModerationRoutes(authed, ctx);
    registerElevationRoutes(authed, ctx);
    registerRoomRoutes(authed, ctx);
    registerIntentRoutes(authed, ctx);
    registerDeviceRoutes(authed, ctx);
    registerLinkingRoutes(authed, ctx);
    registerTaxonomyRoutes(authed, ctx);
    registerTelemetryRoutes(authed, ctx);
    registerGeofenceRoutes(authed, ctx);
  });

  return app;
}
