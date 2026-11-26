/**
 * OpenKYC verification routes (SRS Addendum 001 — AMD-KYC-06..10).
 *
 *   POST /v1/identity/kyc/session      — AMD-KYC-07/08: issue a
 *     verification session: the randomized liveness challenge, its
 *     digest pinned in kyc_sessions, and the single-use signed upload
 *     token. Only a pending or rejected member may open one; one open
 *     session per member (idempotent — a repeat answers 200 with the
 *     open session, the AMD-ONB-02 discipline).
 *   GET  /v1/identity/kyc/session      — the member's own latest
 *     session, minimal projection (never the scores — they would aid
 *     spoof probing).
 *   GET  /v1/moderation/kyc-sessions   — the manual-review worklist the
 *     'review' verdict routes into (AMD-KYC-09).
 *
 * The verdict webhook (registerKycWebhookRoute) is registered OUTSIDE
 * the authed scope — the caller is the OpenKYC pipeline, authenticated
 * by HMAC signature over the canonical payload, never a user token (the
 * AMD-PAY-16 discipline). The edge never sees a capture: uploads go to
 * the OpenKYC service directly (AMD-KYC-10).
 */

import { FastifyInstance } from "fastify";
import { requireModerator, withKycCallback, withModerator, withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import { kycWebhookResults } from "../metrics.js";
import {
  SESSION_TTL_SECONDS,
  buildChallenge,
  challengeDigest,
  challengeToken,
  parseVerdictCallback,
  verdictSignaturePayload,
  verdictSignatureValid,
  verdictTimestampFresh,
} from "../kycVerification.js";

const KYC_WRITE_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
const MODERATION_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;
const WEBHOOK_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

interface SessionRow {
  session_id: string;
  state: string;
  issued_at: string;
  expires_at: string;
  decided_at: string | null;
}

function sessionDoc(row: SessionRow) {
  return {
    sessionId: row.session_id,
    state: row.state,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
  };
}

export function registerKycVerificationRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/identity/kyc/session",
    {
      config: { rateLimit: KYC_WRITE_RATE_LIMIT },
      schema: {
        body: { type: "object", additionalProperties: false, properties: {} },
      },
    },
    async (req, reply) => {
      // The upload-token key signs what the pipeline verifies — without
      // it no session can ever complete, so refuse BEFORE issuing (the
      // AMD-PAY-16 unconfigured-secret discipline).
      const challengeSecret = process.env.KYC_CHALLENGE_SECRET;
      if (!challengeSecret) {
        return reply.code(503).send({ error: "verification not configured (AMD-KYC-09)" });
      }
      const challenge = buildChallenge();
      const digest = challengeDigest(challenge);
      const rows = await withRls(ctx.pg, req.userId, async (c) =>
        c.query(`SELECT outcome, session_id FROM issue_kyc_session($1, $2)`, [
          digest,
          SESSION_TTL_SECONDS,
        ]),
      );
      const out = rows.rows[0] as { outcome: string; session_id: string | null };
      if (out.outcome === "already_open") {
        const current = await withRls(ctx.pg, req.userId, async (c) =>
          c.query(`SELECT * FROM my_kyc_session()`),
        );
        return reply.code(200).send({
          outcome: "already_open",
          session: current.rows.length ? sessionDoc(current.rows[0] as SessionRow) : null,
        });
      }
      if (out.outcome === "not_requestable") {
        return reply
          .code(409)
          .send({ error: "only a pending or rejected member opens a verification session (AMD-KYC-08)" });
      }
      if (out.outcome === "forbidden") {
        return reply.code(404).send({ error: "account not found" });
      }
      if (out.outcome !== "issued" || out.session_id === null) {
        return reply.code(500).send({ error: "session issue failed" });
      }
      // expiresAt echoes the definer's now()+ttl closely enough for the
      // token — the definer's own expires_at remains authoritative.
      const expiresAtEpoch = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      return reply.code(201).send({
        sessionId: out.session_id,
        challenge,
        challengeToken: challengeToken(challengeSecret, out.session_id, digest, expiresAtEpoch),
        expiresAt: expiresAtEpoch,
        uploadUrl: process.env.OPENKYC_UPLOAD_URL ?? "/openkyc/v1/captures",
      });
    },
  );

  app.get("/v1/identity/kyc/session", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(`SELECT * FROM my_kyc_session()`),
    );
    if (rows.rows.length === 0) {
      return reply.code(404).send({ error: "no verification session" });
    }
    return reply.send({ session: sessionDoc(rows.rows[0] as SessionRow) });
  });

  app.get(
    "/v1/moderation/kyc-sessions",
    { config: { rateLimit: MODERATION_RATE_LIMIT }, preHandler: [requireModerator] },
    async (req, reply) => {
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(`SELECT * FROM kyc_session_queue()`),
      );
      return reply.send({
        sessions: rows.rows.map((r) => {
          const row = r as Record<string, unknown>;
          return {
            sessionId: row.session_id,
            applicant: row.applicant,
            issuedAt: row.issued_at,
            decidedAt: row.decided_at,
            credentialKind: row.credential_kind,
            authenticityScore: row.authenticity_score,
            livenessScore: row.liveness_score,
          };
        }),
      });
    },
  );
}

/** AMD-KYC-09: the signed verdict webhook — OUTSIDE the authed scope. */
export function registerKycWebhookRoute(app: FastifyInstance, ctx: EdgeContext): void {
  app.post(
    "/v1/webhooks/kyc-verdict",
    {
      config: { rateLimit: WEBHOOK_RATE_LIMIT },
      schema: {
        body: {
          type: "object",
          required: [
            "sessionId", "challengeDigest", "outcome", "credentialKind",
            "over18", "credentialValid", "authenticityScore", "livenessScore",
            "providerRef",
          ],
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", format: "uuid" },
            challengeDigest: { type: "string", minLength: 64, maxLength: 64 },
            outcome: { type: "string", enum: ["verified", "rejected", "review"] },
            credentialKind: { type: "string", enum: ["id_card", "driving_permit", "travel_document"] },
            over18: { type: "boolean" },
            credentialValid: { type: "boolean" },
            authenticityScore: { type: "number", minimum: 0, maximum: 1 },
            livenessScore: { type: "number", minimum: 0, maximum: 1 },
            providerRef: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
      },
    },
    async (req, reply) => {
      const secret = process.env.KYC_VERDICT_SECRET;
      if (!secret) {
        kycWebhookResults().inc({ result: "unconfigured" });
        return reply.code(503).send({ error: "verdict callback not configured (AMD-KYC-09)" });
      }
      const parsed = parseVerdictCallback(req.body);
      if (parsed === null) {
        kycWebhookResults().inc({ result: "rejected" });
        return reply.code(422).send({ error: "a verdict carries exactly the nine pinned fields (AMD-KYC-08)" });
      }
      // Freshness BEFORE the signature — a stale verdict is refused even
      // when the signature itself is valid (AMD-PAY-22 applied to KYC).
      const at = verdictTimestampFresh(req.headers["x-kyc-timestamp"], Math.floor(Date.now() / 1000));
      if (at === null) {
        kycWebhookResults().inc({ result: "rejected" });
        return reply.code(401).send({ error: "stale or missing timestamp (AMD-KYC-09)" });
      }
      const payload = verdictSignaturePayload(String(at), parsed);
      if (!verdictSignatureValid(secret, payload, req.headers["x-kyc-signature"])) {
        kycWebhookResults().inc({ result: "rejected" });
        return reply.code(401).send({ error: "bad signature" });
      }
      const rows = await withKycCallback(ctx.pg, async (c) =>
        c.query(
          `SELECT complete_kyc_session($1, $2, $3, $4, $5, $6, $7, $8, $9) AS outcome`,
          [
            parsed.sessionId, parsed.challengeDigest, parsed.outcome,
            parsed.credentialKind, parsed.over18, parsed.credentialValid,
            parsed.authenticityScore, parsed.livenessScore, parsed.providerRef,
          ],
        ),
      );
      const outcome = (rows.rows[0] as { outcome: string }).outcome;
      if (outcome === "completed" || outcome === "review_routed" || outcome === "replayed") {
        kycWebhookResults().inc({ result: "accepted" });
        return reply.send({ ok: true, outcome });
      }
      kycWebhookResults().inc({ result: "rejected" });
      if (outcome === "unknown_session") {
        return reply.code(404).send({ error: "unknown session" });
      }
      if (outcome === "challenge_mismatch") {
        return reply.code(401).send({ error: "challenge mismatch" });
      }
      if (outcome === "not_open" || outcome === "expired") {
        return reply.code(409).send({ error: `session ${outcome}` });
      }
      return reply.code(422).send({ error: outcome });
    },
  );
}
