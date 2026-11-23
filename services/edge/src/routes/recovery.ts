/**
 * Account recovery phone routes (PRS-SRS-001 §4.1; SEC-09).
 *
 *   PUT    /v1/account/recovery-phone — register or replace the recovery
 *                                       number; only its keyed hash is stored
 *   GET    /v1/account/recovery-phone — { set: boolean }; the number itself
 *                                       (and its hash) is never returned
 *   DELETE /v1/account/recovery-phone — remove the recovery number
 *
 * The plaintext number exists only for the duration of the PUT handler:
 * it is normalised to E.164, hashed with the server-side HMAC key and
 * discarded. A hash already bound to another account gets the same neutral
 * 422 as a malformed number — registration elsewhere must not be probeable.
 */

import { FastifyInstance } from "fastify";
import { EdgeContext } from "../context.js";
import { withRls } from "../auth.js";
import { parseRecoveryBody, recoveryPhoneHash } from "../recovery.js";

/** SEC-09: one neutral rejection for malformed and unavailable numbers. */
const NEUTRAL_ERROR = "phone number is not accepted";

export function registerRecoveryRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.put(
    "/v1/account/recovery-phone",
    {
      // TR-23: strict body — unknown fields fail validation with a 400.
      schema: {
        body: {
          type: "object",
          required: ["phone"],
          additionalProperties: false,
          properties: { phone: { type: "string", maxLength: 32 } },
        },
      },
    },
    async (req, reply) => {
      const parsed = parseRecoveryBody(req.body);
      if (!parsed.ok) return reply.code(422).send({ error: NEUTRAL_ERROR });
      const hash = recoveryPhoneHash(parsed.e164);
      try {
        await withRls(ctx.pg, req.userId, (client) =>
          client.query(
            `INSERT INTO recovery_phones (user_id, phone_hash)
             VALUES (app_user(), $1)
             ON CONFLICT (user_id) DO UPDATE
                SET phone_hash = $1, updated_at = now()`,
            [hash],
          ),
        );
      } catch (e) {
        // phone_hash is UNIQUE platform-wide: a number already bound to
        // another account raises 23505. Answer with the same neutral error
        // as a malformed number — probing must learn nothing.
        if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
          return reply.code(422).send({ error: NEUTRAL_ERROR });
        }
        throw e;
      }
      return reply.send({ ok: true, set: true });
    },
  );

  app.get("/v1/account/recovery-phone", async (req, reply) => {
    // Existence only — never the digits, never the hash.
    const r = await withRls(ctx.pg, req.userId, (client) =>
      client.query("SELECT 1 FROM recovery_phones WHERE user_id = app_user()"),
    );
    return reply.send({ set: r.rows.length > 0 });
  });

  app.delete("/v1/account/recovery-phone", async (req, reply) => {
    // Idempotent owner-scoped delete, the same discipline as devices.
    await withRls(ctx.pg, req.userId, (client) =>
      client.query("DELETE FROM recovery_phones WHERE user_id = app_user()"),
    );
    return reply.send({ ok: true, set: false });
  });
}
