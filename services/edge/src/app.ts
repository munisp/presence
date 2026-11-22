/** Edge app assembly: auth, rate limiting, routes. */

import fastifyJwt from "@fastify/jwt";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { authenticate } from "./auth.js";
import { EdgeContext } from "./context.js";
import { registerConsentRoutes } from "./routes/consent.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerPresenceRoutes } from "./routes/presence.js";
import { registerScanRoutes } from "./routes/scan.js";

export async function buildApp(ctx: EdgeContext) {
  const app = Fastify({ logger: true });

  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? "p0-dev-secret-change-me",
  });
  await app.register(fastifyRateLimit, { global: false });

  app.get("/healthz", async () => ({ ok: true }));

  // Everything below requires a verified bearer token (the JWT hook sets
  // request.userId, which withRls() turns into the RLS context).
  await app.register(async (authed) => {
    authed.addHook("onRequest", authenticate);
    registerPresenceRoutes(authed, ctx);
    registerScanRoutes(authed, ctx);
    registerConsentRoutes(authed, ctx);
    registerContentRoutes(authed, ctx);
    registerMessageRoutes(authed, ctx);
  });

  return app;
}
