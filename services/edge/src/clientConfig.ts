/**
 * TR-33: client security config — the remote kill-switch for TLS pinning.
 *
 *   GET /v1/client/config — unauthenticated bootstrap config the client
 *                           reads at startup, before login completes.
 *
 * The certificate-pinning policy is operational, not compiled in: ops
 * rotate or REMOVE the pin set by changing server-side configuration
 * (env/secret) and bumping CLIENT_CONFIG_VERSION — no app update, so a
 * pin incident can never brick installed clients (the SRS's condition on
 * pinning being allowed at all). The payload carries no user data; SPKI
 * pin fingerprints are public values visible to anyone who completes a
 * TLS handshake with the server.
 *
 * Env:
 *   CLIENT_CONFIG_VERSION — monotonic integer, bump on every change (TR-20
 *                           discipline; clients refuse older versions)
 *   CLIENT_TLS_PINS       — comma-separated sha256/SPKI base64 pins;
 *                           empty means pinning disabled (the default and
 *                           the removal mechanism)
 *   CLIENT_MIN_VERSION    — TR-27: minimum client protocol version served
 *                           (see versioning.ts); the bootstrap channel of
 *                           unsupported-version detection
 *   KEYCLOAK_PUBLIC_ISSUER_URL — FR-01: the DEVICE-REACHABLE issuer of the
 *                           passkey-only consumer realm (KEYCLOAK_ISSUER is
 *                           the in-cluster URL the edge verifies against —
 *                           a phone cannot resolve it). Falls back to
 *                           KEYCLOAK_ISSUER so compose/dev stays zero-config.
 *   KEYCLOAK_CLIENT_ID    — the realm's public client for the app; defaults
 *                           to the realm-exported "presence-app". Public
 *                           values, like the pins: no secret material.
 *   REALTIME_PUBLIC_WS_URL — AMD-CRT-04: the DEVICE-REACHABLE Centrifugo
 *                           websocket URL (through APISIX). Empty means the
 *                           deployment has no realtime tier and the client
 *                           adapter stays off — fail closed, never guessed.
 */

/**
 * AMD-NET-04: the endpoint answers conditional requests. The ETag is
 * derived from the config version and the pin-set hash — a matching
 * If-None-Match gets a 304 (one round trip, no body), which is what
 * makes the TR-33 cached-config startup cheap on the last mile. The
 * 60-second max-age bounds staleness of a pin ROTATION to one minute.
 */

import { createHash } from "node:crypto";

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { API_VERSION, resolveMinClientVersion, VersionEnv } from "./versioning.js";

export interface ClientConfig {
  configVersion: number;
  pinning: { enabled: boolean; pins: string[] };
  /** TR-27: the server's version posture, evaluated at client startup. */
  api: { version: number; minClientVersion: number };
  /**
   * FR-01: where the client authenticates — the passkey-only consumer
   * realm. The client builds its Authorization Code + PKCE (S256) request
   * against this issuer and refuses to sign in when it is empty.
   */
  auth: { issuer: string; clientId: string };
  /**
   * AMD-CRT-04: the realtime tier's public websocket URL. Empty string
   * means no realtime tier is deployed — the client adapter stays off
   * (fail closed). The connection token itself comes from the authed
   * POST /v1/realtime/token, never from this unauthenticated payload.
   */
  realtime: { wsUrl: string };
}

export interface ClientConfigEnv extends VersionEnv {
  CLIENT_CONFIG_VERSION?: string | undefined;
  CLIENT_TLS_PINS?: string | undefined;
  KEYCLOAK_PUBLIC_ISSUER_URL?: string | undefined;
  KEYCLOAK_CLIENT_ID?: string | undefined;
  /** In-cluster issuer (auth.ts verifies against it); dev fallback only. */
  KEYCLOAK_ISSUER?: string | undefined;
  /** AMD-CRT-04: public Centrifugo websocket URL; empty disables realtime. */
  REALTIME_PUBLIC_WS_URL?: string | undefined;
}

/** Resolve the live config from the environment (read per request). */
export function resolveClientConfig(env: ClientConfigEnv = process.env): ClientConfig {
  const pins = (env.CLIENT_TLS_PINS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const parsed = Number.parseInt(env.CLIENT_CONFIG_VERSION ?? "1", 10);
  const configVersion = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  const issuer = (env.KEYCLOAK_PUBLIC_ISSUER_URL ?? env.KEYCLOAK_ISSUER ?? "").replace(
    /\/+$/,
    "",
  );
  const clientId = (env.KEYCLOAK_CLIENT_ID ?? "").trim() || "presence-app";
  return {
    configVersion,
    pinning: { enabled: pins.length > 0, pins },
    api: { version: API_VERSION, minClientVersion: resolveMinClientVersion(env) },
    auth: { issuer, clientId },
    realtime: { wsUrl: (env.REALTIME_PUBLIC_WS_URL ?? "").trim() },
  };
}

/**
 * AMD-NET-04: the validator for conditional GETs — derived from the
 * config version and the pin-set hash, so ANY change to the payload's
 * operational content moves the tag. Strong ETag: the payload is
 * deterministic for a given version+pin-set (resolveClientConfig is a
 * pure function of the environment).
 */
export function clientConfigETag(config: ClientConfig): string {
  const pinsHash = createHash("sha256")
    .update(config.pinning.pins.join(","))
    .digest("hex")
    .slice(0, 16);
  return `"v${config.configVersion}-${pinsHash}"`;
}

function sendConfig(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const config = resolveClientConfig();
  const etag = clientConfigETag(config);
  void reply.header("cache-control", "max-age=60");
  void reply.header("etag", etag);
  if (request.headers["if-none-match"] === etag) {
    // AMD-NET-04: one round trip, no body — the AMD-NET-05 revalidation
    // budget ("configRevalidate") is exactly this cheap.
    return reply.code(304).send();
  }
  return reply.send(config);
}

export function registerClientConfigRoute(app: FastifyInstance): void {
  // Unauthenticated by design (registered outside the authed scope in
  // app.ts): the client needs its TLS policy before it can hold a token.
  app.get(
    "/v1/client/config",
    {
      schema: {
        response: {
          200: {
            type: "object",
            required: ["configVersion", "pinning", "api", "auth", "realtime"],
            properties: {
              configVersion: { type: "integer" },
              pinning: {
                type: "object",
                required: ["enabled", "pins"],
                properties: {
                  enabled: { type: "boolean" },
                  pins: { type: "array", items: { type: "string" } },
                },
              },
              api: {
                type: "object",
                required: ["version", "minClientVersion"],
                properties: {
                  version: { type: "integer" },
                  minClientVersion: { type: "integer" },
                },
              },
              auth: {
                type: "object",
                required: ["issuer", "clientId"],
                properties: {
                  issuer: { type: "string" },
                  clientId: { type: "string" },
                },
              },
              realtime: {
                type: "object",
                required: ["wsUrl"],
                properties: {
                  wsUrl: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => sendConfig(request, reply),
  );
}
