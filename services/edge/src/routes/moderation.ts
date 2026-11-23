/**
 * Trust & moderation routes (PRS-SRS-001 §4 trust & safety).
 *
 * Console endpoints (FR-54) — every one gated by requireModerator (workforce
 * realm + moderator role) and run under the app.moderator GUC:
 *
 *   GET  /v1/moderation/queue                          — open reports, lowest
 *                                                        trust first
 *   GET  /v1/moderation/accounts/:userId               — the account card:
 *                                                        trust inputs,
 *                                                        suspensions, report
 *                                                        stats, ledger stats,
 *                                                        audit trail — NEVER
 *                                                        message content
 *   POST /v1/moderation/reports/:reportId/resolve      — close with an outcome,
 *                                                        optionally suspend
 *   POST /v1/moderation/accounts/:userId/investigation-remove   — FR-53 silent
 *   POST /v1/moderation/accounts/:userId/investigation-restore  — undo
 *   POST /v1/moderation/suspensions/:suspensionId/lift — FR-55 per-dimension
 *   GET  /v1/moderation/appeals                        — open appeals
 *   POST /v1/moderation/appeals/:appealId/resolve      — uphold or overturn
 *
 * User-facing appeal path (FR-53), under the normal RLS context:
 *
 *   POST /v1/account/appeals — file an appeal (screened; one open at a time)
 *   GET  /v1/account/appeals — my appeals
 *
 * Every action writes the FR-60 append-only audit trail with a governed
 * reason code. Investigation removal is silent by construction: presence is
 * purged without a realtime event and discovery answers the same neutral
 * error as an age block.
 */

import { FastifyInstance } from "fastify";
import { AuthedRequest, requireModerator, withModerator, withRls } from "../auth.js";
import { EdgeContext, purgePresence } from "../context.js";
import {
  parseAppealBody,
  parseReasonCode,
  parseResolveAppealBody,
  parseResolveReportBody,
} from "../moderation.js";
import { screenText, screeningErrorMessage } from "../screening.js";

const UUID_PARAMS = (names: string[]) => ({
  type: "object" as const,
  required: names,
  additionalProperties: false as const,
  properties: Object.fromEntries(names.map((n) => [n, { type: "string", format: "uuid" }])),
});

const QUEUE_LIMIT = 50;
const AUDIT_TRAIL_LIMIT = 20;

export function registerModerationRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // ------------------------------------------------------------ console ----
  // FR-52: the queue is ordered by trust — the accounts most likely to need
  // action surface first; ties break by age of the report.
  app.get(
    "/v1/moderation/queue",
    { preHandler: requireModerator },
    async (req, reply) => {
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(
          `SELECT r.report_id, r.reported, r.reason, r.created_at, r.status,
                  trust_score(r.reported) AS trust
             FROM reports r
            WHERE r.status <> 'closed'
            ORDER BY trust_score(r.reported) ASC NULLS LAST, r.created_at ASC
            LIMIT $1`,
          [QUEUE_LIMIT],
        ),
      );
      return reply.send({
        queue: rows.rows.map((r) => ({
          reportId: r.report_id,
          reported: r.reported,
          reason: r.reason,
          status: r.status,
          trust: r.trust === null ? null : Number(r.trust),
          createdAt: r.created_at,
        })),
      });
    },
  );

  // FR-54: the account card. Aggregates and moderation state only — this
  // route deliberately never touches message envelopes or pair content.
  app.get(
    "/v1/moderation/accounts/:userId",
    { schema: { params: UUID_PARAMS(["userId"]) }, preHandler: requireModerator },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      const card = await withModerator(ctx.pg, async (c) => {
        const u = await c.query(
          `SELECT user_id, created_at, age_declared_at, age_blocked,
                  age_reverify_required_at, age_reverified_at,
                  investigation_removed_at, investigation_reason_code, deleted_at
             FROM users WHERE user_id = $1`,
          [userId],
        );
        if (u.rows.length === 0) return null;
        const trust = await c.query("SELECT trust_score($1::uuid) AS trust", [userId]);
        const suspensions = await c.query(
          `SELECT suspension_id, dimension, reason_code, report_id, created_at, lifted_at
             FROM suspensions WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId],
        );
        const reportStats = await c.query(
          `SELECT count(*) FILTER (WHERE status <> 'closed') AS open,
                  count(*) FILTER (WHERE outcome = 'actioned') AS actioned,
                  count(*) FILTER (WHERE outcome = 'dismissed') AS dismissed
             FROM reports WHERE reported = $1`,
          [userId],
        );
        const ledger = await c.query("SELECT account_ledger_stats($1::uuid) AS stats", [userId]);
        // FR-07: attestation-key collisions involving this account, either
        // side — the silent duplicate signal surfaces here and nowhere else.
        const duplicates = await c.query(
          `SELECT duplicate_id, key_hash, existing_user, incoming_user, detected_at
             FROM attestation_duplicates
            WHERE existing_user = $1 OR incoming_user = $1
            ORDER BY detected_at DESC`,
          [userId],
        );
        const audit = await c.query(
          `SELECT seq, actor, action, reason_code, target_type, target_id, at
             FROM admin_audit
            WHERE target_id = $1
            ORDER BY seq DESC
            LIMIT $2`,
          [userId, AUDIT_TRAIL_LIMIT],
        );
        return { u: u.rows[0], trust: trust.rows[0].trust, suspensions: suspensions.rows, reportStats: reportStats.rows[0], ledger: ledger.rows[0].stats, duplicates: duplicates.rows, audit: audit.rows };
      });
      if (card === null) return reply.code(404).send({ error: "account not found" });
      // Live-presence flag from Valkey (no cell, no venue — just live or not).
      const liveNow = (await ctx.valkey.exists(`presence:user:${userId}`)) === 1;
      return reply.send({
        userId,
        trust: card.trust === null ? null : Number(card.trust),
        createdAt: card.u.created_at,
        ageDeclared: card.u.age_declared_at !== null,
        ageBlocked: card.u.age_blocked === true,
        // SEC-17/BR-03: the console sees the re-verification loop state —
        // never a birth date or document (none exist).
        ageReverifyRequired: card.u.age_reverify_required_at !== null,
        ageReverifiedAt: card.u.age_reverified_at,
        investigationRemoved: card.u.investigation_removed_at !== null,
        investigationReasonCode: card.u.investigation_reason_code,
        deleted: card.u.deleted_at !== null,
        liveNow,
        suspensions: card.suspensions.map((s) => ({
          suspensionId: s.suspension_id,
          dimension: s.dimension,
          reasonCode: s.reason_code,
          reportId: s.report_id,
          active: s.lifted_at === null,
          createdAt: s.created_at,
          liftedAt: s.lifted_at,
        })),
        reports: {
          open: Number(card.reportStats.open),
          actioned: Number(card.reportStats.actioned),
          dismissed: Number(card.reportStats.dismissed),
        },
        consentLedger: card.ledger ?? {},
        attestationDuplicates: card.duplicates.map((d) => ({
          duplicateId: d.duplicate_id,
          keyHashPrefix: (d.key_hash as string).slice(0, 8),
          existingUser: d.existing_user,
          incomingUser: d.incoming_user,
          detectedAt: d.detected_at,
        })),
        auditTrail: card.audit.map((a) => ({
          seq: Number(a.seq),
          actor: a.actor,
          action: a.action,
          reasonCode: a.reason_code,
          targetType: a.target_type,
          at: a.at,
        })),
      });
    },
  );

  // FR-54: resolve a report — set the outcome (feeds the FR-52 trust score),
  // close it, and optionally create a suspension and/or flag an investigation
  // removal in the same transaction. One audit row records the action.
  app.post(
    "/v1/moderation/reports/:reportId/resolve",
    { schema: { params: UUID_PARAMS(["reportId"]) }, preHandler: requireModerator },
    async (req, reply) => {
      const { reportId } = req.params as { reportId: string };
      const parsed = parseResolveReportBody(req.body);
      if (!parsed.ok) {
        return reply.code(422).send({ error: "outcome and a governed reasonCode are required" });
      }
      const moderator = (req as AuthedRequest).userId;
      try {
        const out = await withModerator(ctx.pg, async (c) => {
          const r = await c.query(
            "SELECT reported, status FROM reports WHERE report_id = $1 FOR UPDATE",
            [reportId],
          );
          if (r.rows.length === 0) throw Object.assign(new Error("report not found"), { code: 404 });
          if (r.rows[0].status === "closed") {
            throw Object.assign(new Error("report already resolved"), { code: 409 });
          }
          const reported = r.rows[0].reported as string;
          await c.query(
            `UPDATE reports
                SET status = 'closed', outcome = $2, resolved_by = $3, resolved_at = now()
              WHERE report_id = $1`,
            [reportId, parsed.value.outcome, moderator],
          );
          let suspensionId: string | null = null;
          if (parsed.value.suspension) {
            const s = await c.query(
              `INSERT INTO suspensions (user_id, dimension, reason_code, report_id, created_by)
               VALUES ($1, $2, $3, $4, $5) RETURNING suspension_id`,
              [reported, parsed.value.suspension.dimension, parsed.value.reasonCode, reportId, moderator],
            );
            suspensionId = s.rows[0].suspension_id as string;
          }
          if (parsed.value.investigationRemove) {
            await c.query(
              `UPDATE users
                  SET investigation_removed_at = now(), investigation_reason_code = $2
                WHERE user_id = $1 AND investigation_removed_at IS NULL`,
              [reported, parsed.value.reasonCode],
            );
          }
          // SEC-17/BR-03: an actioned underage report closes discovery until
          // the account re-verifies a consistent adult birth year — set in
          // the same transaction as the resolution so there is no window.
          if (parsed.value.reasonCode === "underage" && parsed.value.outcome === "actioned") {
            await c.query(
              `UPDATE users
                  SET age_reverify_required_at = now()
                WHERE user_id = $1 AND age_reverify_required_at IS NULL`,
              [reported],
            );
          }
          await c.query(
            `SELECT admin_audit_log($1, 'moderation.report.resolve', $2, 'user', $3,
                    jsonb_build_object('reportId', $4),
                    jsonb_build_object('outcome', $5, 'suspensionId', $6::text,
                                       'investigationRemove', $7))`,
            [
              moderator,
              parsed.value.reasonCode,
              reported,
              reportId,
              parsed.value.outcome,
              suspensionId,
              parsed.value.investigationRemove === true,
            ],
          );
          return { reported, suspensionId };
        });
        if (parsed.value.investigationRemove) {
          // FR-53: silent — purge live presence with no realtime event.
          await purgePresence(ctx, out.reported);
        }
        return reply.send({ reportId, status: "closed", outcome: parsed.value.outcome, suspensionId: out.suspensionId });
      } catch (err) {
        const e = err as { code?: number | string; message?: string };
        if (e.code === 404) return reply.code(404).send({ error: "report not found" });
        if (e.code === 409) return reply.code(409).send({ error: e.message });
        if (e.code === "23505") {
          // suspensions_one_active — one active suspension per dimension.
          return reply.code(409).send({ error: "an active suspension already exists on that dimension (FR-55)" });
        }
        throw err;
      }
    },
  );

  // FR-53: silent investigation removal. The flag closes discovery with the
  // neutral error; live presence is purged without a realtime event.
  app.post(
    "/v1/moderation/accounts/:userId/investigation-remove",
    { schema: { params: UUID_PARAMS(["userId"]) }, preHandler: requireModerator },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reasonCode = parseReasonCode(body.reasonCode);
      if (!reasonCode) return reply.code(422).send({ error: "a governed reasonCode is required" });
      const moderator = (req as AuthedRequest).userId;
      const changed = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `UPDATE users
              SET investigation_removed_at = now(), investigation_reason_code = $2
            WHERE user_id = $1 AND investigation_removed_at IS NULL
            RETURNING user_id`,
          [userId, reasonCode],
        );
        if (r.rows.length === 0) return false;
        await c.query(
          `SELECT admin_audit_log($1, 'moderation.investigation.remove', $2, 'user', $3, NULL, NULL)`,
          [moderator, reasonCode, userId],
        );
        return true;
      });
      if (!changed) return reply.code(409).send({ error: "account is already investigation-removed or unknown" });
      // Silent: purgePresence publishes nothing.
      await purgePresence(ctx, userId);
      return reply.send({ userId, investigationRemoved: true });
    },
  );

  // FR-53: restore — the appeal path's overturn also lands here.
  app.post(
    "/v1/moderation/accounts/:userId/investigation-restore",
    { schema: { params: UUID_PARAMS(["userId"]) }, preHandler: requireModerator },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reasonCode = parseReasonCode(body.reasonCode);
      if (!reasonCode) return reply.code(422).send({ error: "a governed reasonCode is required" });
      const moderator = (req as AuthedRequest).userId;
      const changed = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `UPDATE users
              SET investigation_removed_at = NULL, investigation_reason_code = NULL
            WHERE user_id = $1 AND investigation_removed_at IS NOT NULL
            RETURNING user_id`,
          [userId],
        );
        if (r.rows.length === 0) return false;
        await c.query(
          `SELECT admin_audit_log($1, 'moderation.investigation.restore', $2, 'user', $3, NULL, NULL)`,
          [moderator, reasonCode, userId],
        );
        return true;
      });
      if (!changed) return reply.code(409).send({ error: "account is not investigation-removed" });
      return reply.send({ userId, investigationRemoved: false });
    },
  );

  // FR-55: lift one dimension's suspension; the others stay as they are.
  app.post(
    "/v1/moderation/suspensions/:suspensionId/lift",
    { schema: { params: UUID_PARAMS(["suspensionId"]) }, preHandler: requireModerator },
    async (req, reply) => {
      const { suspensionId } = req.params as { suspensionId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reasonCode = parseReasonCode(body.reasonCode);
      if (!reasonCode) return reply.code(422).send({ error: "a governed reasonCode is required" });
      const moderator = (req as AuthedRequest).userId;
      const out = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `UPDATE suspensions
              SET lifted_at = now(), lifted_by = $2, lift_reason = $3
            WHERE suspension_id = $1 AND lifted_at IS NULL
            RETURNING user_id, dimension`,
          [suspensionId, moderator, reasonCode],
        );
        if (r.rows.length === 0) return null;
        await c.query(
          `SELECT admin_audit_log($1, 'moderation.suspension.lift', $2, 'user', $3,
                  jsonb_build_object('suspensionId', $4, 'dimension', $5), NULL)`,
          [moderator, reasonCode, r.rows[0].user_id, suspensionId, r.rows[0].dimension],
        );
        return r.rows[0];
      });
      if (out === null) return reply.code(409).send({ error: "suspension is not active or unknown" });
      return reply.send({ suspensionId, lifted: true });
    },
  );

  // FR-53: the appeal queue — open appeals, oldest first.
  app.get(
    "/v1/moderation/appeals",
    { preHandler: requireModerator },
    async (req, reply) => {
      const rows = await withModerator(ctx.pg, async (c) =>
        c.query(
          `SELECT appeal_id, user_id, suspension_id, body, created_at
             FROM appeals WHERE state = 'open'
            ORDER BY created_at ASC
            LIMIT $1`,
          [QUEUE_LIMIT],
        ),
      );
      return reply.send({
        appeals: rows.rows.map((a) => ({
          appealId: a.appeal_id,
          userId: a.user_id,
          suspensionId: a.suspension_id,
          body: a.body,
          createdAt: a.created_at,
        })),
      });
    },
  );

  // FR-53: resolve an appeal. Overturning lifts the referenced suspension
  // (when still active) and clears any investigation removal — the user is
  // made whole in the same transaction.
  app.post(
    "/v1/moderation/appeals/:appealId/resolve",
    { schema: { params: UUID_PARAMS(["appealId"]) }, preHandler: requireModerator },
    async (req, reply) => {
      const { appealId } = req.params as { appealId: string };
      const parsed = parseResolveAppealBody(req.body);
      if (!parsed.ok) {
        return reply.code(422).send({ error: "decision and a governed reasonCode are required" });
      }
      const moderator = (req as AuthedRequest).userId;
      try {
        const out = await withModerator(ctx.pg, async (c) => {
          const a = await c.query(
            "SELECT user_id, suspension_id, state FROM appeals WHERE appeal_id = $1 FOR UPDATE",
            [appealId],
          );
          if (a.rows.length === 0) throw Object.assign(new Error("appeal not found"), { code: 404 });
          if (a.rows[0].state !== "open") {
            throw Object.assign(new Error("appeal already resolved"), { code: 409 });
          }
          const userId = a.rows[0].user_id as string;
          const suspensionId = a.rows[0].suspension_id as string | null;
          await c.query(
            `UPDATE appeals
                SET state = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4
              WHERE appeal_id = $1`,
            [appealId, parsed.value.decision, moderator, parsed.value.note ?? null],
          );
          if (parsed.value.decision === "overturned") {
            if (suspensionId) {
              await c.query(
                `UPDATE suspensions
                    SET lifted_at = now(), lifted_by = $2, lift_reason = $3
                  WHERE suspension_id = $1 AND lifted_at IS NULL`,
                [suspensionId, moderator, parsed.value.reasonCode],
              );
            }
            await c.query(
              `UPDATE users
                  SET investigation_removed_at = NULL, investigation_reason_code = NULL
                WHERE user_id = $1`,
              [userId],
            );
          }
          await c.query(
            `SELECT admin_audit_log($1, 'moderation.appeal.resolve', $2, 'user', $3,
                    jsonb_build_object('appealId', $4),
                    jsonb_build_object('decision', $5))`,
            [moderator, parsed.value.reasonCode, userId, appealId, parsed.value.decision],
          );
          return { userId };
        });
        return reply.send({ appealId, state: parsed.value.decision, userId: out.userId });
      } catch (err) {
        const e = err as { code?: number | string; message?: string };
        if (e.code === 404) return reply.code(404).send({ error: "appeal not found" });
        if (e.code === 409) return reply.code(409).send({ error: e.message });
        throw err;
      }
    },
  );

  // ------------------------------------------------------- user-facing ----
  // FR-53: the appeal path is always available, even to a removed account —
  // it sits outside the discovery surfaces. The body is screened like any
  // other free text (SEC-26); one open appeal per account (23505 → 409).
  app.post(
    "/v1/account/appeals",
    {
      schema: {
        body: {
          type: "object",
          required: ["body"],
          additionalProperties: false,
          properties: {
            body: { type: "string" },
            suspensionId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = parseAppealBody(req.body);
      if (!parsed.ok) {
        return reply.code(422).send({ error: "body must be 10–2000 characters" });
      }
      const findings = screenText(parsed.value.body);
      if (findings.length > 0) {
        return reply.code(422).send({ error: screeningErrorMessage(findings) });
      }
      try {
        const appealId = await withRls(ctx.pg, req.userId, async (c) => {
          if (parsed.value.suspensionId) {
            // The appeal must reference one of the user's own suspensions —
            // the RLS SELECT policy makes a foreign id simply invisible.
            const s = await c.query(
              "SELECT suspension_id FROM suspensions WHERE suspension_id = $1",
              [parsed.value.suspensionId],
            );
            if (s.rows.length === 0) {
              throw Object.assign(new Error("suspension not found"), { code: 404 });
            }
          }
          const r = await c.query(
            `INSERT INTO appeals (user_id, suspension_id, body)
             VALUES ($1, $2, $3) RETURNING appeal_id`,
            [req.userId, parsed.value.suspensionId ?? null, parsed.value.body],
          );
          return r.rows[0].appeal_id as string;
        });
        return reply.code(201).send({ appealId, state: "open" });
      } catch (err) {
        const e = err as { code?: number | string; message?: string };
        if (e.code === 404) return reply.code(404).send({ error: "suspension not found" });
        if (e.code === "23505") {
          // appeals_one_open — the path is always open but never spammable.
          return reply.code(409).send({ error: "you already have an open appeal (FR-53)" });
        }
        throw err;
      }
    },
  );

  app.get("/v1/account/appeals", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        `SELECT appeal_id, suspension_id, body, state, created_at, resolved_at, resolution_note
           FROM appeals WHERE user_id = $1
          ORDER BY created_at DESC`,
        [req.userId],
      ),
    );
    return reply.send({
      appeals: rows.rows.map((a) => ({
        appealId: a.appeal_id,
        suspensionId: a.suspension_id,
        body: a.body,
        state: a.state,
        createdAt: a.created_at,
        resolvedAt: a.resolved_at,
        resolutionNote: a.resolution_note,
      })),
    });
  });
}
