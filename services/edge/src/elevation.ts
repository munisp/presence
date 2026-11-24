/**
 * SEC-03: just-in-time workforce elevation — constants, gates and parsing.
 *
 * The workflow (migration 0022 is the source of truth):
 *
 *   request   — an elevation-eligible workforce member asks for a
 *               time-boxed grant with a screened justification;
 *   approve   — a DIFFERENT moderator approves (four-eyes, enforced by the
 *               definer AND the table CHECK); the grant lives at most
 *               ELEVATION_GRANT_TTL_MS, pinned to the workforce realm's
 *               ssoSessionMaxLifespan (14400 s) so no grant can outlive the
 *               session ceiling;
 *   expire    — the lifecycle tick flips expired grants and the edge unbinds
 *               the Keycloak realm role (keycloakAdmin.ts);
 *   revoke    — a moderator can end a live grant early;
 *   reject    — a moderator declines a pending request.
 *
 * Every transition writes the FR-60 append-only audit trail inside its
 * definer, so the record cannot be detached from the action.
 */

import { FastifyReply, FastifyRequest } from "fastify";
import { AuthedRequest, requireWorkforceRole } from "./auth.js";
import { screenText } from "./screening.js";

/** SEC-03: grant TTL — pinned to workforce ssoSessionMaxLifespan (4 h). */
export const ELEVATION_GRANT_TTL_MS = 4 * 60 * 60 * 1000;
/** A pending request nobody decides on lapses after 24 hours. */
export const ELEVATION_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

/** The only elevated scope in P0; the SQL CHECK mirrors this set. */
export const ELEVATION_SCOPES = ["moderation"] as const;
export type ElevationScope = (typeof ELEVATION_SCOPES)[number];

/**
 * The requester gate: workforce realm + the elevation-eligible role. This is
 * deliberately NOT requireModerator — the whole point of JIT elevation is
 * that eligible members do not hold standing administrative access.
 */
export async function requireElevationEligible(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireWorkforceRole(req, reply, "elevation-eligible");
}

export interface ElevationRequestBody {
  scope: ElevationScope;
  justification: string;
}

/**
 * Parse and screen the request body. The length window mirrors the SQL
 * CHECK (10–500 chars); the justification is free text and therefore passes
 * through the SEC-26 deterministic screener like any other user input.
 */
export function parseElevationRequestBody(
  body: unknown,
): { ok: true; value: ElevationRequestBody } | { ok: false; error: string } {
  if (body === null || typeof body !== "object") {
    return { ok: false, error: "scope and justification are required" };
  }
  const b = body as Record<string, unknown>;
  const scope = b.scope === undefined ? "moderation" : b.scope;
  if (typeof scope !== "string" || !(ELEVATION_SCOPES as readonly string[]).includes(scope)) {
    return { ok: false, error: `scope must be one of: ${ELEVATION_SCOPES.join(", ")}` };
  }
  const justification = b.justification;
  if (typeof justification !== "string" || justification.length < 10 || justification.length > 500) {
    return { ok: false, error: "justification must be 10–500 characters" };
  }
  const findings = screenText(justification);
  if (findings.length > 0) {
    return { ok: false, error: "justification failed content screening" };
  }
  return { ok: true, value: { scope: scope as ElevationScope, justification } };
}

/** Subject for the elevation call — the workforce token's sub. */
export function elevationSubject(req: FastifyRequest): string {
  return (req as AuthedRequest).userId;
}
