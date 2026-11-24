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
 */

import { FastifyInstance } from "fastify";

export interface ClientConfig {
  configVersion: number;
  pinning: { enabled: boolean; pins: string[] };
}

export interface ClientConfigEnv {
  [key: string]: string | undefined;
  CLIENT_CONFIG_VERSION?: string | undefined;
  CLIENT_TLS_PINS?: string | undefined;
}

/** Resolve the live config from the environment (read per request). */
export function resolveClientConfig(env: ClientConfigEnv = process.env): ClientConfig {
  const pins = (env.CLIENT_TLS_PINS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const parsed = Number.parseInt(env.CLIENT_CONFIG_VERSION ?? "1", 10);
  const configVersion = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  return { configVersion, pinning: { enabled: pins.length > 0, pins } };
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
            required: ["configVersion", "pinning"],
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
            },
          },
        },
      },
    },
    async () => resolveClientConfig(),
  );
}
