/**
 * Auth and database plumbing for the edge.
 *
 * AuthN (TECH-07, ARC-002 §8.2): the Keycloak `consumer` realm is the identity
 * provider in P0. When KEYCLOAK_ISSUER is set, bearer tokens are verified as
 * RS256 against the realm JWKS with the issuer pinned. When it is unset (unit
 * tests, offline runs) the edge falls back to a shared HS256 dev secret so the
 * stack stays self-contained (ADR-0003).
 *
 * App Attest / Play Integrity assertions are required on presence writes; P0
 * verifies presence of the assertion header and defers cryptographic
 * verification to the attestation milestone (FR-51/SEC-19).
 *
 * AuthZ: every request runs its Postgres work inside a transaction with
 * `SET LOCAL app.user_id` — the row-level security policies from
 * db/migrations/0001_init.sql are the FR-30 enforcement point.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import jwksRsa from "jwks-rsa";
import Postgres from "pg";

export interface AuthedRequest extends FastifyRequest {
  userId: string;
}

interface CompleteToken {
  header: { kid?: string };
  payload: { sub?: string };
}

/**
 * Register JWT verification. Keycloak RS256+JWKS when KEYCLOAK_ISSUER is set,
 * HS256 dev secret otherwise. The `consumer` realm issues 5-minute access
 * tokens (SEC-02); revocation within 60 s is a Keycloak session operation.
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  const issuer = process.env.KEYCLOAK_ISSUER;
  if (issuer) {
    const jwks = jwksRsa({
      jwksUri: `${issuer}/protocol/openid-connect/certs`,
      cache: true,
      rateLimit: true,
    });
    await app.register(fastifyJwt, {
      decode: { complete: true },
      verify: { allowedIss: [issuer], algorithms: ["RS256"] },
      secret: (_req: unknown, token: unknown, cb: (e: Error | null, key?: string) => void) => {
        const kid = (token as CompleteToken).header.kid;
        if (!kid) return cb(new Error("token header has no kid"));
        jwks.getSigningKey(kid, (err, key) => cb(err ?? null, key?.getPublicKey()));
      },
    });
  } else {
    await app.register(fastifyJwt, {
      secret: process.env.JWT_SECRET ?? "p0-dev-secret-change-me",
    });
  }
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
