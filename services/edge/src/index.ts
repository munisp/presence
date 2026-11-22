/** Edge entrypoint. */

import Postgres from "pg";
import { Redis as Valkey } from "ioredis";
import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  const ctx = {
    pg: new Postgres.Pool({
      connectionString: process.env.DATABASE_URL ?? "postgres://presence_app:presence-dev@localhost:5432/presence",
    }),
    valkey: new Valkey(process.env.VALKEY_URL ?? "redis://localhost:6379"),
    matchServiceUrl: process.env.MATCH_SERVICE_URL ?? "http://localhost:4100",
    centrifugoUrl: process.env.CENTRIFUGO_URL ?? "http://localhost:8000",
    centrifugoApiKey: process.env.CENTRIFUGO_API_KEY ?? "p0-dev-api-key",
  };

  const app = await buildApp(ctx);
  await app.listen({ port: PORT, host: "0.0.0.0" });

  const shutdown = async () => {
    await app.close();
    await ctx.pg.end();
    ctx.valkey.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
