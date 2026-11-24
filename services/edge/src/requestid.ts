/**
 * NFR-31: trace-identifier handling. The gateway (APISIX request-id)
 * assigns X-Request-Id; services honor it so one id spans the whole scan
 * path. Only visible ASCII of bounded length is accepted — a malformed id
 * is replaced, never trusted (it lands in logs and response headers).
 */

import { randomUUID } from "node:crypto";

const REQUEST_ID_RE = /^[\x21-\x7e]{1,128}$/;

export function resolveRequestId(incoming: unknown): string {
  return typeof incoming === "string" && REQUEST_ID_RE.test(incoming)
    ? incoming
    : randomUUID();
}
