/**
 * TR-25: the machine-readable error contract. Every error response carries
 *   error    — stable human message (unchanged from what routes send today)
 *   code     — stable machine code: "<status>.<slug of the message>"
 *   retryable — true only for 429 and 5xx
 * Retry-limited routes also carry retryAfterSeconds.
 *
 * The code is derived from the test-pinned human message, so it is stable
 * across releases and refactorings as long as the contract tests pass:
 * the "(XX-NN)" requirement tag is stripped, the text is lowercased, split
 * on non-alphanumerics, and the first four words are joined with "_".
 *   404 { error: "pair not found (FR-31)" } → code "404.pair_not_found"
 *
 * Enrichment happens in one preSerialization hook (app.ts) instead of
 * touching every send site: any object payload with a string `error` and no
 * `code` gets the pair attached. The setErrorHandler covers the paths that
 * never reach a route — schema validation (400), the global/rate-limit
 * plugin's 429, auth 401s, and unexpected exceptions (500) — and never leaks
 * internals: validation details, internal identifiers and stack traces stay
 * server-side (TR-25's second clause).
 */

import { FastifyInstance } from "fastify";

/** Slug of a human message, stable while the message text is stable. */
function messageSlug(message: string): string {
  const words = message
    .replace(/\s*\([A-Z]+-[A-Z0-9-]+\)\s*$/, "") // requirement tag, e.g. (FR-31)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);
  return words.join("_") || "error";
}

export function errorCodeFor(status: number, message: string): string {
  return `${status}.${messageSlug(message)}`;
}

export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** TR-25: attach code/retryable to route-level error payloads. */
export function registerErrorContract(app: FastifyInstance): void {
  app.addHook("preSerialization", async (req, reply, payload) => {
    if (
      reply.statusCode >= 400 &&
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof (payload as { error?: unknown }).error === "string" &&
      (payload as { code?: unknown }).code === undefined
    ) {
      const body = payload as Record<string, unknown>;
      body.code = errorCodeFor(reply.statusCode, body.error as string);
      body.retryable = isRetryable(reply.statusCode);
    }
    return payload;
  });

  app.setErrorHandler((raw: unknown, req, reply) => {
    const err = raw as { statusCode?: number; validation?: unknown; message?: string };
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (err.validation) {
      // ajv failed the request (TR-23). The validation tree names fields and
      // schemas — internal detail that must not cross the wire (TR-25).
      return reply.code(400).send({
        error: "request failed schema validation",
        code: errorCodeFor(400, "request failed schema validation"),
        retryable: false,
      });
    }
    if (statusCode === 429) {
      // @fastify/rate-limit. retryAfterSeconds rides along when the plugin
      // knows the window.
      const body: Record<string, unknown> = {
        error: "rate limit exceeded",
        code: errorCodeFor(429, "rate limit exceeded"),
        retryable: true,
      };
      const retryAfter = Number(reply.getHeader("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        body.retryAfterSeconds = retryAfter;
      }
      return reply.code(429).send(body);
    }
    if (statusCode < 500) {
      // Known client error without a route handler (e.g. auth rejects).
      return reply.code(statusCode).send({
        error: "request rejected",
        code: errorCodeFor(statusCode, "request rejected"),
        retryable: false,
      });
    }
    // Unexpected: log the real error server-side, mask everything outbound.
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({
      error: "internal error",
      code: errorCodeFor(500, "internal error"),
      retryable: true,
    });
  });
}
