/**
 * TR-27: the server's half of unsupported-version detection.
 *
 * Clients must be able to detect an unsupported API version and prompt
 * for an update rather than failing silently — detection needs the
 * server to PUBLISH its version posture on three channels:
 *
 *   1. Bootstrap — GET /v1/client/config carries `api.version` and
 *      `api.minClientVersion` (see clientConfig.ts). This is the primary
 *      channel: the client evaluates it at startup, before login.
 *   2. Header — every response carries `x-api-version` (onSend hook
 *      here), so a client can notice mid-session that the contract
 *      moved under it.
 *   3. Refusal — when ops raise the floor ABOVE a build, requests that
 *      build identifies itself on (x-client-version) answer
 *      426 upgrade_required through the TR-25 error contract. Requests
 *      without the header pass: a build old enough to predate the
 *      header is detected via channel 1 instead.
 *
 * Exemptions: /healthz, /metrics and /v1/client/config never 426 — the
 * bootstrap config is the detection channel itself, and refusing it
 * would be failing silently by another name.
 *
 * Env:
 *   CLIENT_MIN_VERSION — minimum client protocol version served;
 *                        default 1 (every build). Raise only with a
 *                        coordinated client rollout; the constant is a
 *                        floor, not a target.
 */

import { FastifyInstance } from "fastify";

/** The API major this edge speaks (matches the /v1 prefix). */
export const API_VERSION = 1;

/** Header names, fixed so client and server cannot drift apart. */
export const API_VERSION_HEADER = "x-api-version";
export const CLIENT_VERSION_HEADER = "x-client-version";

/** Routes that must stay reachable from EVERY build, however old. */
const FLOOR_EXEMPT_PREFIXES: readonly string[] = ["/healthz", "/metrics", "/v1/client/config"];

export interface VersionEnv {
  [key: string]: string | undefined;
  CLIENT_MIN_VERSION?: string | undefined;
}

/** The configured client floor; malformed values fall back to 1. */
export function resolveMinClientVersion(env: VersionEnv = process.env): number {
  const parsed = Number.parseInt(env.CLIENT_MIN_VERSION ?? "1", 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

export function registerVersionContract(app: FastifyInstance, env: VersionEnv = process.env): void {
  const minClientVersion = resolveMinClientVersion(env);

  // Channel 2: the API version rides every response.
  app.addHook("onSend", async (_req, reply) => {
    reply.header(API_VERSION_HEADER, String(API_VERSION));
  });

  // Channel 3: refuse builds that identify themselves below the floor.
  app.addHook("onRequest", async (req, reply) => {
    if (FLOOR_EXEMPT_PREFIXES.some((p) => req.url.startsWith(p))) return;
    const raw = req.headers[CLIENT_VERSION_HEADER];
    if (typeof raw !== "string") return;
    const build = Number.parseInt(raw, 10);
    if (!Number.isInteger(build) || build < 1) return;
    if (build < minClientVersion) {
      // TR-25 enriches this payload with code/retryable in preSerialization.
      return reply.code(426).send({ error: "client version is no longer supported (TR-27)" });
    }
  });
}
