/** Service entrypoint body — loaded by index.ts only after tracing is up. */

import Postgres from "pg";
import { Redis as Valkey } from "ioredis";
import { buildServer } from "./server.js";
import { Store } from "./store.js";

const PORT = Number(process.env.PORT ?? 4100);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://presence_match:presence-dev@localhost:5432/presence";
const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";

export async function main() {
  const pg = new Postgres.Pool({ connectionString: DATABASE_URL });
  const valkey = new Valkey(VALKEY_URL);
  const store = new Store(pg, valkey);
  await store.start();

  const app = buildServer(store);
  await app.listen({ port: PORT, host: "0.0.0.0" });

  const shutdown = async () => {
    await app.close();
    await store.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
