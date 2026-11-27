/** Edge app assembly: auth, rate limiting, routes. */

import fastifyCompress from "@fastify/compress";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { authenticate, registerAuth, withModerator } from "./auth.js";
import { registerClientConfigRoute } from "./clientConfig.js";
import { EdgeContext } from "./context.js";
import { registerErrorContract } from "./errors.js";
import { registerIdempotency } from "./idempotency.js";
import { scrubLogArgs } from "./logscrub.js";
import { registerRealtimeTokenRoute } from "./realtimeToken.js";
import { escrowDisputeAge, httpDuration, httpRequests, metrics, moderationQueueAge, publishFailures } from "./metrics.js";
import { resolveRequestId } from "./requestid.js";
import { registerVersionContract } from "./versioning.js";
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
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerKycVerificationRoutes, registerKycWebhookRoute } from "./routes/kycVerification.js";
import { registerTransferRoutes } from "./routes/transfers.js";
import { registerWalletRoutes } from "./routes/wallets.js";
import { registerWalletGovernanceRoutes } from "./routes/walletGovernance.js";
import { registerInnovationRoutes, registerAttestationVerifyRoute } from "./routes/innovations.js";
import { registerDatingRoutes } from "./routes/dating.js";
import { registerMarketplaceRoutes } from "./routes/marketplace.js";
import { registerBarterRoutes } from "./routes/barter.js";
import { registerServiceRoutes } from "./routes/services.js";
import { registerWalletRailRoutes } from "./routes/walletRail.js";
import { registerRoomRoutes } from "./routes/rooms.js";
import { registerScanRoutes } from "./routes/scan.js";
import { registerTableRoutes } from "./routes/tables.js";
import { registerTaxonomyRoutes } from "./routes/taxonomy.js";
import { registerTelemetryRoutes } from "./routes/telemetry.js";
import { registerVenueRoutes } from "./routes/venue.js";
import { registerVerticalRoutes } from "./routes/verticals.js";
import { verticalGate } from "./verticals.js";

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

  // TR-27: the server publishes its version posture — x-api-version on
  // every response, and a 426 for builds below CLIENT_MIN_VERSION that
  // identify themselves (healthz/metrics/client-config are exempt: the
  // bootstrap config is the detection channel itself).
  registerVersionContract(app);

  // TECH-07: Keycloak consumer-realm RS256 via JWKS when KEYCLOAK_ISSUER is
  // set; HS256 dev secret otherwise (ADR-0003).
  await registerAuth(app);
  await app.register(fastifyRateLimit, { global: false });

  // AMD-NET-04: brotli/gzip for responses above 1 KiB. The member this
  // platform is for is on a contested 2G/3G last mile — every byte over
  // the wire is a budgeted cost (AMD-NET-05). Compression is global:
  // responses smaller than the threshold pass through untouched.
  await app.register(fastifyCompress, {
    global: true,
    threshold: 1024,
    encodings: ["br", "gzip"],
  });

  // SEC-30: lets the workforce-role gate (auth.ts) reach the audit store
  // without threading the context through every preHandler signature.
  app.decorate("edgeCtx", ctx);

  app.get("/healthz", async () => ({ ok: true }));

  // TR-33: client security config (unauthenticated bootstrap — the client
  // reads its TLS pinning policy before login; the payload is operational,
  // never user data). Registered outside the authed scope on purpose.
  registerClientConfigRoute(app);

  // AMD-PAY-16/17: wallet rail provider webhooks — outside the authed
  // scope on purpose: the caller is the payment provider, authenticated by
  // HMAC signature over the canonical payload, never a user token.
  registerWalletRailRoutes(app, ctx);

  // AMD-KYC-09: OpenKYC verdict webhook — outside the authed scope on
  // purpose: the caller is the verification pipeline, authenticated by
  // HMAC signature over the canonical payload, never a user token.
  registerKycWebhookRoute(app, ctx);

  // AMD-INN-09: attestation verification oracle — outside the authed scope on
  // purpose: the caller is a third-party verifier with no account; the
  // token itself is the credential. Answers valid | expired | invalid.
  registerAttestationVerifyRoute(app, ctx);

  // NFR-33: Prometheus scrape endpoint — outside the authed scope and not
  // under /v1 (it is operational, not API; it stays out of openapi.yaml).
  // Aggregates only. The moderation-queue and escrow-dispute gauges are
  // refreshed on scrape under the moderator GUC (aggregate age, never row
  // data).
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
    try {
      // AMD-ESC-02: dispute liveness — disputed_at IS NULL rows contribute
      // nothing (min ignores NULL); an empty queue reports 0.
      const disputeAge = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `SELECT EXTRACT(EPOCH FROM now() - min(disputed_at)) AS age
             FROM escrow_agreements WHERE state = 'disputed'`,
        );
        return r.rows[0].age === null ? 0 : Number(r.rows[0].age);
      });
      escrowDisputeAge().set(disputeAge);
    } catch (err) {
      app.log.warn({ err }, "escrow dispute-age refresh failed");
    }
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(metrics.render());
  });

  // Everything below requires a verified bearer token (the JWT hook sets
  // request.userId, which withRls() turns into the RLS context).
  await app.register(async (authed) => {
    authed.addHook("onRequest", authenticate);
    // AMD-VERT-02/03: vertical flags — after authenticate (req.userId is
    // set), before idempotency and every route. Unmapped templates pass;
    // /v1/moderation/* is never gated.
    authed.addHook("preHandler", verticalGate(ctx));
    // TR-24: Idempotency-Key dedupe on every mutating endpoint in the scope.
    registerIdempotency(authed, ctx);
    registerPresenceRoutes(authed, ctx);
    registerScanRoutes(authed, ctx);
    registerConsentRoutes(authed, ctx);
    registerLifecycleRoutes(authed, ctx);
    registerAccountRoutes(authed, ctx);
    registerVerticalRoutes(authed, ctx);
    registerRecoveryRoutes(authed, ctx);
    registerContentRoutes(authed, ctx);
    registerAnnouncementRoutes(authed, ctx);
    registerVenueRoutes(authed, ctx);
    registerCheckinRoutes(authed, ctx);
    registerMessageRoutes(authed, ctx);
    registerProfileRoutes(authed, ctx);
    registerIdentityRoutes(authed, ctx);
    registerTransferRoutes(authed, ctx);
    registerWalletRoutes(authed, ctx);
    // AMD-PAY-21/23: rail governance queues — inside the authed scope,
    // after the wallet routes.
    registerWalletGovernanceRoutes(authed, ctx);
    // AMD-INN-01..10: innovation routes — after the wallet governance
    // routes; value-moving wires run inside withSettlement.
    registerInnovationRoutes(authed, ctx);
    // AMD-DATE-01..05: dating mode — no value moves, withRls throughout.
    registerDatingRoutes(authed, ctx);
    // AMD-MKT-01..05: marketplace — purchases compose through the b56
    // escrow definers inside withSettlement.
    registerMarketplaceRoutes(authed, ctx);
    registerBarterRoutes(authed, ctx);
    // AMD-SVC-01..05: services — bookings compose the b56 milestone escrow
    // inside withSettlement; start/dispute move no value (withRls).
    registerServiceRoutes(authed, ctx);
    // AMD-ONB-01..06: stakeholder onboarding — applicant surface on plain
    // RLS, the decision surface under withModerator; no value moves.
    registerOnboardingRoutes(authed, ctx);
    // AMD-KYC-06..10: OpenKYC verification — session issue/status on
    // plain RLS, the review worklist under withModerator; the verdict
    // itself arrives on the unauthed HMAC webhook above.
    registerKycVerificationRoutes(authed, ctx);
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
    // AMD-CRT-04: Centrifugo connection tokens — authed, rate-limited,
    // fail closed when the HMAC secret is unconfigured.
    registerRealtimeTokenRoute(authed, ctx);
  });

  return app;
}
