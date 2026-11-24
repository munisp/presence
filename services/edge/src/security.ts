/**
 * SEC-30: security-event audit writer.
 *
 * Security-relevant events go to the append-only security_audit table
 * (migration 0019) — separate from application logs, which are scrubbed
 * (SEC-29) and rotated with the platform. The kind vocabulary is governed
 * by the table's CHECK constraint; adding a kind means extending both.
 *
 * Writing is fire-and-forget by contract: an audit failure must never
 * break or delay the request path, and the error log carries the kind
 * only — never the detail payload (SEC-29 discipline holds here too).
 */

import Postgres from "pg";

export const SECURITY_EVENT_KINDS = [
  "impossible_travel",
  "missing_attestation",
  "attestation_key_duplicate",
  "mock_location_refusal",
  "console_authorization_denied",
  "retention.purge",
] as const;

export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];

/** Minimal pool shape so the writer is testable without EdgeContext. */
export interface SecurityAuditPool {
  query: Postgres.Pool["query"];
}

export function recordSecurityEvent(
  pg: SecurityAuditPool,
  kind: SecurityEventKind,
  actor: string | null,
  detail: Record<string, unknown> = {},
): void {
  pg.query("SELECT record_security_event($1, $2::uuid, $3::jsonb)", [
    kind,
    actor,
    JSON.stringify(detail),
  ]).catch((err) => console.error("security audit write failed", kind, err));
}
