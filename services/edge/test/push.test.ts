/**
 * FR-56: the push payload-minimalism contract and the dispatch discipline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUSH_PAYLOAD_KEYS,
  PUSH_REF_FIELDS,
  PUSH_TOKEN_RE,
  PushProvider,
  assertMinimalPayload,
  buildPushPayload,
  dispatchPush,
  pushProvidersFromEnv,
} from "../src/push.js";

test("the payload contract is exactly type + ref", () => {
  assert.deepEqual([...PUSH_PAYLOAD_KEYS].sort(), ["ref", "type"]);
  const payload = buildPushPayload({
    type: "device_enrolled",
    deviceId: "d-1",
    label: "My phone", // FR-56: never crosses into the push payload
  });
  assert.deepEqual(payload, { type: "device_enrolled", ref: "d-1" });
  assert.ok(!("label" in payload!));
});

test("every allowlisted identifier field can become the ref — nothing else", () => {
  for (const field of PUSH_REF_FIELDS) {
    const event: Record<string, unknown> = { type: "matches.new" };
    event[field] = "abc-123";
    const payload = buildPushPayload(event);
    assert.deepEqual(payload, { type: "matches.new", ref: "abc-123" }, field);
  }
  assert.equal(buildPushPayload({ type: "nudge.daily" }), null);
  assert.equal(buildPushPayload({ type: "announcement", body: "x" }), null);
});

test("reason text, handles and cells never enter the payload", () => {
  const payload = buildPushPayload({
    type: "pair.opened",
    pairId: "p-9",
    reason: "both like jazz",
    handle: "@someone",
    cell: "8628347ffffff",
  });
  assert.equal(JSON.stringify(payload), '{"type":"pair.opened","ref":"p-9"}');
});

test("assertMinimalPayload rejects extra keys and bad shapes", () => {
  assertMinimalPayload({ type: "a.b", ref: "x-1" });
  assert.throws(() => assertMinimalPayload({ type: "a", ref: "x", extra: 1 } as never));
  assert.throws(() => assertMinimalPayload({ type: "Bad Type", ref: "x" }));
  assert.throws(() => assertMinimalPayload({ type: "a", ref: "has space" }));
});

test("the env gate yields no providers without credentials", () => {
  assert.deepEqual(pushProvidersFromEnv({} as never), []);
  assert.deepEqual(
    pushProvidersFromEnv({ APNS_TEAM_ID: "t" } as never),
    [],
    "APNs needs the full credential set",
  );
  assert.equal(
    pushProvidersFromEnv({
      APNS_TEAM_ID: "t",
      APNS_KEY_ID: "k",
      APNS_KEY_P8: "cHc4",
      APNS_TOPIC: "app",
      FCM_PROJECT_ID: "p",
      FCM_ACCESS_TOKEN: "tok",
    } as never).length,
    2,
  );
});

test("dispatch drops dead tokens and keeps failures off the caller", async () => {
  const dropped: string[] = [];
  const sent: Array<{ token: string; payload: unknown }> = [];
  const provider: PushProvider = {
    platform: "ios",
    async send(token, payload) {
      sent.push({ token, payload });
      return token === "dead" ? "unregistered" : "ok";
    },
  };
  const pg = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("push_tokens_for")) {
        return {
          rows: [
            { device_id: "d1", platform: "ios", token: "live" },
            { device_id: "d2", platform: "ios", token: "dead" },
            { device_id: "d3", platform: "android", token: "other" },
          ],
        };
      }
      if (sql.includes("drop_push_token")) {
        dropped.push(params![0] as string);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  await dispatchPush({ pg } as never, [provider], "u1", { type: "a.b", ref: "r1" });
  assert.deepEqual(
    sent.map((s) => s.token),
    ["live", "dead"],
    "the android token had no provider and was skipped",
  );
  assert.deepEqual(dropped, ["dead"], "the unregistered token was dropped");
});

test("no providers means no reads — the dormant pipeline is a no-op", async () => {
  let queried = false;
  const pg = { async query() { queried = true; return { rows: [] }; } };
  await dispatchPush(pg as never, [], "u1", { type: "a.b", ref: "r1" });
  assert.equal(queried, false);
});

test("push token shape", () => {
  assert.ok(PUSH_TOKEN_RE.test("a".repeat(64)));
  assert.ok(!PUSH_TOKEN_RE.test("short"));
  assert.ok(!PUSH_TOKEN_RE.test("has a space in the middle............................"));
});
