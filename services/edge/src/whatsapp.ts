/**
 * AMD-WA-01..06 (SRS Addendum 001, batch 69): the WhatsApp channel.
 *
 * The platform meets members where they already are: on low-end devices,
 * shared handsets and 2G links, WhatsApp is the always-on surface. This
 * module is the channel CONTRACT — the pure half with no I/O of its own:
 *
 *   AMD-WA-01  phone addressing (E.164), the governed template catalogue
 *              and the payload-minimalism gate (the FR-56 discipline,
 *              extended to a richer channel: template sends carry NO free
 *              text, no profile content and no counterpart identity — the
 *              single parameter allowed anywhere in the catalogue is the
 *              six-digit verification code)
 *   AMD-WA-02  the webhook contract: the Meta verify handshake and the
 *              X-Hub-Signature-256 HMAC over the RAW body, plus a tolerant
 *              envelope parser that reduces every delivery to {wamid,
 *              phone, keyword} or {wamid, status} — the inbound message
 *              text itself is NEVER stored, only the keyword it maps to
 *   AMD-WA-03  the opt-in vocabulary and the verification-code contract
 *              (6 digits, 10-minute TTL, 5 attempts, 60-second resend
 *              cooldown; the digest stored server-side is salted by the
 *              user id so a database read alone cannot replay a code)
 *   AMD-WA-04  the outbound dispatcher: template-only sends through the
 *              Cloud API, env-gated (no credentials = a documented no-op,
 *              never a crash), a per-user daily cap, and the notification
 *              leg that hangs off notifyUser and the consent call sites
 *   AMD-WA-05  privacy: phone masking for logs, keyword-only inbound
 *              storage, and a channel state that a revoked member always
 *              wins — a stopped member receives safety notices on the
 *              remaining channels (realtime + push), never a forced
 *              WhatsApp message (the FR-58 exemption governs category
 *              switches, it does not resurrect a revoked channel)
 *
 * The route half lives in routes/whatsapp.ts; the database half in
 * db/migrations/0039_whatsapp.sql.
 */

import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// AMD-WA-01: phone addressing — E.164, nothing else.
// ---------------------------------------------------------------------------

/** E.164: "+", a non-zero lead digit, 7..14 further digits (8..15 total). */
export const E164_RE = /^\+[1-9]\d{7,14}$/;

/**
 * Normalize user input to E.164. Accepts the international form with
 * optional spaces, dashes and parentheses, and the "00" international
 * prefix; anything else — short codes, local formats without a country
 * code, letters — is rejected (null), never guessed.
 */
export function normalizePhoneE164(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/[\s()\-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!E164_RE.test(s)) return null;
  return s;
}

/**
 * Mask a phone for logs and operator surfaces: country-code prefix and
 * last four survive, the middle is dropped ("+234****5678"). Anything
 * shorter than 9 characters is masked wholesale.
 */
export function maskPhone(phone: string): string {
  if (phone.length < 9) return "+****";
  return `${phone.slice(0, 4)}****${phone.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// AMD-WA-03: the opt-in vocabulary (mirrored in 0039_whatsapp.sql CHECKs).
// ---------------------------------------------------------------------------

export const WHATSAPP_OPT_IN_STATES = ["pending", "active", "stopped"] as const;
export type WhatsAppOptInState = (typeof WHATSAPP_OPT_IN_STATES)[number];

export function isWhatsAppOptInState(v: unknown): v is WhatsAppOptInState {
  return typeof v === "string" && (WHATSAPP_OPT_IN_STATES as readonly string[]).includes(v);
}

/** The append-only opt-in ledger vocabulary (mirrored in the migration). */
export const WHATSAPP_OPT_IN_EVENTS = [
  "link_requested",
  "verified",
  "verify_failed",
  "unlinked",
  "stopped_inbound",
  "resumed_inbound",
  "help_requested",
] as const;
export type WhatsAppOptInEvent = (typeof WHATSAPP_OPT_IN_EVENTS)[number];

/** The verification-code contract. */
export const WHATSAPP_VERIFY_CODE_TTL_MS = 600_000; // 10 minutes
export const WHATSAPP_VERIFY_MAX_ATTEMPTS = 5;
export const WHATSAPP_RESEND_COOLDOWN_MS = 60_000;

/** Mint a six-digit verification code. The rng is injectable for tests. */
export function mintVerifyCode(rng: (upper: number) => number = randomInt): string {
  return rng(1_000_000).toString().padStart(6, "0");
}

/**
 * The stored verification digest: sha256 of "<userId>:<code>". Salting by
 * the user id means a database read alone yields no replayable code, and
 * the online path is capped at WHATSAPP_VERIFY_MAX_ATTEMPTS.
 */
export function verifyCodeDigest(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

/** The code shape a member submits. */
export const VERIFY_CODE_RE = /^\d{6}$/;

// ---------------------------------------------------------------------------
// AMD-WA-01: the governed template catalogue and the minimalism gate.
// ---------------------------------------------------------------------------

/**
 * Every template the channel may send. Names match the pre-approved
 * templates registered with Meta; the params list is exhaustive — a send
 * carrying anything else is refused before it leaves the process.
 */
export const WHATSAPP_TEMPLATES = {
  verify_code: { name: "presence_verify_code", params: ["code"] },
  match_notice: { name: "presence_match_notice", params: [] },
  pair_opened: { name: "presence_pair_opened", params: [] },
  announcement_notice: { name: "presence_announcement", params: [] },
  safety_notice: { name: "presence_safety", params: [] },
} as const;

export type WhatsAppTemplateKey = keyof typeof WHATSAPP_TEMPLATES;

export function isWhatsAppTemplateKey(v: unknown): v is WhatsAppTemplateKey {
  return typeof v === "string" && v in WHATSAPP_TEMPLATES;
}

/**
 * Which realtime event becomes which template. The map is deliberately
 * closed: a notification type with no entry simply does not travel over
 * WhatsApp (it stays realtime/push-only). Static-text templates only —
 * no member content, no counterpart identity, no free text.
 */
export const NOTIFICATION_TEMPLATE_MAP: Readonly<Record<string, WhatsAppTemplateKey>> = {
  "nudges:nudged": "match_notice",
  "matches:mutual": "match_notice",
  "matches:open": "pair_opened",
};

export const CATEGORY_TEMPLATE_MAP: Readonly<Record<string, WhatsAppTemplateKey>> = {
  announcements: "announcement_notice",
  safety: "safety_notice",
};

export function templateKeyForNotification(
  category: string,
  type: string,
): WhatsAppTemplateKey | null {
  return (
    NOTIFICATION_TEMPLATE_MAP[`${category}:${type}`] ??
    CATEGORY_TEMPLATE_MAP[category] ??
    null
  );
}

/**
 * AMD-WA-01: the payload-minimalism gate. A template send is admissible
 * only when the template is in the catalogue and the parameters are
 * EXACTLY the declared ones — the verify code is the only parameter that
 * exists anywhere in the catalogue, and it must be six digits.
 */
export function assertTemplateSend(
  templateKey: unknown,
  params: Record<string, unknown>,
): boolean {
  if (!isWhatsAppTemplateKey(templateKey)) return false;
  const declared = WHATSAPP_TEMPLATES[templateKey].params as readonly string[];
  const keys = Object.keys(params);
  if (keys.length !== declared.length) return false;
  for (const key of declared) {
    if (!(key in params)) return false;
  }
  if ("code" in params && !VERIFY_CODE_RE.test(String(params.code))) return false;
  return true;
}

/** Build the Cloud API template-send body for an admissible send. */
export function buildTemplateSendBody(
  toPhone: string,
  templateKey: WhatsAppTemplateKey,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const template = WHATSAPP_TEMPLATES[templateKey];
  const declared = template.params as readonly string[];
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "template",
    template: { name: template.name, language: { code: "en" } },
  };
  if (declared.length > 0) {
    (body.template as Record<string, unknown>).components = [
      {
        type: "body",
        parameters: declared.map((key) => ({ type: "text", text: String(params[key]) })),
      },
    ];
  }
  return body;
}

// ---------------------------------------------------------------------------
// AMD-WA-04: the dispatcher contract.
// ---------------------------------------------------------------------------

/** Per-user daily cap on channel sends — template messages cost money. */
export const WHATSAPP_DAILY_CAP = 20;
export const WHATSAPP_TIMEOUT_MS = 10_000;
export const WHATSAPP_GRAPH_VERSION = "v21.0";
export const WHATSAPP_GRAPH_BASE = "https://graph.facebook.com";

export interface WhatsAppSendResult {
  sent: boolean;
  wamid?: string;
  reason?: string;
}

/** A sender takes one admissible template send to the wire (or doesn't). */
export type WhatsAppSender = (
  toPhone: string,
  templateKey: WhatsAppTemplateKey,
  params: Record<string, unknown>,
) => Promise<WhatsAppSendResult>;

/**
 * The dev-echo sender (WHATSAPP_DEV_ECHO=1, compose only — NEVER set in
 * any deployed environment): the send "succeeds" locally with a synthetic
 * wamid, so the whole member flow is walkable without Meta credentials.
 */
export function devEchoSender(): WhatsAppSender {
  return async (_toPhone, templateKey, params) => {
    if (!assertTemplateSend(templateKey, params)) {
      return { sent: false, reason: "template contract" };
    }
    return { sent: true, wamid: `dev-echo-${randomInt(1_000_000_000)}` };
  };
}

/**
 * The Cloud API sender: POST {phone-number-id}/messages with the bearer
 * token, pinned timeout, wamid lifted from messages[0].id. A non-2xx or a
 * network failure returns sent:false with a reason — dispatch never throws.
 */
export function cloudApiSender(accessToken: string, phoneNumberId: string): WhatsAppSender {
  return async (toPhone, templateKey, params) => {
    // The minimalism gate every send passes through (FR-56 analogue): an
    // undeclared template or parameter NEVER reaches the wire.
    if (!assertTemplateSend(templateKey, params)) {
      return { sent: false, reason: "template contract" };
    }
    try {
      const res = await fetch(
        `${WHATSAPP_GRAPH_BASE}/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(buildTemplateSendBody(toPhone, templateKey, params)),
          signal: AbortSignal.timeout(WHATSAPP_TIMEOUT_MS),
        },
      );
      if (!res.ok) return { sent: false, reason: `http ${res.status}` };
      const doc = (await res.json()) as { messages?: { id?: unknown }[] };
      const wamid = doc.messages?.[0]?.id;
      return { sent: true, wamid: typeof wamid === "string" ? wamid : undefined };
    } catch {
      return { sent: false, reason: "unreachable" };
    }
  };
}

/**
 * Resolve the sender from the environment: dev echo first (compose),
 * then real Cloud API credentials, then null — the documented no-op.
 */
export function whatsappSenderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppSender | null {
  if (env.WHATSAPP_DEV_ECHO === "1") return devEchoSender();
  const token = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (token && phoneNumberId) return cloudApiSender(token, phoneNumberId);
  return null;
}

// ---------------------------------------------------------------------------
// AMD-WA-02: the webhook contract.
// ---------------------------------------------------------------------------

/** The verify handshake query (Meta's GET subscription challenge). */
export interface VerifyHandshake {
  mode: string;
  verifyToken: string;
  challenge: string;
}

export function parseVerifyHandshake(query: unknown): VerifyHandshake | null {
  if (query === null || typeof query !== "object") return null;
  const q = query as Record<string, unknown>;
  const mode = q["hub.mode"];
  const verifyToken = q["hub.verify_token"];
  const challenge = q["hub.challenge"];
  if (
    typeof mode !== "string" ||
    typeof verifyToken !== "string" ||
    typeof challenge !== "string"
  ) {
    return null;
  }
  return { mode, verifyToken, challenge };
}

/**
 * The intake signature: X-Hub-Signature-256 carries "sha256=<64 lowercase
 * hex>", the HMAC-SHA256 of the RAW request body under the app secret.
 * A missing or malformed header refuses; the compare is constant-time.
 */
export function webhookSignatureValid(
  appSecret: string,
  rawBody: Buffer,
  header: unknown,
): boolean {
  if (typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(header.slice("sha256=".length), "utf8"),
  );
}

// ---------------------------------------------------------------------------
// AMD-WA-02/05: inbound keywords — the only thing retained from a message.
// ---------------------------------------------------------------------------

export const WHATSAPP_INBOUND_KEYWORDS = ["stop", "start", "help", "other"] as const;
export type WhatsAppInboundKeyword = (typeof WHATSAPP_INBOUND_KEYWORDS)[number];

/** WhatsApp's opt-out lexicon (Meta's required keywords, lower-cased). */
export const STOP_LEXICON = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
export const START_LEXICON = new Set(["start", "unstop"]);
export const HELP_LEXICON = new Set(["help", "info"]);

/**
 * Map an inbound message body to a keyword: exact single-token match
 * after trim + case-fold. "STOP IT" is conversation, not an opt-out —
 * only the canonical tokens act.
 */
export function parseInboundKeyword(text: unknown): WhatsAppInboundKeyword {
  if (typeof text !== "string") return "other";
  const t = text.trim().toLowerCase();
  if (STOP_LEXICON.has(t)) return "stop";
  if (START_LEXICON.has(t)) return "start";
  if (HELP_LEXICON.has(t)) return "help";
  return "other";
}

// ---------------------------------------------------------------------------
// AMD-WA-02: the tolerant envelope parser.
// ---------------------------------------------------------------------------

/**
 * The delivery-ledger vocabulary. `pending` is internal-only: a reserved
 * slot whose send outcome is not yet known (the daily cap and the dedupe
 * key must bite BEFORE the network send, so the row exists first). Meta's
 * inbound status webhooks only ever carry the other four.
 */
export const WHATSAPP_DELIVERY_STATUSES = ["pending", "sent", "delivered", "read", "failed"] as const;
export type WhatsAppDeliveryStatus = (typeof WHATSAPP_DELIVERY_STATUSES)[number];

export function isWhatsAppDeliveryStatus(v: unknown): v is WhatsAppDeliveryStatus {
  return typeof v === "string" && (WHATSAPP_DELIVERY_STATUSES as readonly string[]).includes(v);
}

/** The statuses Meta itself reports — never `pending`. */
export const META_DELIVERY_STATUSES = ["sent", "delivered", "read", "failed"] as const;
export type MetaDeliveryStatus = (typeof META_DELIVERY_STATUSES)[number];

export function isMetaDeliveryStatus(v: unknown): v is MetaDeliveryStatus {
  return typeof v === "string" && (META_DELIVERY_STATUSES as readonly string[]).includes(v);
}

export interface InboundWhatsAppMessage {
  wamid: string;
  phone: string; // E.164, normalized (Meta sends digits without "+")
  keyword: WhatsAppInboundKeyword;
  receivedAt: number; // unix epoch seconds
}

export interface InboundWhatsAppStatus {
  wamid: string;
  status: MetaDeliveryStatus;
  errorCode: string | null;
}

export interface WebhookEnvelope {
  messages: InboundWhatsAppMessage[];
  statuses: InboundWhatsAppStatus[];
}

const WAMID_RE = /^[A-Za-z0-9._=-]{8,255}$/;

/**
 * Reduce a Cloud API webhook payload to the two flat lists we act on.
 * Tolerant by contract: unknown object types, unknown change fields and
 * malformed entries are SKIPPED, never fatal — Meta retries non-2xx, and
 * a poison entry must not stall the queue behind it.
 */
export function parseWebhookEnvelope(body: unknown): WebhookEnvelope {
  const out: WebhookEnvelope = { messages: [], statuses: [] };
  if (body === null || typeof body !== "object") return out;
  const entries = (body as Record<string, unknown>).entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const changes = (entry as Record<string, unknown>).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (change === null || typeof change !== "object") continue;
      const value = (change as Record<string, unknown>).value;
      if (value === null || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      if (Array.isArray(v.messages)) {
        for (const m of v.messages) {
          if (m === null || typeof m !== "object") continue;
          const msg = m as Record<string, unknown>;
          const wamid = msg.id;
          const from = msg.from;
          const ts = Number(msg.timestamp);
          if (typeof wamid !== "string" || !WAMID_RE.test(wamid)) continue;
          const phone = normalizePhoneE164(typeof from === "string" ? `+${from.replace(/^\+/, "")}` : null);
          if (phone === null || !Number.isFinite(ts) || ts <= 0) continue;
          const text =
            msg.text !== null && typeof msg.text === "object"
              ? (msg.text as Record<string, unknown>).body
              : undefined;
          out.messages.push({
            wamid,
            phone,
            keyword: parseInboundKeyword(text),
            receivedAt: Math.floor(ts),
          });
        }
      }
      if (Array.isArray(v.statuses)) {
        for (const s of v.statuses) {
          if (s === null || typeof s !== "object") continue;
          const st = s as Record<string, unknown>;
          const wamid = st.id;
          if (typeof wamid !== "string" || !WAMID_RE.test(wamid)) continue;
          if (!isMetaDeliveryStatus(st.status)) continue;
          let errorCode: string | null = null;
          if (Array.isArray(st.errors) && st.errors.length > 0) {
            const code = (st.errors[0] as Record<string, unknown>)?.code;
            if (typeof code === "number") errorCode = String(code);
          }
          out.statuses.push({ wamid, status: st.status, errorCode });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// AMD-WA-04: the dedupe contract for the notification leg.
// ---------------------------------------------------------------------------

/**
 * One template per ref per UTC day: `${template}:${ref}:${YYYY-MM-DD}`.
 * A re-driven notification (retried request, replayed event) collapses
 * onto the same key and the database refuses the duplicate.
 */
export function deliveryDedupeKey(templateKey: string, ref: string, dayIso: string): string {
  return `${templateKey}:${ref}:${dayIso}`;
}

/** The outcomes the notification leg reports (observability + pins). */
export const WHATSAPP_LEG_OUTCOMES = [
  "unmapped",
  "no_opt_in",
  "unconfigured",
  "capped",
  "duplicate",
  "sent",
  "failed",
] as const;
export type WhatsAppLegOutcome = (typeof WHATSAPP_LEG_OUTCOMES)[number];
