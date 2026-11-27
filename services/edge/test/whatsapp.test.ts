/** SRS Addendum 001 (b69): the WhatsApp channel contract — AMD-WA-01..05. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  E164_RE,
  META_DELIVERY_STATUSES,
  NOTIFICATION_TEMPLATE_MAP,
  CATEGORY_TEMPLATE_MAP,
  STOP_LEXICON,
  START_LEXICON,
  HELP_LEXICON,
  VERIFY_CODE_RE,
  WHATSAPP_DAILY_CAP,
  WHATSAPP_DELIVERY_STATUSES,
  WHATSAPP_GRAPH_VERSION,
  WHATSAPP_INBOUND_KEYWORDS,
  WHATSAPP_LEG_OUTCOMES,
  WHATSAPP_OPT_IN_EVENTS,
  WHATSAPP_OPT_IN_STATES,
  WHATSAPP_RESEND_COOLDOWN_MS,
  WHATSAPP_TEMPLATES,
  WHATSAPP_TIMEOUT_MS,
  WHATSAPP_VERIFY_CODE_TTL_MS,
  WHATSAPP_VERIFY_MAX_ATTEMPTS,
  assertTemplateSend,
  buildTemplateSendBody,
  deliveryDedupeKey,
  isMetaDeliveryStatus,
  isWhatsAppDeliveryStatus,
  isWhatsAppOptInState,
  maskPhone,
  mintVerifyCode,
  normalizePhoneE164,
  parseInboundKeyword,
  parseVerifyHandshake,
  parseWebhookEnvelope,
  templateKeyForNotification,
  verifyCodeDigest,
  webhookSignatureValid,
  whatsappSenderFromEnv,
} from "../src/whatsapp.js";

test("AMD-WA-01: E.164 normalization is strict and total", () => {
  assert.equal(normalizePhoneE164("+2348012345678"), "+2348012345678");
  assert.equal(normalizePhoneE164("2348012345678"), null); // no implicit +
  assert.equal(normalizePhoneE164("+234 801 234 5678"), "+2348012345678");
  assert.equal(normalizePhoneE164("+234 (801) 234-5678"), "+2348012345678");
  assert.equal(normalizePhoneE164("002348012345678"), "+2348012345678"); // 00 -> +
  assert.equal(normalizePhoneE164("+0234801234567"), null); // leading 0 after +
  assert.equal(normalizePhoneE164("+1234567"), null); // 7 digits: below the floor
  assert.equal(normalizePhoneE164("+12345678"), "+12345678"); // 8 digits: floor
  assert.equal(normalizePhoneE164("+123456789012345"), "+123456789012345"); // 15: ceiling
  assert.equal(normalizePhoneE164("+1234567890123456"), null); // 16 digits: too long
  assert.equal(normalizePhoneE164("+234801234abc"), null);
  assert.equal(normalizePhoneE164(""), null);
  assert.equal(normalizePhoneE164(null), null);
  assert.equal(normalizePhoneE164(undefined), null);
  assert.equal(normalizePhoneE164(2348012345678), null);
  assert.equal(E164_RE.test("+2348012345678"), true);
  assert.equal(E164_RE.test("2348012345678"), false);
});

test("AMD-WA-05: maskPhone keeps country code and last four only", () => {
  assert.equal(maskPhone("+2348012345678"), "+234****5678");
  assert.equal(maskPhone("+1234567"), "+****"); // 8 chars incl +: minimal mask
  assert.equal(maskPhone("+12345678"), "+123****5678"); // 9 chars: first four + last four
  assert.equal(maskPhone("+123456789"), "+123****6789");
});

test("AMD-WA-01: the opt-in and event vocabularies are pinned", () => {
  assert.deepEqual(WHATSAPP_OPT_IN_STATES, ["pending", "active", "stopped"]);
  assert.deepEqual(WHATSAPP_OPT_IN_EVENTS, [
    "link_requested",
    "verified",
    "verify_failed",
    "unlinked",
    "stopped_inbound",
    "resumed_inbound",
    "help_requested",
  ]);
  assert.equal(isWhatsAppOptInState("active"), true);
  assert.equal(isWhatsAppOptInState("blocked"), false);
});

test("AMD-WA-03: the verify-code contract is pinned", () => {
  assert.equal(WHATSAPP_VERIFY_CODE_TTL_MS, 600_000);
  assert.equal(WHATSAPP_VERIFY_MAX_ATTEMPTS, 5);
  assert.equal(WHATSAPP_RESEND_COOLDOWN_MS, 60_000);
  const code = mintVerifyCode();
  assert.match(code, VERIFY_CODE_RE);
  assert.equal(code.length, 6);
  // The digest is bound to the account — the same code digests differently
  // for a different user, so a code is never portable across accounts.
  const a = verifyCodeDigest("user-a", "123456");
  const b = verifyCodeDigest("user-b", "123456");
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(verifyCodeDigest("user-a", "123456"), a); // deterministic
});

test("AMD-WA-01: the template catalogue is governed and minimal", () => {
  assert.deepEqual(Object.keys(WHATSAPP_TEMPLATES).sort(), [
    "announcement_notice",
    "match_notice",
    "pair_opened",
    "safety_notice",
    "verify_code",
  ]);
  assert.equal(WHATSAPP_TEMPLATES.verify_code.name, "presence_verify_code");
  assert.deepEqual(WHATSAPP_TEMPLATES.verify_code.params, ["code"]);
  for (const key of ["match_notice", "pair_opened", "announcement_notice", "safety_notice"] as const) {
    assert.deepEqual(WHATSAPP_TEMPLATES[key].params, []);
  }
  // The minimalism gate: exactly the declared params, code well-formed.
  assert.equal(assertTemplateSend("verify_code", { code: "123456" }), true);
  assert.equal(assertTemplateSend("verify_code", { code: "12345" }), false);
  assert.equal(assertTemplateSend("verify_code", {}), false);
  assert.equal(assertTemplateSend("verify_code", { code: "123456", extra: 1 }), false);
  assert.equal(assertTemplateSend("match_notice", {}), true);
  assert.equal(assertTemplateSend("match_notice", { anything: 1 }), false);
  assert.equal(assertTemplateSend("wallet_notice", {}), false); // not in the catalogue
  assert.equal(assertTemplateSend("nonexistent", {}), false);
});

test("AMD-WA-01: buildTemplateSendBody is the Cloud API wire shape", () => {
  const bare = buildTemplateSendBody("+2348012345678", "match_notice", {});
  assert.deepEqual(bare, {
    messaging_product: "whatsapp",
    to: "+2348012345678",
    type: "template",
    template: { name: "presence_match_notice", language: { code: "en" } },
  });
  const coded = buildTemplateSendBody("+2348012345678", "verify_code", { code: "123456" }) as {
    template: { components: { parameters: { text: string }[] }[] };
  };
  assert.equal(
    coded.template.components[0].parameters[0].text,
    "123456",
  );
});

test("AMD-WA-04: the type->template map is narrow and total", () => {
  assert.deepEqual(NOTIFICATION_TEMPLATE_MAP, {
    "nudges:nudged": "match_notice",
    "matches:mutual": "match_notice",
    "matches:open": "pair_opened",
  });
  assert.deepEqual(CATEGORY_TEMPLATE_MAP, {
    announcements: "announcement_notice",
    safety: "safety_notice",
  });
  assert.equal(templateKeyForNotification("nudges", "nudged"), "match_notice");
  assert.equal(templateKeyForNotification("matches", "mutual"), "match_notice");
  assert.equal(templateKeyForNotification("matches", "open"), "pair_opened");
  assert.equal(templateKeyForNotification("announcements", "anything"), "announcement_notice");
  assert.equal(templateKeyForNotification("safety", "anything"), "safety_notice");
  assert.equal(templateKeyForNotification("messages", "ping"), null); // unmapped: no WhatsApp
  assert.equal(templateKeyForNotification("offers", "offer"), null);
  assert.deepEqual(WHATSAPP_LEG_OUTCOMES, [
    "unmapped",
    "no_opt_in",
    "unconfigured",
    "capped",
    "duplicate",
    "sent",
    "failed",
  ]);
  assert.equal(WHATSAPP_DAILY_CAP, 20);
  assert.equal(WHATSAPP_TIMEOUT_MS, 10_000);
  assert.equal(WHATSAPP_GRAPH_VERSION, "v21.0");
  assert.equal(
    deliveryDedupeKey("match_notice", "pair-1", "2026-11-27"),
    "match_notice:pair-1:2026-11-27",
  );
});

test("AMD-WA-02: the verify handshake parser is strict", () => {
  assert.deepEqual(
    parseVerifyHandshake({
      "hub.mode": "subscribe",
      "hub.verify_token": "tok",
      "hub.challenge": "42",
    }),
    { mode: "subscribe", verifyToken: "tok", challenge: "42" },
  );
  assert.equal(parseVerifyHandshake({ "hub.mode": "subscribe" }), null);
  assert.equal(parseVerifyHandshake(null), null);
  assert.equal(parseVerifyHandshake("subscribe"), null);
  assert.equal(
    parseVerifyHandshake({
      "hub.mode": "subscribe",
      "hub.verify_token": 42,
      "hub.challenge": "42",
    }),
    null,
  );
});

test("AMD-WA-02: the intake signature is HMAC over the raw body", async () => {
  const { createHmac } = await import("node:crypto");
  const secret = "app-secret";
  const raw = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }));
  const hex = createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(webhookSignatureValid(secret, raw, `sha256=${hex}`), true);
  assert.equal(webhookSignatureValid(secret, raw, `sha256=${"0".repeat(64)}`), false);
  assert.equal(webhookSignatureValid(secret, Buffer.from("tampered"), `sha256=${hex}`), false);
  assert.equal(webhookSignatureValid(secret, raw, hex), false); // missing prefix
  assert.equal(webhookSignatureValid(secret, raw, `SHA256=${hex}`), false); // case-sensitive
  assert.equal(webhookSignatureValid(secret, raw, undefined), false);
  assert.equal(webhookSignatureValid(secret, raw, "sha256=not-hex"), false);
});

test("AMD-WA-02: inbound keywords reduce to the pinned vocabulary", () => {
  assert.deepEqual(WHATSAPP_INBOUND_KEYWORDS, ["stop", "start", "help", "other"]);
  assert.equal(parseInboundKeyword("STOP"), "stop");
  assert.equal(parseInboundKeyword("  unsubscribe  "), "stop");
  assert.equal(parseInboundKeyword("stopall"), "stop");
  assert.equal(parseInboundKeyword("Start"), "start");
  assert.equal(parseInboundKeyword("unstop"), "start");
  assert.equal(parseInboundKeyword("help"), "help");
  assert.equal(parseInboundKeyword("INFO"), "help");
  assert.equal(parseInboundKeyword("please stop"), "other"); // multi-token: never guessed
  assert.equal(parseInboundKeyword("hello"), "other");
  assert.equal(parseInboundKeyword(""), "other");
  assert.equal(parseInboundKeyword(null), "other");
  assert.equal(parseInboundKeyword(undefined), "other");
  // The lexicons stay disjoint.
  for (const w of STOP_LEXICON) {
    assert.equal(START_LEXICON.has(w), false);
    assert.equal(HELP_LEXICON.has(w), false);
  }
});

test("AMD-WA-02: the envelope parser is tolerant and keyword-only", () => {
  const doc = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "123",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              messages: [
                {
                  from: "2348012345678", // Meta omits the +
                  id: "wamid.HBgLMTIzNDU2",
                  timestamp: "1732700000",
                  type: "text",
                  text: { body: "STOP" },
                },
                { from: "2348012345678", id: "bad", timestamp: "1732700000" }, // wamid too short: skipped
                { from: "not-a-phone", id: "wamid.HBgLMTIzNDU3", timestamp: "1732700000" }, // skipped
              ],
              statuses: [
                { id: "wamid.HBgLMTIzNDU2", status: "delivered", timestamp: "1732700001" },
                { id: "wamid.HBgLMTIzNDU2", status: "pending" }, // not a Meta status: skipped
                {
                  id: "wamid.HBgLMTIzNDU4",
                  status: "failed",
                  errors: [{ code: 131047, title: "Re-engagement" }],
                },
              ],
            },
          },
          { field: "unknown", value: {} }, // skipped
        ],
      },
      "garbage-entry", // skipped
    ],
  };
  const out = parseWebhookEnvelope(doc);
  assert.equal(out.messages.length, 1);
  assert.deepEqual(out.messages[0], {
    wamid: "wamid.HBgLMTIzNDU2",
    phone: "+2348012345678",
    keyword: "stop",
    receivedAt: 1732700000,
  });
  assert.equal(out.statuses.length, 2);
  assert.deepEqual(out.statuses[0], { wamid: "wamid.HBgLMTIzNDU2", status: "delivered", errorCode: null });
  assert.deepEqual(out.statuses[1], { wamid: "wamid.HBgLMTIzNDU4", status: "failed", errorCode: "131047" });
  // Nothing throws on garbage.
  assert.deepEqual(parseWebhookEnvelope(null), { messages: [], statuses: [] });
  assert.deepEqual(parseWebhookEnvelope({}), { messages: [], statuses: [] });
  assert.deepEqual(parseWebhookEnvelope({ entry: "x" }), { messages: [], statuses: [] });
  // The parser surface carries NO message text anywhere.
  assert.equal(JSON.stringify(out).includes("STOP"), false);
});

test("AMD-WA-04: delivery statuses split ledger vs Meta vocabularies", () => {
  assert.deepEqual(WHATSAPP_DELIVERY_STATUSES, ["pending", "sent", "delivered", "read", "failed"]);
  assert.deepEqual(META_DELIVERY_STATUSES, ["sent", "delivered", "read", "failed"]);
  assert.equal(isWhatsAppDeliveryStatus("pending"), true);
  assert.equal(isMetaDeliveryStatus("pending"), false); // Meta never reports it
  assert.equal(isMetaDeliveryStatus("read"), true);
  assert.equal(isMetaDeliveryStatus("queued"), false);
});

test("AMD-WA-04: the sender is env-gated with echo first", () => {
  assert.equal(whatsappSenderFromEnv({} as NodeJS.ProcessEnv), null);
  const echo = whatsappSenderFromEnv({ WHATSAPP_DEV_ECHO: "1" } as NodeJS.ProcessEnv);
  assert.notEqual(echo, null);
  const real = whatsappSenderFromEnv({
    WHATSAPP_ACCESS_TOKEN: "tok",
    WHATSAPP_PHONE_NUMBER_ID: "123",
  } as NodeJS.ProcessEnv);
  assert.notEqual(real, null);
  const partial = whatsappSenderFromEnv({ WHATSAPP_ACCESS_TOKEN: "tok" } as NodeJS.ProcessEnv);
  assert.equal(partial, null); // both wires or no sender
});
