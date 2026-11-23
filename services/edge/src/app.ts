/** Edge app assembly: auth, rate limiting, routes. */

import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { authenticate, registerAuth } from "./auth.js";
import { EdgeContext } from "./context.js";
import { registerIdempotency } from "./idempotency.js";
import { scrubLogArgs } from "./logscrub.js";
import { registerCheckinRoutes } from "./routes/checkin.js";
import { registerConsentRoutes } from "./routes/consent.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerAnnouncementRoutes } from "./routes/announcements.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerInterestRoutes } from "./routes/interests.js";
import { registerIntentRoutes } from "./routes/intents.js";
import { registerLifecycleRoutes } from "./routes/lifecycle.js";
import { registerLinkRoutes } from "./routes/links.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerModerationRoutes } from "./routes/moderation.js";
import { registerPresenceRoutes } from "./routes/presence.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerRoomRoutes } from "./routes/rooms.js";
import { registerScanRoutes } from "./routes/scan.js";
import { registerTableRoutes } from "./routes/tables.js";
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
  });

  // TECH-07: Keycloak consumer-realm RS256 via JWKS when KEYCLOAK_ISSUER is
  // set; HS256 dev secret otherwise (ADR-0003).
  await registerAuth(app);
  await app.register(fastifyRateLimit, { global: false });

  app.get("/healthz", async () => ({ ok: true }));

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
    registerRoomRoutes(authed, ctx);
    registerIntentRoutes(authed, ctx);
  });

  return app;
}
