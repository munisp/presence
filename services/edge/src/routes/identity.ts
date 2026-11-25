/**
 * Identity assurance routes (SRS Addendum 001 — AMD-KYC / AMD-AVT).
 *
 *   GET  /v1/identity/status          — the requester's own assurance
 *     state: KYC status, avatar, and nothing else. AMD-KYC-04: KYC
 *     attributes are platform-side; this route is the only consumer read
 *     and it answers the owner alone.
 *   PUT  /v1/profile/avatar           — AMD-AVT-01/03: set the avatar to
 *     a curated registry key. Refused while any conversation is open and
 *     at most once per 24 h — a recognition anchor that shifts
 *     mid-negotiation is a confusion and evasion vector.
 *   POST /v1/moderation/kyc/:userId   — AMD-KYC-03/05: workforce review
 *     decision, gated by requireModerator and executed inside the
 *     app.moderator GUC; the record_kyc_decision definer enforces the
 *     legal transitions and writes the audit row.
 *
 * TR-23: strict bodies — unknown fields fail validation with a 400.
 */

import { FastifyInstance } from "fastify";
import { requireModerator, withModerator, withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import {
  AVATAR_CHANGE_COOLDOWN_MS,
  parseAvatarChoice,
  parseKycDecision,
} from "../identity.js";

export function registerIdentityRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get("/v1/identity/status", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        `SELECT u.kyc_state AS "kycState",
                u.kyc_verified_at AS "kycVerifiedAt",
                i.avatar_key AS "avatarKey",
                i.avatar_set_at AS "avatarSetAt"
           FROM users u
           LEFT JOIN user_identities i ON i.user_id = u.user_id
          WHERE u.user_id = $1`,
        [req.userId],
      ),
    );
    if (rows.rows.length === 0) {
      return reply.code(404).send({ error: "account not found" });
    }
    return reply.send(rows.rows[0]);
  });

  app.put(
    "/v1/profile/avatar",
    {
      schema: {
        body: {
          type: "object",
          required: ["avatarKey"],
          additionalProperties: false,
          properties: {
            avatarKey: { type: "string", minLength: 3, maxLength: 40 },
          },
        },
      },
    },
    async (req, reply) => {
      const choice = parseAvatarChoice(req.body);
      if (choice === null) {
        return reply.code(422).send({ error: "choose a symbol from the registry (AMD-AVT-01)" });
      }
      const result = await withRls(ctx.pg, req.userId, async (c) => {
        // AMD-AVT-03: locked while any conversation is open — the
        // counterpart recognises you by this symbol.
        const open = await c.query(
          `SELECT 1 FROM matches
            WHERE state = 'OPEN' AND $1 IN (user_lo, user_hi)
            LIMIT 1`,
          [req.userId],
        );
        if (open.rows.length > 0) return { status: 409 as const, reason: "open-conversation" };
        const current = await c.query(
          `SELECT avatar_key, avatar_set_at FROM user_identities WHERE user_id = $1`,
          [req.userId],
        );
        if (current.rows.length === 0) return { status: 404 as const };
        const row = current.rows[0] as { avatar_key: string | null; avatar_set_at: Date | null };
        if (row.avatar_key === choice.avatarKey) return { status: 200 as const, changed: false };
        if (
          row.avatar_set_at !== null &&
          ctx.clock.now() - row.avatar_set_at.getTime() < AVATAR_CHANGE_COOLDOWN_MS
        ) {
          return { status: 429 as const, reason: "cooldown" };
        }
        await c.query(
          `UPDATE user_identities
              SET avatar_key = $2, avatar_set_at = now(), updated_at = now()
            WHERE user_id = $1`,
          [req.userId, choice.avatarKey],
        );
        return { status: 200 as const, changed: true };
      });
      if (result.status === 409) {
        return reply.code(409).send({ error: "your symbol stays while a conversation is open (AMD-AVT-03)" });
      }
      if (result.status === 429) {
        return reply.code(429).send({ error: "your symbol can change at most once a day (AMD-AVT-03)" });
      }
      if (result.status === 404) {
        return reply.code(404).send({ error: "identity not set up yet (FR-06)" });
      }
      return reply.send({ avatarKey: choice.avatarKey, changed: result.changed });
    },
  );

  app.post(
    "/v1/moderation/kyc/:userId",
    {
      preHandler: requireModerator,
      schema: {
        body: {
          type: "object",
          required: ["decision"],
          additionalProperties: false,
          properties: {
            decision: { type: "string", enum: ["verified", "rejected", "suspended", "pending"] },
          },
        },
      },
    },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      const parsed = parseKycDecision(req.body);
      if (parsed === null) {
        return reply.code(422).send({ error: "decision must be a KYC state (AMD-KYC-03)" });
      }
      const outcome = await withModerator(ctx.pg, async (c) => {
        const r = await c.query(
          `SELECT record_kyc_decision($1, $2, $3, NULL) AS outcome`,
          [userId, req.userId, parsed.decision],
        );
        return (r.rows[0] as { outcome: string }).outcome;
      });
      if (outcome === "unknown_user") return reply.code(404).send({ error: "unknown user" });
      if (outcome === "illegal_transition") {
        return reply.code(409).send({ error: "illegal KYC transition (AMD-KYC-03)" });
      }
      if (outcome !== "recorded") return reply.code(403).send({ error: "forbidden" });
      return reply.send({ userId, kycState: parsed.decision });
    },
  );
}
