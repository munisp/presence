/**
 * WhatsApp channel routes (SRS Addendum 001 — AMD-WA-01..05).
 *
 * Member surface (registerWhatsAppRoutes — INSIDE the authed scope):
 *   GET    /v1/whatsapp         — the member's own opt-in state, minimal
 *     projection (phone always masked, never the verify digest).
 *   POST   /v1/whatsapp/link    — AMD-WA-03: link an E.164 phone: the row
 *     goes pending and a 6-digit verify code is sent via the verify_code
 *     template (10-minute TTL, 5 attempts, 60-second resend cooldown —
 *     the cooldown is enforced in the definer, not here).
 *   POST   /v1/whatsapp/verify  — redeem the code; the opt-in goes active.
 *   DELETE /v1/whatsapp/link    — unlink: the row goes stopped and no
 *     WhatsApp notice is ever sent to it again.
 *
 * Webhook surface (registerWhatsAppWebhookRoutes — OUTSIDE the authed
 * scope, the AMD-PAY-16 discipline): the caller is Meta, authenticated by
 * the verify token (GET handshake) or the X-Hub-Signature-256 HMAC over
 * the RAW body (POST intake), never a user token. Inbound text is NEVER
 * stored — the parser reduces a message to its keyword (AMD-WA-02) and
 * the ledger records keyword + phone only. Meta retries any non-2xx, so
 * after signature and JSON validation the intake ALWAYS answers 200;
 * idempotency is the wamid primary key in the definer.
 */

import { FastifyInstance } from "fastify";
import { withRls, withWhatsAppCallback } from "../auth.js";
import { EdgeContext } from "../context.js";
import { whatsappWebhookResults } from "../metrics.js";
import {
  maskPhone,
  mintVerifyCode,
  normalizePhoneE164,
  parseInboundKeyword,
  parseVerifyHandshake,
  parseWebhookEnvelope,
  VERIFY_CODE_RE,
  WHATSAPP_VERIFY_CODE_TTL_MS,
  verifyCodeDigest,
  webhookSignatureValid,
  whatsappSenderFromEnv,
} from "../whatsapp.js";

const WEBHOOK_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;
const LINK_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

/** AMD-WA-02: the Meta webhook — verify handshake + signed intake. */
export function registerWhatsAppWebhookRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get(
    "/v1/webhooks/whatsapp",
    { config: { rateLimit: WEBHOOK_RATE_LIMIT } },
    async (req, reply) => {
      const token = process.env.WHATSAPP_VERIFY_TOKEN;
      if (!token) {
        whatsappWebhookResults().inc({ result: "unconfigured" });
        return reply.code(503).send({ error: "whatsapp webhook not configured (AMD-WA-02)" });
      }
      const handshake = parseVerifyHandshake(req.query);
      if (handshake === null || handshake.mode !== "subscribe") {
        whatsappWebhookResults().inc({ result: "rejected" });
        return reply.code(400).send({ error: "malformed verify handshake" });
      }
      if (handshake.verifyToken !== token) {
        whatsappWebhookResults().inc({ result: "rejected" });
        return reply.code(403).send({ error: "verify token mismatch" });
      }
      whatsappWebhookResults().inc({ result: "accepted" });
      return reply.type("text/plain").send(handshake.challenge);
    },
  );

  // The signature is over the RAW body, so this scope parses
  // application/json to a Buffer; the handler validates the HMAC first
  // and parses the JSON itself afterwards.
  app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    scope.post(
      "/v1/webhooks/whatsapp",
      { config: { rateLimit: WEBHOOK_RATE_LIMIT } },
      async (req, reply) => {
        const secret = process.env.WHATSAPP_APP_SECRET;
        if (!secret) {
          whatsappWebhookResults().inc({ result: "unconfigured" });
          return reply.code(503).send({ error: "whatsapp webhook not configured (AMD-WA-02)" });
        }
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
        if (!webhookSignatureValid(secret, raw, req.headers["x-hub-signature-256"])) {
          whatsappWebhookResults().inc({ result: "rejected" });
          return reply.code(401).send({ error: "bad signature" });
        }
        let doc: unknown;
        try {
          doc = JSON.parse(raw.toString("utf8"));
        } catch {
          whatsappWebhookResults().inc({ result: "rejected" });
          return reply.code(400).send({ error: "invalid json" });
        }
        const envelope = parseWebhookEnvelope(doc);
        for (const msg of envelope.messages) {
          await withWhatsAppCallback(ctx.pg, async (c) =>
            c.query("SELECT whatsapp_apply_inbound($1, $2, $3, to_timestamp($4)) AS outcome", [
              msg.wamid,
              msg.phone,
              msg.keyword,
              msg.receivedAt,
            ]),
          );
        }
        for (const st of envelope.statuses) {
          await withWhatsAppCallback(ctx.pg, async (c) =>
            c.query("SELECT whatsapp_apply_status($1, $2, $3) AS outcome", [
              st.wamid,
              st.status,
              st.errorCode,
            ]),
          );
        }
        // Meta redelivers on any non-2xx: accepted means PERSISTED, and
        // duplicates collapse on the wamid inside the definers.
        whatsappWebhookResults().inc({ result: "accepted" });
        return reply.send({ ok: true });
      },
    );
  });
}

/** AMD-WA-03: the member opt-in surface — INSIDE the authed scope. */
export function registerWhatsAppRoutes(app: FastifyInstance, ctx: EdgeContext): void {
  app.get("/v1/whatsapp", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query(
        `SELECT state, phone_e164, linked_at, verified_at
           FROM whatsapp_opt_ins
          WHERE user_id = current_setting('app.user_id', true)::uuid`,
      ),
    );
    if (rows.rows.length === 0) return reply.send({ linked: false });
    const row = rows.rows[0] as {
      state: string;
      phone_e164: string;
      linked_at: string;
      verified_at: string | null;
    };
    return reply.send({
      linked: true,
      state: row.state,
      phone: maskPhone(row.phone_e164),
      linkedAt: row.linked_at,
      verifiedAt: row.verified_at,
    });
  });

  app.post(
    "/v1/whatsapp/link",
    {
      config: { rateLimit: LINK_RATE_LIMIT },
      schema: {
        body: {
          type: "object",
          required: ["phone"],
          additionalProperties: false,
          properties: { phone: { type: "string", minLength: 8, maxLength: 20 } },
        },
      },
    },
    async (req, reply) => {
      const phone = normalizePhoneE164((req.body as { phone: unknown }).phone);
      if (phone === null) {
        return reply.code(400).send({ error: "phone must be E.164 (+, 8-15 digits)" });
      }
      const now = ctx.clock.now();
      const code = mintVerifyCode();
      const digest = verifyCodeDigest(req.userId, code);
      const expires = new Date(now + WHATSAPP_VERIFY_CODE_TTL_MS).toISOString();
      const rows = await withRls(ctx.pg, req.userId, async (c) =>
        c.query("SELECT whatsapp_link_phone($1, $2, $3, $4) AS outcome", [
          phone,
          digest,
          expires,
          new Date(now).toISOString(),
        ]),
      );
      const outcome = (rows.rows[0] as { outcome: string }).outcome;
      if (outcome === "cooldown") {
        return reply.code(429).send({ error: "a code was sent less than a minute ago" });
      }
      if (outcome === "phone_in_use") {
        return reply.code(409).send({ error: "that phone is linked to another account" });
      }
      if (outcome !== "linked") {
        return reply.code(403).send({ error: outcome });
      }
      // The verify-code send is NOT a deliveries-ledger entry: it is
      // tracked on the opt-in row (sent_at) and in the event log.
      const sender = whatsappSenderFromEnv();
      const send = sender ? await sender(phone, "verify_code", { code }) : null;
      const devEcho = process.env.WHATSAPP_DEV_ECHO === "1";
      return reply.code(202).send({
        ok: true,
        state: "pending",
        verification: send
          ? { sent: send.sent, ...(send.reason ? { reason: send.reason } : {}) }
          : { sent: false, reason: "unconfigured" },
        // Compose/dev only: the echo sender never leaves the process, so
        // handing the code back keeps the flow walkable without Meta
        // credentials. NEVER present where WHATSAPP_DEV_ECHO is unset.
        ...(devEcho ? { devCode: code } : {}),
      });
    },
  );

  app.post(
    "/v1/whatsapp/verify",
    {
      config: { rateLimit: LINK_RATE_LIMIT },
      schema: {
        body: {
          type: "object",
          required: ["code"],
          additionalProperties: false,
          properties: { code: { type: "string", minLength: 6, maxLength: 6 } },
        },
      },
    },
    async (req, reply) => {
      const code = (req.body as { code: unknown }).code;
      if (typeof code !== "string" || !VERIFY_CODE_RE.test(code)) {
        return reply.code(400).send({ error: "code must be six digits" });
      }
      const digest = verifyCodeDigest(req.userId, code);
      const rows = await withRls(ctx.pg, req.userId, async (c) =>
        c.query("SELECT whatsapp_verify_code($1, $2) AS outcome", [
          digest,
          new Date(ctx.clock.now()).toISOString(),
        ]),
      );
      const outcome = (rows.rows[0] as { outcome: string }).outcome;
      if (outcome === "verified") return reply.send({ ok: true, state: "active" });
      if (outcome === "mismatch") return reply.code(400).send({ error: "code mismatch" });
      if (outcome === "expired") return reply.code(410).send({ error: "code expired — request a new one" });
      if (outcome === "attempts_exceeded") {
        return reply.code(429).send({ error: "too many attempts — request a new code" });
      }
      if (outcome === "not_pending") {
        return reply.code(409).send({ error: "no pending verification" });
      }
      return reply.code(403).send({ error: outcome });
    },
  );

  app.delete("/v1/whatsapp/link", async (req, reply) => {
    const rows = await withRls(ctx.pg, req.userId, async (c) =>
      c.query("SELECT whatsapp_unlink($1) AS outcome", [
        new Date(ctx.clock.now()).toISOString(),
      ]),
    );
    const outcome = (rows.rows[0] as { outcome: string }).outcome;
    if (outcome === "unlinked") return reply.send({ ok: true });
    if (outcome === "not_linked") return reply.code(404).send({ error: "no whatsapp link" });
    return reply.code(403).send({ error: outcome });
  });
}

// Re-exported for the contract pins: the webhook parser surface a test
// may rely on without standing the server up.
export { parseInboundKeyword };
