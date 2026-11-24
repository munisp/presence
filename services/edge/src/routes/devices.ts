/**
 * Device routes (PRS-SRS-001 §4) — FR-05 enrolment, FR-07 dedupe signal,
 * FR-51/SEC-19 verified attestation, FR-56 push tokens, SEC-02 revocation.
 *
 *   POST   /v1/devices            — enrol a device (attestation-gated);
 *                                   registers the attestation key hash and
 *                                   enforces the three-device cap
 *   POST   /v1/devices/attestation-challenge
 *                                 — mint the single-use challenge the
 *                                   verified enrolment signs
 *   GET    /v1/devices            — my enrolled devices
 *   DELETE /v1/devices/:deviceId  — revoke one of mine; idempotent, and
 *                                   denies the device's sessions at once
 *   PUT    /v1/devices/:deviceId/push-token
 *                                 — register the device's APNs/FCM token
 *
 * FR-07 shapes the enrolment response: register_attestation_key() reports
 * enrolled / refreshed / duplicate, but the client always sees the same
 * neutral 201. A duplicate is a moderator signal, never a client one — a
 * caller probing stolen keys must learn nothing from the response.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext } from "../context.js";
import { notifyUser } from "../notifications.js";
import {
  DEVICE_LABEL_MAX_LEN,
  attestationKeyHash,
  deviceFingerprint,
  parseDeviceBody,
} from "../devices.js";
import {
  ATTESTATION_CHALLENGE_TTL_S,
  attestedKeyHash,
  challengeKey,
  mintChallenge,
  parseAttestationBody,
  verifyAssertion,
} from "../attestation.js";
import { PUSH_TOKEN_RE } from "../push.js";
import { revokeDeviceAccess } from "../revocation.js";
import { recordSecurityEvent } from "../security.js";
import { screenText } from "../screening.js";

export function registerDeviceRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  // FR-51/SEC-19: the verified enrolment signs this single-use challenge.
  app.post("/v1/devices/attestation-challenge", async (req, reply) => {
    const challenge = mintChallenge();
    await ctx.valkey.set(
      challengeKey(req.userId),
      challenge,
      "EX",
      ATTESTATION_CHALLENGE_TTL_S,
    );
    return reply.send({ challenge, ttl: ATTESTATION_CHALLENGE_TTL_S });
  });

  app.post(
    "/v1/devices",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { label: { type: "string", maxLength: DEVICE_LABEL_MAX_LEN } },
        },
      },
    },
    async (req, reply) => {
      const assertion = req.headers["x-app-attest-assertion"];
      // FR-51/SEC-19: a body `attestation` object takes the verified path —
      // challenge-bound, signature-checked, counter-monotonic. Without it
      // the legacy header gate applies: presence of the assertion only, and
      // the account stays discovery-ineligible until it verifies.
      const rawAttestation = (req.body as Record<string, unknown> | null | undefined)?.attestation;
      let verified: { platform: string; publicKey: string; counter: number; signature: string } | null = null;
      if (rawAttestation !== undefined && rawAttestation !== null) {
        const parsedAtt = parseAttestationBody(rawAttestation);
        if (!parsedAtt.ok) return reply.code(422).send({ error: parsedAtt.error });
        verified = parsedAtt.value;
      }
      if (typeof assertion !== "string" || assertion.length === 0) {
        if (verified === null) {
          // SEC-30: the refusal is recorded for abuse review.
          recordSecurityEvent(ctx.pg, "missing_attestation", req.userId, { surface: "device_enrol" });
          return reply.code(401).send({ error: "missing app attestation" });
        }
      }
      const parsed = parseDeviceBody(req.body, screenText);
      if (!parsed.ok) return reply.code(422).send({ error: parsed.error });

      const userId = req.userId;
      let keyHash: string;
      let fingerprint: string;
      if (verified !== null) {
        // The challenge is single-use: consumed before any crypto work, so a
        // replayed assertion can never validate twice.
        const challenge = await ctx.valkey.getdel(challengeKey(userId));
        if (
          challenge === null ||
          !verifyAssertion(verified.publicKey, challenge, userId, verified.signature)
        ) {
          return reply.code(401).send({ error: "invalid attestation" });
        }
        keyHash = attestedKeyHash(verified.publicKey);
        fingerprint = deviceFingerprint(userId, verified.publicKey);
      } else {
        keyHash = attestationKeyHash(assertion as string);
        fingerprint = deviceFingerprint(userId, assertion as string);
      }

      try {
        const enrolled = await withRls(ctx.pg, userId, async (client) => {
          // FR-07: register the key first — a collision is recorded and
          // audited inside the function; the outcome never leaves the server.
          const reg = verified !== null
            ? await client.query(
                "SELECT register_verified_attestation($1, $2::uuid, $3, $4, $5) AS outcome",
                [keyHash, userId, verified.platform, verified.publicKey, verified.counter],
              )
            : await client.query("SELECT register_attestation_key($1, $2::uuid) AS outcome", [
                keyHash,
                userId,
              ]);
          const outcome = reg.rows[0]?.outcome as string;
          if (outcome === "duplicate") {
            // SEC-30: a key registered to another account is a
            // security-relevant signal for abuse review (admin_audit already
            // carries the FR-60 ops record inside the registry function).
            recordSecurityEvent(ctx.pg, "attestation_key_duplicate", userId, {
              keyHashPrefix: keyHash.slice(0, 8),
            });
          }
          if (outcome === "counter_regressed") {
            // SEC-19: a replayed counter is refused — same neutral response
            // shape as any other failed assertion.
            return null;
          }
          // FR-05: the device_cap trigger rejects a fourth active device
          // under a row lock; the partial unique index makes a revoked row
          // re-enrollable under the same fingerprint.
          const ins = await client.query(
            `INSERT INTO devices (user_id, label, key_fingerprint)
             VALUES ($1, $2, $3)
             ON CONFLICT (key_fingerprint) WHERE revoked_at IS NULL
             DO UPDATE SET last_seen_at = now()
             RETURNING device_id, enrolled_at`,
            [userId, parsed.label, fingerprint],
          );
          return ins.rows[0] as { device_id: string; enrolled_at: string };
        });

        if (enrolled === null) {
          return reply.code(401).send({ error: "invalid attestation" });
        }

        // FR-05: enrolment notice on the user's own channel — the label is
        // the only device detail; the fingerprint never leaves the server.
        // FR-58: this is an own-account safety notice — always delivered.
        await notifyUser(ctx, userId, "safety", {
          type: "device_enrolled",
          deviceId: enrolled.device_id,
          label: parsed.label,
        }).catch((err) => console.error("device enrolment notice failed", err));

        return reply.code(201).send({ deviceId: enrolled.device_id, enrolledAt: enrolled.enrolled_at });
      } catch (err) {
        const e = err as { code?: number | string; message?: string };
        if (typeof e.message === "string" && e.message.includes("device limit reached")) {
          return reply.code(409).send({ error: "device limit reached; revoke a device first (FR-05)" });
        }
        throw err;
      }
    },
  );

  app.get("/v1/devices", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (client) => {
      const res = await client.query(
        `SELECT device_id, label, enrolled_at, last_seen_at, revoked_at
         FROM devices
         WHERE user_id = $1
         ORDER BY enrolled_at ASC`,
        [req.userId],
      );
      return res.rows as Array<{
        device_id: string;
        label: string | null;
        enrolled_at: string;
        last_seen_at: string;
        revoked_at: string | null;
      }>;
    });
    return reply.send({
      devices: rows.map((r) => ({
        deviceId: r.device_id,
        label: r.label,
        enrolledAt: r.enrolled_at,
        lastSeenAt: r.last_seen_at,
        revokedAt: r.revoked_at,
      })),
    });
  });

  app.delete("/v1/devices/:deviceId", async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string };
    // FR-05: revocation is idempotent and scoped to the caller's own rows —
    // the RLS check makes a foreign device_id a silent no-op, same as a
    // second revoke.
    const revoked = await withRls(ctx.pg, req.userId, async (client) => {
      const res = await client.query(
        `UPDATE devices SET revoked_at = now()
         WHERE device_id = $1::uuid AND user_id = $2 AND revoked_at IS NULL
         RETURNING device_id`,
        [deviceId, req.userId],
      );
      return res.rows.length;
    });
    // SEC-02: a revoked device loses access immediately — the denylist write
    // happens before the reply, so the 60-second revocation budget is met by
    // construction (measured by scripts/revocation_drill.py).
    if (revoked > 0) {
      await revokeDeviceAccess(ctx, req.userId, deviceId);
    }
    return reply.send({ ok: true });
  });

  // FR-56: register the device's APNs/FCM delivery token. Owner-only under
  // RLS; the dispatch path reads through push_tokens_for().
  app.put(
    "/v1/devices/:deviceId/push-token",
    {
      schema: {
        body: {
          type: "object",
          required: ["platform", "token"],
          additionalProperties: false,
          properties: {
            platform: { type: "string", enum: ["ios", "android"] },
            token: { type: "string", maxLength: 512 },
          },
        },
      },
    },
    async (req, reply) => {
      const { deviceId } = req.params as { deviceId: string };
      const { platform, token } = req.body as { platform: string; token: string };
      if (!PUSH_TOKEN_RE.test(token)) {
        return reply.code(422).send({ error: "token is not a plausible push token" });
      }
      try {
        const written = await withRls(ctx.pg, req.userId, async (client) => {
          // The device must be one of mine and live — a foreign or revoked
          // device id is a neutral 404.
          const owns = await client.query(
            "SELECT 1 FROM devices WHERE device_id = $1::uuid AND user_id = $2 AND revoked_at IS NULL",
            [deviceId, req.userId],
          );
          if (owns.rows.length === 0) return 0;
          await client.query(
            `INSERT INTO device_push_tokens (device_id, user_id, platform, token)
             VALUES ($1::uuid, $2, $3, $4)
             ON CONFLICT (device_id)
             DO UPDATE SET platform = EXCLUDED.platform, token = EXCLUDED.token, updated_at = now()`,
            [deviceId, req.userId, platform, token],
          );
          return 1;
        });
        if (written === 0) return reply.code(404).send({ error: "device not found" });
        return reply.send({ ok: true });
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "23505") {
          // The token is already bound to another device row.
          return reply.code(409).send({ error: "push token already registered" });
        }
        throw err;
      }
    },
  );

  // SEC-36: the client detected the platform mock-location flag and refused
  // to publish presence; the refusal is recorded server-side for abuse
  // review. It is never disclosed to other users — the only read path is
  // the moderation console's security-events view (moderator GUC).
  app.post(
    "/v1/devices/mock-location-refusal",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            platform: { type: "string", enum: ["android", "ios"] },
          },
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { platform?: string };
      recordSecurityEvent(ctx.pg, "mock_location_refusal", req.userId, {
        platform: body.platform ?? "unknown",
      });
      return reply.code(202).send({ recorded: true });
    },
  );
}
