/** Shared service context for edge routes. */

import { randomBytes } from "node:crypto";

import Postgres from "pg";
import { Redis as Valkey } from "ioredis";

export interface EdgeContext {
  pg: Postgres.Pool;
  valkey: Valkey;
  matchServiceUrl: string;
  centrifugoUrl: string;
  centrifugoApiKey: string;
}

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

/** FR-23 suppression key — canonical pair ordering, ten-minute TTL. */
export function suppressionKey(a: string, b: string): string {
  return a < b ? `suppress:${a}:${b}` : `suppress:${b}:${a}`;
}

export const SUPPRESSION_TTL_S = 600; // FR-23

/**
 * FR-16: opaque per-presence-session identifier (128-bit random, hex).
 *
 * The session id — not the account id — is what a scan hands to candidates
 * pre-OPEN, so the wire never exposes a stable account identifier before
 * mutual consent.
 */
export function newPresenceSessionId(): string {
  return randomBytes(16).toString("hex");
}

/** Reverse index key: presence session id -> account id (FR-16). */
export function sessionKey(sessionId: string): string {
  return `presence:session:${sessionId}`;
}

/**
 * Publish a realtime event through Centrifugo.
 *
 * Fire-and-forget for the request path: a failed publish is logged by the
 * caller's error handler but never fails the mutation itself (clients
 * reconcile via their next poll).
 */
export async function publishRealtime(
  ctx: EdgeContext,
  channel: string,
  event: Record<string, unknown>,
): Promise<void> {
  await fetch(`${ctx.centrifugoUrl}/api/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `apikey ${ctx.centrifugoApiKey}`,
    },
    body: JSON.stringify({ channel, data: event }),
  });
}

/**
 * Remove every trace of an account's live presence (FR-15 leave, FR-18
 * invisible switch, BR-07 account deletion): the user entry, its cell and
 * venue set memberships, and the FR-16 session reverse index.
 */
export async function purgePresence(ctx: EdgeContext, userId: string): Promise<void> {
  const previous = await ctx.valkey.get(`presence:user:${userId}`);
  const pipe = ctx.valkey.pipeline();
  if (previous) {
    try {
      const prev = JSON.parse(previous) as {
        cell?: string;
        venueId?: string | null;
        sessionId?: string;
      };
      if (prev.cell) pipe.srem(`presence:cell:${prev.cell}`, userId);
      if (prev.venueId) pipe.srem(`presence:venue:${prev.venueId}`, userId);
      if (prev.sessionId) pipe.del(sessionKey(prev.sessionId));
    } catch {
      // Malformed entry — still purge the primary key below.
    }
  }
  pipe.del(`presence:user:${userId}`);
  await pipe.exec();
}
