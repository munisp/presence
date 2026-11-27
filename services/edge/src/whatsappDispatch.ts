/**
 * AMD-WA-04: the WhatsApp notification leg — the third delivery channel
 * alongside realtime (Centrifugo) and push (FR-56), wired into the
 * notifyUser() chokepoint and the consent routes.
 *
 * Ordering is load-bearing:
 *   1. map (category, type) -> template; unmapped events are realtime+push
 *      only (the template catalogue is deliberately narrow — AMD-WA-01).
 *   2. resolve the member's ACTIVE opt-in phone through the definer; no
 *      opt-in (or a STOPped member) ends the leg silently. A stopped
 *      member still gets safety notices via realtime+push — FR-58 exempts
 *      safety from the category switch, it never resurrects a revoked
 *      channel (AMD-WA-05).
 *   3. resolve the sender from the environment; unconfigured is a
 *      documented no-op and records NOTHING (compose/dev parity with the
 *      push pipeline).
 *   4. RESERVE the delivery row (status pending) before the network send:
 *      the dedupe key (one template per ref per UTC day) and the daily
 *      cap must bite before a byte leaves, or retries and replays would
 *      multiply sends.
 *   5. send, then finalize the reservation (sent+wamid | failed+reason).
 *
 * Every outcome is counted (presence_whatsapp_leg_results_total) and
 * returned for the contract pins.
 */

import { withWhatsAppCallback } from "./auth.js";
import { EdgeContext } from "./context.js";
import { whatsappLegResults } from "./metrics.js";
import type { NotificationCategory } from "./notifications.js";
import {
  deliveryDedupeKey,
  WHATSAPP_DAILY_CAP,
  WhatsAppLegOutcome,
  templateKeyForNotification,
  whatsappSenderFromEnv,
  WhatsAppSender,
} from "./whatsapp.js";

function counted(outcome: WhatsAppLegOutcome): WhatsAppLegOutcome {
  whatsappLegResults().inc({ result: outcome });
  return outcome;
}

export async function dispatchWhatsAppNotice(
  ctx: EdgeContext,
  userId: string,
  category: NotificationCategory,
  type: string,
  ref: string,
  sender: WhatsAppSender | null = whatsappSenderFromEnv(),
): Promise<WhatsAppLegOutcome> {
  const templateKey = templateKeyForNotification(category, type);
  if (templateKey === null) return counted("unmapped");

  const phone = await withWhatsAppCallback(ctx.pg, async (client) => {
    const r = await client.query("SELECT whatsapp_dispatch_target($1) AS phone", [userId]);
    const v = r.rows[0]?.phone;
    return typeof v === "string" ? v : null;
  });
  if (phone === null) return counted("no_opt_in");

  if (sender === null) return counted("unconfigured");

  const dayIso = new Date(ctx.clock.now()).toISOString().slice(0, 10);
  const dedupe = deliveryDedupeKey(templateKey, ref, dayIso);
  const reservation = await withWhatsAppCallback(ctx.pg, async (client) => {
    const r = await client.query(
      "SELECT whatsapp_record_delivery($1, $2, $3, $4) AS result",
      [userId, templateKey, dedupe, WHATSAPP_DAILY_CAP],
    );
    return typeof r.rows[0]?.result === "string" ? (r.rows[0].result as string) : "forbidden";
  });
  if (reservation === "duplicate") return counted("duplicate");
  if (reservation === "capped") return counted("capped");
  if (reservation !== "recorded") return counted("failed"); // forbidden: misdeployed grants

  const send = await sender(phone, templateKey, {});
  await withWhatsAppCallback(ctx.pg, async (client) => {
    await client.query("SELECT whatsapp_finalize_delivery($1, $2, $3, $4, $5)", [
      userId,
      dedupe,
      send.sent ? (send.wamid ?? null) : null,
      send.sent,
      send.sent ? null : (send.reason ?? "send failed"),
    ]);
  });
  return counted(send.sent ? "sent" : "failed");
}
