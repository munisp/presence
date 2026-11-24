/**
 * Match service entrypoint. TECH-12: tracing starts FIRST — the module
 * graph loads via dynamic import only after the OTel SDK is up.
 */

import { startTracing } from "./tracing.js";

const sdk = startTracing("presence-match");

const { main } = await import("./main.js");

process.on("SIGTERM", () => void sdk?.shutdown());
process.on("SIGINT", () => void sdk?.shutdown());

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
