/** Edge app assembly: auth, rate limiting, routes. */

import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { authenticate, registerAuth } from "./auth.js";
import { EdgeContext } from "./context.js";
import { registerConsentRoutes } from "./routes/consent.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerAnnouncementRoutes } from "./routes/announcements.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerLifecycleRoutes } from "./routes/lifecycle.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerPresenceRoutes } from "./routes/presence.js";
import { registerScanRoutes } from "./routes/scan.js";
import { registerVenueRoutes } from "./routes/venue.js";

export async function buildApp(ctx: EdgeContext) {
  // TR-23: ajv strict mode, no silent coercion-stripping — unknown fields in
  // any schema'd body/query/params fail validation with a 400.
  const app = Fastify({
    logger: true,
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
    registerPresenceRoutes(authed, ctx);
    registerScanRoutes(authed, ctx);
    registerConsentRoutes(authed, ctx);
    registerLifecycleRoutes(authed, ctx);
    registerAccountRoutes(authed, ctx);
    registerContentRoutes(authed, ctx);
    registerAnnouncementRoutes(authed, ctx);
    registerVenueRoutes(authed, ctx);
    registerMessageRoutes(authed, ctx);
  });

  return app;
}
