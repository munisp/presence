/**
 * AMD-ONB-01..06: stakeholder onboarding routes (migration 0037).
 *
 * Applicant surface (consumer realm):
 *
 *   POST /v1/onboarding/applications                      — apply as a venue
 *     partner or provider. KYC-verified prerequisite; the payload is
 *     validated by the route schema AND the storage-layer validator;
 *     idempotent on an open application (already_open returns it).
 *   GET  /v1/onboarding/applications/mine                 — the applicant's
 *     own applications, newest first.
 *   POST /v1/onboarding/applications/:applicationId/withdraw — withdraw a
 *     pending application; decided rows are immutable.
 *   GET  /v1/account/onboarding                           — the consumer
 *     stepper: age, KYC, avatar, verticals, complete (onboarding_status()).
 *   POST /v1/identity/kyc/request                         — initiate KYC
 *     review (pending or rejected members); idempotent while open.
 *
 * Decision surface (workforce realm + moderator role, app.moderator GUC):
 *
 *   GET  /v1/moderation/onboarding                        — the application
 *     queue: pending first (oldest waiting), then recent decisions.
 *   POST /v1/moderation/onboarding/:applicationId/approve — four-eyes
 *     approve; a venue_partner approval provisions the venue as a prospect
 *     and binds the operator (venue_accounts), then the Keycloak venue_ids
 *     attribute replay runs fire-and-forget (keycloakAdmin.ts).
 *   POST /v1/moderation/onboarding/:applicationId/reject  — reject with a
 *     reason the applicant can read.
 *   GET  /v1/moderation/kyc-queue                         — open KYC review
 *     requests, oldest first.
 */

import { FastifyInstance } from "fastify";
import { AuthedRequest, requireModerator, withModerator, withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  APPLICATION_KINDS,
  DECIDE_OUTCOMES,
  KYC_REQUEST_OUTCOMES,
  parseApplicationBody,
  parseStatusDoc,
  POLYGON_MAX_POINTS,
  POLYGON_MIN_POINTS,
  STATEMENT_MAX,
  STATEMENT_MIN,
  TERMS_VERSION_PATTERN,
  VENUE_NAME_MAX,
} from "../onboarding.js";
import { KeycloakAdminConfig, bindVenueId, keycloakAdminFromEnv } from "../keycloakAdmin.js";

const ONBOARDING_WRITE_RATE_LIMIT = {
  max: 10,
  timeWindow: "1 minute",
  keyGenerator: (req: { userId: string }) => req.userId,
} as const;

const MODERATION_RATE_LIMIT = {
  max: 120,
  timeWindow: "1 minute",
  keyGenerator: (req: { userId: string }) => req.userId,
} as const;

const UUID_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: { applicationId: { type: "string", format: "uuid" } },
  required: ["applicationId"],
} as const;

const SCHEDULE_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    timezone: { type: "string", minLength: 1, maxLength: 64 },
    weekly: {
      type: "array",
      maxItems: 21,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["day", "open", "close"],
        properties: {
          day: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
          open: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
          close: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
        },
      },
    },
  },
} as const;

const VENUE_PAYLOAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "polygon", "statement"],
  properties: {
    name: { type: "string", minLength: 2, maxLength: VENUE_NAME_MAX },
    polygon: {
      type: "array",
      minItems: POLYGON_MIN_POINTS,
      maxItems: POLYGON_MAX_POINTS,
      items: {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: { type: "number" },
      },
    },
    schedule: SCHEDULE_SCHEMA,
    statement: { type: "string", minLength: STATEMENT_MIN, maxLength: STATEMENT_MAX },
  },
} as const;

const PROVIDER_PAYLOAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["termsVersion", "statement"],
  properties: {
    termsVersion: { type: "string", pattern: TERMS_VERSION_PATTERN.source },
    statement: { type: "string", minLength: STATEMENT_MIN, maxLength: STATEMENT_MAX },
  },
} as const;

const APPLICATION_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "payload"],
  properties: {
    kind: { type: "string", enum: [...APPLICATION_KINDS] },
    // Per-kind strictness: oneOf here, parseApplicationBody in the module,
    // onboarding_payload_valid in the storage layer — three mirrors, one
    // contract.
    payload: { oneOf: [VENUE_PAYLOAD_SCHEMA, PROVIDER_PAYLOAD_SCHEMA] },
  },
} as const;

const REJECT_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: { type: "string", minLength: STATEMENT_MIN, maxLength: STATEMENT_MAX },
  },
} as const;

let adminConfig: KeycloakAdminConfig | null | undefined;

/** Lazy env gate — same discipline as the SEC-03 elevation binding. */
function keycloakConfig(): KeycloakAdminConfig | null {
  if (adminConfig === undefined) adminConfig = keycloakAdminFromEnv();
  return adminConfig;
}

/** Map the submit definer's outcomes onto status codes. */
function submitError(outcome: string): { code: number; error: string } {
  switch (outcome) {
    case "kyc_required":
      return { code: 403, error: "verify your identity before applying (AMD-ONB-02)" };
    case "unknown_kind":
      return { code: 422, error: "kind must be venue_partner or provider (AMD-ONB-01)" };
    case "invalid_payload":
      return { code: 422, error: "the application payload is not valid (AMD-ONB-01)" };
    default:
      return { code: 403, error: "forbidden" };
  }
}

/** Map the decide definer's outcomes onto status codes. */
function decideError(outcome: string): { code: number; error: string } {
  switch (outcome) {
    case "unknown_application":
      return { code: 404, error: "unknown application" };
    case "not_pending":
      return { code: 409, error: "the application is already decided" };
    case "four_eyes":
      return { code: 409, error: "a moderator never decides their own application (AMD-ONB-04)" };
    case "reason_required":
      return { code: 422, error: "a rejection needs a reason of 10..500 characters (AMD-ONB-04)" };
    case "illegal_decision":
      return { code: 422, error: "decision must be approved or rejected" };
    default:
      return { code: 403, error: "forbidden" };
  }
}

export function registerOnboardingRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // ------------------------------------------------------- applicant ----
  app.post(
    "/v1/onboarding/applications",
    { config: { rateLimit: ONBOARDING_WRITE_RATE_LIMIT }, schema: { body: APPLICATION_BODY } },
    async (req, reply) => {
      const parsed = parseApplicationBody(req.body);
      if (!parsed) {
        return reply.code(422).send({ error: "the application payload is not valid (AMD-ONB-01)" });
      }
      const rows = await withRls(ctx.pg, req.userId, async (c) =>
        c.query(
          `SELECT outcome, application_id AS "applicationId"
             FROM submit_onboarding_application($1, $2::jsonb)`,
          [parsed.kind, JSON.stringify(parsed.payload)],
        ),
      );
      const out = rows.rows[0] as { outcome: string; applicationId: string | null };
      if (out.outcome === "submitted") {
        return reply.code(201).send({ applicationId: out.applicationId, status: "pending" });
      }
      if (out.outcome === "already_open") {
        return reply.code(200).send({ applicationId: out.applicationId, status: "pending" });
      }
      const { code, error } = submitError(out.outcome);
      return reply.code(code).send({ error });
    },
  );

  app.get("/v1/onboarding/applications/mine", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        `SELECT application_id AS "applicationId", kind, payload, status,
                requested_at AS "requestedAt", decided_at AS "decidedAt",
                decision_reason AS "decisionReason"
           FROM onboarding_applications
          WHERE applicant = $1
          ORDER BY requested_at DESC`,
        [req.userId],
      ),
    );
    return reply.send({ applications: rows.rows });
  });

  app.post(
    "/v1/onboarding/applications/:applicationId/withdraw",
    { schema: { params: UUID_PARAMS } },
    async (req, reply) => {
      const { applicationId } = req.params as { applicationId: string };
      const rows = await withRls(ctx.pg, req.userId, async (c) =>
        c.query("SELECT withdraw_onboarding_application($1::uuid) AS outcome", [applicationId]),
      );
      const outcome = (rows.rows[0] as { outcome: string }).outcome;
      if (outcome === "withdrawn") return reply.send({ applicationId, status: "withdrawn" });
      if (outcome === "unknown_application") {
        return reply.code(404).send({ error: "unknown application" });
      }
      if (outcome === "not_pending") {
        return reply.code(409).send({ error: "only a pending application can be withdrawn" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  // AMD-ONB-06: the consumer stepper read model.
  app.get("/v1/account/onboarding", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query("SELECT onboarding_status() AS doc"),
    );
    const doc = parseStatusDoc((rows.rows[0] as { doc: unknown } | undefined)?.doc);
    if (!doc) return reply.code(404).send({ error: "account not found" });
    return reply.send(doc);
  });

  // AMD-ONB-06: initiate KYC review (pending or rejected members).
  app.post(
    "/v1/identity/kyc/request",
    { config: { rateLimit: ONBOARDING_WRITE_RATE_LIMIT } },
    async (req, reply) => {
      const rows = await withRls(ctx.pg, req.userId, async (c) =>
        c.query("SELECT request_kyc_review() AS outcome"),
      );
      const outcome = (rows.rows[0] as { outcome: string }).outcome;
      if (outcome === "recorded") return reply.code(201).send({ kycReviewRequested: true });
      if (outcome === "already_requested") return reply.send({ kycReviewRequested: true });
      if (outcome === "unknown_user") return reply.code(404).send({ error: "account not found" });
      if (outcome === "not_requestable") {
        return reply.code(409).send({ error: "your identity state has no review to request (AMD-ONB-06)" });
      }
      return reply.code(403).send({ error: "forbidden" });
    },
  );

  // ------------------------------------------------------ moderation ----
  app.get(
    "/v1/moderation/onboarding",
    { config: { rateLimit: MODERATION_RATE_LIMIT }, preHandler: [requireModerator] },
    async (req, reply) => {
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(
          `SELECT application_id AS "applicationId", kind, applicant, payload,
                  requested_at AS "requestedAt", status,
                  decided_by AS "decidedBy", decided_at AS "decidedAt",
                  decision_reason AS "decisionReason"
             FROM onboarding_review_queue()`,
        ),
      );
      return reply.send({ applications: rows.rows });
    },
  );

  // Four-eyes approve. A venue_partner approval provisions the venue as a
  // prospect and binds the operator; the Keycloak venue_ids attribute
  // replay is fire-and-forget — the Postgres binding is authoritative.
  app.post(
    "/v1/moderation/onboarding/:applicationId/approve",
    {
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: UUID_PARAMS },
      preHandler: [requireModerator],
    },
    async (req, reply) => {
      const { applicationId } = req.params as { applicationId: string };
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(
          `SELECT outcome, venue_id AS "venueId"
             FROM decide_onboarding_application($1::uuid, 'approved', NULL)`,
          [applicationId],
        ),
      );
      const out = rows.rows[0] as { outcome: string; venueId: string | null };
      if (out.outcome !== "approved") {
        const { code, error } = decideError(out.outcome);
        return reply.code(code).send({ error });
      }
      if (out.venueId) {
        const applicant = await withModerator(ctx.pg, async (c) =>
          c.query("SELECT applicant FROM onboarding_applications WHERE application_id = $1", [
            applicationId,
          ]),
        );
        const subject = (applicant.rows[0] as { applicant: string } | undefined)?.applicant;
        if (subject) void bindVenueId(keycloakConfig(), "add", subject, out.venueId);
      }
      return reply.send({ applicationId, status: "approved", venueId: out.venueId });
    },
  );

  app.post(
    "/v1/moderation/onboarding/:applicationId/reject",
    {
      config: { rateLimit: MODERATION_RATE_LIMIT },
      schema: { params: UUID_PARAMS, body: REJECT_BODY },
      preHandler: [requireModerator],
    },
    async (req, reply) => {
      const { applicationId } = req.params as { applicationId: string };
      const { reason } = req.body as { reason: string };
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(
          "SELECT outcome FROM decide_onboarding_application($1::uuid, 'rejected', $2)",
          [applicationId, reason],
        ),
      );
      const outcome = (rows.rows[0] as { outcome: string }).outcome;
      if (outcome !== "rejected") {
        const { code, error } = decideError(outcome);
        return reply.code(code).send({ error });
      }
      return reply.send({ applicationId, status: "rejected" });
    },
  );

  // AMD-ONB-06: the KYC review worklist.
  app.get(
    "/v1/moderation/kyc-queue",
    { config: { rateLimit: MODERATION_RATE_LIMIT }, preHandler: [requireModerator] },
    async (req, reply) => {
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(
          `SELECT user_id AS "userId", kyc_state AS "kycState",
                  requested_at AS "requestedAt"
             FROM kyc_review_queue()`,
        ),
      );
      return reply.send({ requests: rows.rows });
    },
  );
}

// Re-exported so the OpenAPI contract and the tests can pin the bounds.
export {
  POLYGON_MAX_POINTS,
  POLYGON_MIN_POINTS,
  STATEMENT_MAX,
  STATEMENT_MIN,
  TERMS_VERSION_PATTERN,
  VENUE_NAME_MAX,
};
