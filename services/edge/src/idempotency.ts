/**
 * Idempotent mutating endpoints (TR-24).
 *
 * Clients retry — networks flap, apps get killed mid-request. Any mutating
 * endpoint accepts an optional `Idempotency-Key` header; while the key is
 * remembered, a replayed request returns the recorded response instead of
 * executing twice. Keys are scoped per user (`idem:{userId}:{key}`) and
 * live for 24 hours.
 *
 * Semantics:
 *   - first sight of a key      → run the handler, record (status, body)
 *   - same key again            → replay the recorded response verbatim,
 *                                 with `Idempotency-Replayed: true`
 *   - same key while in flight  → 409 (the client must wait and retry)
 *   - handler 5xx               → nothing is recorded; the retry executes
 *
 * The header is optional: requests without it behave exactly as before.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EdgeContext } from "./context.js";

/** Keys are client-chosen; keep them URL/log-safe and bounded. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const IDEMPOTENCY_TTL_S = 86_400; // 24 h
const PENDING_TTL_S = 60;                // in-flight lease

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

declare module "fastify" {
  interface FastifyRequest {
    idemValkeyKey?: string;
  }
}

export function idempotencyKeyOf(req: FastifyRequest): string | null {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return null;
  const key = Array.isArray(raw) ? raw[0] : raw;
  return IDEMPOTENCY_KEY_RE.test(key) ? key : null;
}

interface RecordedReply {
  status: number;
  body: string;
}

export function encodeReply(status: number, body: string): string {
  return JSON.stringify({ status, body } satisfies RecordedReply);
}

export function decodeReply(raw: string): RecordedReply | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RecordedReply>;
    if (typeof parsed.status === "number" && typeof parsed.body === "string") {
      return { status: parsed.status, body: parsed.body };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Register the idempotency hooks on an authed scope. preHandler dedupes,
 * onSend records, and a 5xx clears the in-flight lease so retries run.
 */
export function registerIdempotency(scope: FastifyInstance, ctx: EdgeContext): void {
  scope.addHook("preHandler", async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    const raw = req.headers["idempotency-key"];
    if (raw === undefined) return;
    const key = idempotencyKeyOf(req);
    if (key === null) {
      return reply.code(400).send({ error: "invalid Idempotency-Key (TR-24)" });
    }
    const vk = `idem:${req.userId}:${key}`;
    const existing = await ctx.valkey.get(vk);
    if (existing !== null) {
      if (existing === "pending") {
        return reply
          .code(409)
          .send({ error: "request with this Idempotency-Key is in flight (TR-24)" });
      }
      const recorded = decodeReply(existing);
      if (recorded) {
        return reply
          .header("idempotency-replayed", "true")
          .code(recorded.status)
          .header("content-type", "application/json; charset=utf-8")
          .send(recorded.body);
      }
      // Unparseable record — treat as absent and proceed.
    }
    // NX lease: exactly one concurrent request executes per key.
    const claimed = await ctx.valkey.set(vk, "pending", "EX", PENDING_TTL_S, "NX");
    if (claimed === null) {
      return reply
        .code(409)
        .send({ error: "request with this Idempotency-Key is in flight (TR-24)" });
    }
    req.idemValkeyKey = vk;
  });

  scope.addHook("onSend", async (req, reply, payload) => {
    const vk = req.idemValkeyKey;
    if (!vk) return payload;
    const status = reply.statusCode;
    if (status < 500 && typeof payload === "string") {
      await ctx.valkey.set(vk, encodeReply(status, payload), "EX", IDEMPOTENCY_TTL_S);
    } else {
      // 5xx (or a non-string payload): drop the lease — the retry executes.
      await ctx.valkey.del(vk);
    }
    return payload;
  });
}
