/** Shared service context for edge routes. */

import { randomBytes } from "node:crypto";

import Postgres from "pg";
import { Redis as Valkey } from "ioredis";
import { Clock, IdSource, randomIds, systemClock } from "./clock.js";
import { realtimePublishDuration, realtimePublishFailures } from "./metrics.js";

export interface EdgeContext {
  pg: Postgres.Pool;
  valkey: Valkey;
  matchServiceUrl: string;
  centrifugoUrl: string;
  centrifugoApiKey: string;
  /** TECH-15: injectable — defaults are the wall clock and random ids. */
  clock: Clock;
  ids: IdSource;
}

/** TECH-15: every context gets the system defaults unless a test overrides. */
export function withTime<T extends Omit<EdgeContext, "clock" | "ids">>(
  ctx: T,
  clock: Clock = systemClock,
  ids: IdSource = randomIds,
): T & { clock: Clock; ids: IdSource } {
  return { ...ctx, clock, ids };
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
 * FR-91 rotation key — canonical pair ordering, seven-day TTL. Set when a
 * pair's offer is acted on (consent express); the scan excludes rotating
 * pairs so a declined/expired offer is not re-served for a week.
 */
export function rotationKey(a: string, b: string): string {
  return a < b ? `rotate:${a}:${b}` : `rotate:${b}:${a}`;
}

export const ROTATION_TTL_S = 604_800; // FR-91: seven days

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
  // NFR-07: the realtime leg of sender-to-device delivery is timed per
  // channel class — the p95 of this histogram is what RealtimeDeliverySlow
  // alerts on (deploy/k8s/prometheusrules.yaml).
  const channelClass = channel.split(":", 1)[0] ?? "unknown";
  const started = ctx.clock.now();
  try {
    const res = await fetch(`${ctx.centrifugoUrl}/api/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `apikey ${ctx.centrifugoApiKey}`,
      },
      body: JSON.stringify({ channel, data: event }),
    });
    if (!res.ok) {
      realtimePublishFailures().inc({ channel_class: channelClass });
    }
  } catch (err) {
    realtimePublishFailures().inc({ channel_class: channelClass });
    throw err;
  } finally {
    realtimePublishDuration().observe((ctx.clock.now() - started) / 1000, {
      channel_class: channelClass,
    });
  }
}

/**
 * Remove every trace of an account's live presence (FR-15 leave, FR-18
 * invisible switch, BR-07 account deletion): the user entry, its cell and
 * venue set memberships, the FR-16 session reverse index, and the FR-17
 * intent — the intent expires with presence, so it dies here too.
 */
export async function purgePresence(ctx: EdgeContext, userId: string): Promise<void> {
  const previous = await ctx.valkey.get(`presence:user:${userId}`);
  const pipe = ctx.valkey.pipeline();
  if (previous) {
    try {
      const prev = JSON.parse(previous) as {
        cell?: string;
        venueId?: string | null;
        eventId?: string | null;
        sessionId?: string;
      };
      if (prev.cell) pipe.srem(`presence:cell:${prev.cell}`, userId);
      if (prev.venueId) pipe.srem(`presence:venue:${prev.venueId}`, userId);
      if (prev.eventId) pipe.srem(`presence:event:${prev.eventId}`, userId); // FR-43
      if (prev.sessionId) pipe.del(sessionKey(prev.sessionId));
    } catch {
      // Malformed entry — still purge the primary key below.
    }
  }
  pipe.del(`presence:user:${userId}`);
  pipe.del(`intent:${userId}`); // FR-17: intents expire with presence
  await pipe.exec();
}
