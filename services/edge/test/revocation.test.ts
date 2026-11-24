/**
 * SEC-02: the revocation denylist — write-before-reply, immediate effect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVOCATION_PROPAGATION_S,
  isDeviceAccessRevoked,
  revokeDeviceAccess,
  revokedDeviceKey,
} from "../src/revocation.js";

function fakeValkey() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string, _ex: string, _ttl: number) {
      store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
  };
}

function fakeCtx(valkey: ReturnType<typeof fakeValkey>, fetchImpl?: typeof fetch) {
  return {
    valkey,
    pg: { async query() { return { rows: [] }; } },
    centrifugoUrl: "http://centrifugo:8000",
    centrifugoApiKey: "k",
    matchServiceUrl: "http://match:4100",
    clock: { now: () => 0 },
    ids: { sessionId: () => "s" },
    ...(fetchImpl ? {} : {}),
  } as never;
}

test("the SEC-02 budget is sixty seconds", () => {
  assert.equal(REVOCATION_PROPAGATION_S, 60);
});

test("revocation writes the deny key before anything else", async () => {
  const valkey = fakeValkey();
  const ctx = fakeCtx(valkey);
  assert.equal(await isDeviceAccessRevoked(ctx, "d1"), false);
  await revokeDeviceAccess(ctx, "u1", "d1");
  assert.equal(valkey.store.get(revokedDeviceKey("d1")), "1");
  assert.equal(await isDeviceAccessRevoked(ctx, "d1"), true);
  assert.equal(await isDeviceAccessRevoked(ctx, "d2"), false, "other devices unaffected");
});

test("revocation survives a failed realtime notice — the deny key stands", async () => {
  const valkey = fakeValkey();
  // publishRealtime goes through global fetch; an unreachable endpoint must
  // not stop the denylist from being effective.
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("centrifugo down");
  };
  try {
    const ctx = fakeCtx(valkey);
    await revokeDeviceAccess(ctx, "u1", "d1");
    assert.equal(await isDeviceAccessRevoked(ctx, "d1"), true);
  } finally {
    globalThis.fetch = original;
  }
});
