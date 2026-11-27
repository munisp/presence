/**
 * AMD-CRT-04: Centrifugo connection tokens.
 *
 *   POST /v1/realtime/token — issues the HS256 connection JWT the
 *   client's realtime adapter presents to Centrifugo.
 *
 * The token is the privacy boundary of the realtime tier:
 *
 *   - SCOPED — the `channels` claim allowlists exactly the member's own
 *     user channel plus the `pair:` channel of every pair they belong to
 *     that has not closed; Centrifugo refuses subscriptions outside the
 *     claim, so one member can never ride another's pair channel;
 *   - SHORT-LIVED — 600 seconds (CENTRIFUGO_TOKEN_TTL_S), refreshed by
 *     the client REALTIME_TOKEN_REFRESH_MARGIN_S before expiry, so a
 *     revoked session goes dark inside ten minutes;
 *   - FAIL CLOSED — without CENTRIFUGO_TOKEN_HMAC_SECRET_KEY the route
 *     answers 503 (the AMD-PAY-16 unconfigured-secret discipline): a
 *     realtime tier that cannot prove its tokens must not issue any;
 *   - SIGNED HERE — HS256 with node:crypto only; the edge's @fastify/jwt
 *     is bound to the Keycloak JWKS verification posture and is never
 *     reused for a second audience.
 */

import { createHmac } from "node:crypto";

import { FastifyInstance } from "fastify";

import { withRls } from "./auth.js";
import { EdgeContext } from "./context.js";

/** 600 s — the client refreshes 60 s before expiry (client realtime.ts). */
export const CENTRIFUGO_TOKEN_TTL_S = 600;

/** Token issue is cheap but not free — one connect plus one refresh/min. */
const REALTIME_TOKEN_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface CentrifugoTokenClaims {
  sub: string;
  iat: number;
  exp: number;
  /** Server-side subscription allowlist — the privacy boundary. */
  channels: string[];
}

/** Sign the claims as an HS256 JWT (Centrifugo token_hmac_secret_key). */
export function signCentrifugoToken(claims: CentrifugoTokenClaims, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64url(signature)}`;
}

/** The channels a member may subscribe to: their own + their open pairs'. */
export function memberChannels(userId: string, pairIds: readonly string[]): string[] {
  return [`user:${userId}`, ...pairIds.map((id) => `pair:${id}`)];
}

export function registerRealtimeTokenRoute(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/realtime/token",
    {
      config: { rateLimit: REALTIME_TOKEN_RATE_LIMIT },
      schema: {
        body: { type: "object", additionalProperties: false, properties: {} },
      },
    },
    async (req, reply) => {
      // AMD-PAY-16 discipline: without the HMAC secret no token can ever
      // be valid, so refuse BEFORE doing any work.
      const secret = process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
      if (!secret) {
        return reply.code(503).send({ error: "realtime not configured (AMD-CRT-04)" });
      }
      const pairIds = await withRls(ctx.pg, req.userId, async (c) => {
        const rows = await c.query(
          `SELECT pair_id FROM matches
            WHERE (user_lo = $1::uuid OR user_hi = $1::uuid)
              AND closed_at IS NULL`,
          [req.userId],
        );
        return rows.rows.map((r) => r.pair_id as string);
      });
      const nowS = Math.floor(ctx.clock.now() / 1000);
      const claims: CentrifugoTokenClaims = {
        sub: req.userId,
        iat: nowS,
        exp: nowS + CENTRIFUGO_TOKEN_TTL_S,
        channels: memberChannels(req.userId, pairIds),
      };
      return reply.send({
        token: signCentrifugoToken(claims, secret),
        expiresIn: CENTRIFUGO_TOKEN_TTL_S,
        channels: claims.channels,
      });
    },
  );
}
