/**
 * FR-56: the APNs/FCM push pipeline and its payload-minimalism contract.
 *
 * Push payloads carry ONLY a notification type and an opaque identifier —
 * never profile content, reason text, handles or location. buildPushPayload
 * derives { type, ref } from a realtime event by picking the first
 * allowlisted identifier field; an event without one simply gets no push.
 * assertMinimalPayload is the defence-in-depth gate every provider send
 * passes through.
 *
 * Providers are env-gated: without credentials the dispatcher list is empty
 * and the pipeline is a documented no-op (compose/dev). APNs sends a
 * background (content-available) push; FCM sends a data-only message — the
 * client renders the localised string from `type`.
 */

import { createSign } from "node:crypto";

import { EdgeContext } from "./context.js";

export interface PushPayload {
  type: string;
  ref: string;
}

/** FR-56: the complete set of permitted payload keys. */
export const PUSH_PAYLOAD_KEYS = ["type", "ref"] as const;

/** Identifier fields that may become the opaque ref, in priority order. */
export const PUSH_REF_FIELDS = [
  "pairId",
  "deviceId",
  "reportId",
  "sessionId",
  "announcementId",
  "groupId",
  "roomId",
  "eventId",
] as const;

const TYPE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const REF_RE = /^[A-Za-z0-9:_-]{1,128}$/;

/**
 * Derive the minimal push payload from a realtime notification event.
 * Returns null when the event carries no opaque identifier — such events
 * are realtime-only by design.
 */
export function buildPushPayload(event: Record<string, unknown>): PushPayload | null {
  const type = event.type;
  if (typeof type !== "string" || !TYPE_RE.test(type)) return null;
  for (const field of PUSH_REF_FIELDS) {
    const ref = event[field];
    if (typeof ref === "string" && REF_RE.test(ref)) return { type, ref };
  }
  return null;
}

/**
 * The contract gate: exactly { type, ref }, both matching their shapes.
 * Throws on any violation — providers call this immediately before send.
 */
export function assertMinimalPayload(payload: PushPayload): void {
  const keys = Object.keys(payload).sort();
  if (keys.length !== 2 || keys[0] !== "ref" || keys[1] !== "type") {
    throw new Error("push payload must carry exactly type and ref (FR-56)");
  }
  if (!TYPE_RE.test(payload.type) || !REF_RE.test(payload.ref)) {
    throw new Error("push payload fields violate the FR-56 shape");
  }
}

export type PushSendResult = "ok" | "unregistered" | "error";

export interface PushProvider {
  readonly platform: "ios" | "android";
  send(token: string, payload: PushPayload): Promise<PushSendResult>;
}

/**
 * APNs provider. Env: APNS_TEAM_ID, APNS_KEY_ID, APNS_KEY_P8 (base64),
 * APNS_TOPIC. Uses the token-auth HTTP/2 API; a 410 means the token is dead.
 */
export class ApnsProvider implements PushProvider {
  readonly platform = "ios" as const;
  constructor(
    private readonly cfg: { teamId: string; keyId: string; keyP8: string; topic: string; host: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(token: string, payload: PushPayload): Promise<PushSendResult> {
    assertMinimalPayload(payload);
    try {
      const res = await this.fetchImpl(`${this.cfg.host}/3/device/${token}`, {
        method: "POST",
        headers: {
          "apns-topic": this.cfg.topic,
          "apns-push-type": "background",
          "apns-priority": "5",
          // Token auth JWT is minted from APNS_KEY_P8 at process start by the
          // deployment secret; the p8 material never leaves the env.
          authorization: `bearer ${apnsJwt(this.cfg)}`,
          "content-type": "application/json",
        },
        // FR-56: background push — aps carries no content; the notification
        // itself is only the type and the opaque ref.
        body: JSON.stringify({ aps: { "content-available": 1 }, type: payload.type, ref: payload.ref }),
      });
      if (res.status === 410) return "unregistered";
      return res.ok ? "ok" : "error";
    } catch {
      return "error";
    }
  }
}

/**
 * FCM provider. Env: FCM_PROJECT_ID, FCM_ACCESS_TOKEN (workload-identity
 * minted). Data-only message; UNREGISTERED/404 means the token is dead.
 */
export class FcmProvider implements PushProvider {
  readonly platform = "android" as const;
  constructor(
    private readonly cfg: { projectId: string; accessToken: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(token: string, payload: PushPayload): Promise<PushSendResult> {
    assertMinimalPayload(payload);
    try {
      const res = await this.fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${this.cfg.projectId}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.cfg.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: { token, data: { type: payload.type, ref: payload.ref } },
          }),
        },
      );
      if (res.status === 404) return "unregistered";
      if (!res.ok) return "error";
      const body = (await res.json().catch(() => ({}))) as { error?: { status?: string } };
      return body.error?.status === "UNREGISTERED" ? "unregistered" : "ok";
    } catch {
      return "error";
    }
  }
}

/** Compact JWS for APNs token auth (ES256 over the p8 key). */
function apnsJwt(cfg: { teamId: string; keyId: string; keyP8: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: cfg.keyId })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }),
  ).toString("base64url");
  const sign = createSign("sha256");
  sign.update(`${header}.${claims}`);
  const sig = sign.sign(
    { key: Buffer.from(cfg.keyP8, "base64"), format: "der", type: "pkcs8", dsaEncoding: "ieee-p1363" },
  );
  return `${header}.${claims}.${Buffer.from(sig).toString("base64url")}`;
}

/**
 * Env-gated provider wiring. No credentials → empty list → the pipeline is
 * a no-op (the realtime channel still delivers in-session).
 */
export function pushProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): PushProvider[] {
  const providers: PushProvider[] = [];
  const { APNS_TEAM_ID, APNS_KEY_ID, APNS_KEY_P8, APNS_TOPIC, APNS_HOST } = env;
  if (APNS_TEAM_ID && APNS_KEY_ID && APNS_KEY_P8 && APNS_TOPIC) {
    providers.push(
      new ApnsProvider({
        teamId: APNS_TEAM_ID,
        keyId: APNS_KEY_ID,
        keyP8: APNS_KEY_P8,
        topic: APNS_TOPIC,
        host: APNS_HOST ?? "https://api.push.apple.com",
      }),
    );
  }
  const { FCM_PROJECT_ID, FCM_ACCESS_TOKEN } = env;
  if (FCM_PROJECT_ID && FCM_ACCESS_TOKEN) {
    providers.push(new FcmProvider({ projectId: FCM_PROJECT_ID, accessToken: FCM_ACCESS_TOKEN }));
  }
  return providers;
}

/**
 * Dispatch one minimal payload to every push token the account holds.
 * Dead tokens are dropped through the definer; send failures are logged,
 * never thrown — push is best-effort alongside the realtime channel.
 */
export async function dispatchPush(
  ctx: EdgeContext,
  providers: readonly PushProvider[],
  userId: string,
  payload: PushPayload,
): Promise<void> {
  if (providers.length === 0) return;
  const rows = await ctx.pg.query("SELECT device_id, platform, token FROM push_tokens_for($1)", [userId]);
  for (const row of rows.rows as Array<{ device_id: string; platform: string; token: string }>) {
    const provider = providers.find((p) => p.platform === (row.platform === "ios" ? "ios" : "android"));
    if (!provider) continue;
    const result = await provider.send(row.token, payload);
    if (result === "unregistered") {
      await ctx.pg.query("SELECT drop_push_token($1)", [row.token]);
    } else if (result === "error") {
      console.error("push send failed", { platform: row.platform });
    }
  }
}

export const PUSH_TOKEN_RE = /^[A-Za-z0-9_:.=-]{32,512}$/;
