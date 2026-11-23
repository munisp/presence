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
  tokenPayload?: Record<string, unknown>;
}

interface CompleteToken {
  header: { kid?: string };
  payload: { sub?: string; iss?: string };
}

/**
 * Register JWT verification. Keycloak RS256+JWKS when KEYCLOAK_ISSUER is set,
 * HS256 dev secret otherwise. The `consumer` realm issues 5-minute access
 * tokens (SEC-02); revocation within 60 s is a Keycloak session operation.
 *
 * The `workforce` realm (FR-54 moderation console) is a second accepted
 * issuer with its own JWKS — moderator tokens never mix with consumer ones,
 * and requireModerator below still checks the realm and role claim.
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  const issuer = process.env.KEYCLOAK_ISSUER;
  const workforceIssuer =
    process.env.KEYCLOAK_WORKFORCE_ISSUER ??
    (issuer ? issuer.replace(/\/realms\/[^/]+\/?$/, "/realms/workforce") : undefined);
  if (issuer) {
    const clients = new Map<string, jwksRsa.JwksClient>();
    for (const iss of [issuer, workforceIssuer]) {
      if (iss && !clients.has(iss)) {
        clients.set(iss, jwksRsa({
          jwksUri: `${iss}/protocol/openid-connect/certs`,
          cache: true,
          rateLimit: true,
        }));
      }
    }
    await app.register(fastifyJwt, {
      decode: { complete: true },
      verify: { allowedIss: [...clients.keys()], algorithms: ["RS256"] },
      secret: (_req: unknown, token: unknown, cb: (e: Error | null, key?: string) => void) => {
        const t = token as CompleteToken;
        const kid = t.header.kid;
        if (!kid) return cb(new Error("token header has no kid"));
        const client = clients.get(t.payload.iss ?? "") ?? clients.get(issuer);
        if (!client) return cb(new Error("unrecognised issuer"));
        client.getSigningKey(kid, (err, key) => cb(err ?? null, key?.getPublicKey()));
      },
    });
  } else {
    await app.register(fastifyJwt, {
      secret: process.env.JWT_SECRET ?? "p0-dev-secret-change-me",
    });
  }
}

/** Verify the bearer token and stash the subject and claims on the request. */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const payload = await req.jwtVerify<Record<string, unknown> & { sub: string }>();
    (req as AuthedRequest).userId = payload.sub;
    (req as AuthedRequest).tokenPayload = payload;
  } catch {
    await reply.code(401).send({ error: "invalid or missing token" });
  }
}

/**
 * FR-54: the moderation console requires a workforce-realm token carrying
 * the `moderator` realm role. Consumer tokens — even valid ones — stop here.
 */
export async function requireModerator(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireWorkforceRole(req, reply, "moderator");
}

/** FR-59: taxonomy console gate — workforce realm + the taxonomist role. */
export async function requireTaxonomist(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireWorkforceRole(req, reply, "taxonomist");
}

/** NFR-32/TR-34: telemetry console gate — workforce realm + analyst role. */
export async function requireAnalyst(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireWorkforceRole(req, reply, "analyst");
}

/** TR-41: geofence authoring gate — workforce realm + the venue-ops role. */
export async function requireVenueOps(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireWorkforceRole(req, reply, "venue-ops");
}

async function requireWorkforceRole(req: FastifyRequest, reply: FastifyReply, role: string): Promise<void> {
  const payload = ((req as AuthedRequest).tokenPayload ?? {}) as {
    iss?: string;
    realm_access?: { roles?: unknown };
  };
  const roles = Array.isArray(payload.realm_access?.roles)
    ? (payload.realm_access.roles as string[])
    : [];
  // In the RS256 path the issuer must be the workforce realm; in the offline
  // HS256 dev path (no KEYCLOAK_ISSUER) the role claim alone gates.
  const workforceRealm =
    payload.iss !== undefined
      ? payload.iss.includes("/realms/workforce")
      : !process.env.KEYCLOAK_ISSUER;
  if (!workforceRealm || !roles.includes(role)) {
    await reply.code(403).send({ error: `${role} role required` });
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

/**
 * FR-54: run `fn` inside a transaction with `app.moderator` set. Moderation
 * console routes use this instead of withRls — the moderator GUC unlocks the
 * RESTRICTIVE-aware moderation policies (reports outcome updates, suspensions,
 * appeals) without ever opening consumer rows to a second principal. The GUC
 * is set server-side only, on routes already gated by requireModerator.
 */
export async function withModerator<T>(
  pool: Postgres.Pool,
  fn: (client: Postgres.PoolClient) => Promise<T>,
): Promise<T> {
  return withGuc(pool, "app.moderator", fn);
}

/**
 * FR-59: run `fn` inside a transaction with `app.taxonomist` set. The GUC
 * unlocks the release tables and the taxonomy write-guard triggers; it is
 * set server-side only, on routes already gated by requireTaxonomist.
 */
export async function withTaxonomist<T>(
  pool: Postgres.Pool,
  fn: (client: Postgres.PoolClient) => Promise<T>,
): Promise<T> {
  return withGuc(pool, "app.taxonomist", fn);
}

/** NFR-32/TR-34: telemetry reads under the app.analyst GUC. */
export async function withAnalyst<T>(
  pool: Postgres.Pool,
  fn: (client: Postgres.PoolClient) => Promise<T>,
): Promise<T> {
  return withGuc(pool, "app.analyst", fn);
}

/** TR-41: run fn in one transaction with the venue-ops GUC set. */
export async function withVenueOps<T>(
  pool: Postgres.Pool,
  fn: (client: Postgres.PoolClient) => Promise<T>,
): Promise<T> {
  return withGuc(pool, "app.venue_ops", fn);
}

async function withGuc<T>(
  pool: Postgres.Pool,
  guc: string,
  fn: (client: Postgres.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('${guc}', 'on', true)`);
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
