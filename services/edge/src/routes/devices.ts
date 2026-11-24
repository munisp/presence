/**
 * Device routes (PRS-SRS-001 §4) — FR-05 enrolment, FR-07 dedupe signal.
 *
 *   POST   /v1/devices            — enrol a device (attestation-gated);
 *                                   registers the attestation key hash and
 *                                   enforces the three-device cap
 *   GET    /v1/devices            — my enrolled devices
 *   DELETE /v1/devices/:deviceId  — revoke one of mine; idempotent
 *
 * FR-07 shapes the enrolment response: register_attestation_key() reports
 * enrolled / refreshed / duplicate, but the client always sees the same
 * neutral 201. A duplicate is a moderator signal, never a client one — a
 * caller probing stolen keys must learn nothing from the response.
 */

import { FastifyInstance } from "fastify";
import { withRls } from "../auth.js";
import { EdgeContext, publishRealtime } from "../context.js";
import {
  DEVICE_LABEL_MAX_LEN,
  attestationKeyHash,
  deviceFingerprint,
  parseDeviceBody,
} from "../devices.js";
import { recordSecurityEvent } from "../security.js";
import { screenText } from "../screening.js";

export function registerDeviceRoutes(app: FastifyInstance, ctx: EdgeContext): void {
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
      if (typeof assertion !== "string" || assertion.length === 0) {
        // P0: assertion presence only; cryptographic verification lands with
        // the attestation milestone (same gate as presence publishing).
        // SEC-30: the refusal is recorded for abuse review.
        recordSecurityEvent(ctx.pg, "missing_attestation", req.userId, { surface: "device_enrol" });
        return reply.code(401).send({ error: "missing app attestation" });
      }
      const parsed = parseDeviceBody(req.body, screenText);
      if (!parsed.ok) return reply.code(422).send({ error: parsed.error });

      const userId = req.userId;
      const keyHash = attestationKeyHash(assertion);
      const fingerprint = deviceFingerprint(userId, assertion);

      try {
        const enrolled = await withRls(ctx.pg, userId, async (client) => {
          // FR-07: register the key first — a collision is recorded and
          // audited inside the function; the outcome never leaves the server.
          const reg = await client.query("SELECT register_attestation_key($1, $2::uuid) AS outcome", [
            keyHash,
            userId,
          ]);
          const outcome = reg.rows[0]?.outcome as string;
          if (outcome === "duplicate") {
            // SEC-30: a key registered to another account is a
            // security-relevant signal for abuse review (admin_audit already
            // carries the FR-60 ops record inside register_attestation_key).
            recordSecurityEvent(ctx.pg, "attestation_key_duplicate", userId, {
              keyHashPrefix: keyHash.slice(0, 8),
            });
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

        // FR-05: enrolment notice on the user's own channel — the label is
        // the only device detail; the fingerprint never leaves the server.
        await publishRealtime(ctx, `user:${userId}`, {
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
    await withRls(ctx.pg, req.userId, async (client) => {
      await client.query(
        `UPDATE devices SET revoked_at = now()
         WHERE device_id = $1::uuid AND user_id = $2 AND revoked_at IS NULL`,
        [deviceId, req.userId],
      );
    });
    return reply.send({ ok: true });
  });

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
