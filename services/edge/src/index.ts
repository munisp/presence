/**
 * Edge entrypoint. TECH-12: tracing starts FIRST — the rest of the module
 * graph is loaded via dynamic import only after the OTel SDK is up, so the
 * auto-instrumentations patch http/fastify/pg/ioredis before they load.
 */

import { startTracing } from "./tracing.js";

const sdk = startTracing("presence-edge");

const { main } = await import("./main.js");

process.on("SIGTERM", () => void sdk?.shutdown());
process.on("SIGINT", () => void sdk?.shutdown());

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
