/**
 * Auth and database plumbing for the edge.
 *
 * AuthN: RS256/HS256 JWT (Keycloak realm `consumer` in P1; a shared HS256
 * secret keeps P0 self-contained). App Attest / Play Integrity assertions are
 * required on presence writes; P0 verifies presence of the assertion header
 * and defers cryptographic verification to the attestation milestone.
 *
 * AuthZ: every request runs its Postgres work inside a transaction with
 * `SET LOCAL app.user_id` — the row-level security policies from
 * db/migrations/0001_init.sql are the FR-30 enforcement point.
 */

import { FastifyReply, FastifyRequest } from "fastify";
import Postgres from "pg";

export interface AuthedRequest extends FastifyRequest {
  userId: string;
}

/** Verify the bearer token and stash the subject on the request. */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const payload = await req.jwtVerify<{ sub: string }>();
    (req as AuthedRequest).userId = payload.sub;
  } catch {
    await reply.code(401).send({ error: "invalid or missing token" });
  }
}

/**
 * TR-15: the server never accepts raw coordinates. Presence payloads carry a
 * client-computed H3 cell only; any coordinate-shaped field is a hard 422.
 */
const COORDINATE_KEYS = ["lat", "lng", "lon", "latitude", "longitude", "coords", "coordinates", "location"];

export function containsCoordinates(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  return Object.keys(body as Record<string, unknown>).some((k) =>
    COORDINATE_KEYS.includes(k.toLowerCase()),
  );
}

/**
 * Run `fn` on a pooled client inside a transaction with the RLS GUC set.
 * Everything the edge does to user-scoped tables goes through here.
 */
export async function withRls<T>(
  pool: Postgres.Pool,
  userId: string,
  fn: (client: Postgres.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
