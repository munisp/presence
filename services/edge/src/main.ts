/** Edge entrypoint body — loaded by index.ts only after tracing is up. */

import Postgres from "pg";
import { Redis as Valkey } from "ioredis";
import { buildApp } from "./app.js";
import { randomIds, systemClock } from "./clock.js";
import { startLifecycleJob } from "./lifecycle.js";

const PORT = Number(process.env.PORT ?? 4000);

export async function main() {
  const ctx = {
    pg: new Postgres.Pool({
      connectionString: process.env.DATABASE_URL ?? "postgres://presence_app:presence-dev@localhost:5432/presence",
    }),
    valkey: new Valkey(process.env.VALKEY_URL ?? "redis://localhost:6379"),
    matchServiceUrl: process.env.MATCH_SERVICE_URL ?? "http://localhost:4100",
    centrifugoUrl: process.env.CENTRIFUGO_URL ?? "http://localhost:8000",
    centrifugoApiKey: process.env.CENTRIFUGO_API_KEY ?? "p0-dev-api-key",
    // TECH-15: production context uses the wall clock and random ids; tests
    // inject fakes through buildApp's context instead.
    clock: systemClock,
    ids: randomIds,
  };

  const app = await buildApp(ctx);
  await app.listen({ port: PORT, host: "0.0.0.0" });

  // FR-33/37, NFR-20: offer expiry, conversation lapse, ciphertext purge.
  const stopLifecycle = startLifecycleJob(ctx.pg);

  const shutdown = async () => {
    stopLifecycle();
    await app.close();
    await ctx.pg.end();
    ctx.valkey.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
