/**
 * TR-24 idempotency unit + integration tests. The integration half drives
 * the real hooks through Fastify.inject with a Map-backed Valkey stub.
 */

import assert from "node:assert/strict";
import Fastify, { FastifyInstance } from "fastify";
import { test } from "node:test";
import { EdgeContext } from "../src/context.js";
import {
  decodeReply,
  encodeReply,
  idempotencyKeyOf,
  registerIdempotency,
} from "../src/idempotency.js";

/** Minimal RESP stub over a Map — the calls idempotency.ts makes, nothing more. */
function fakeValkey() {
  const map = new Map<string, string>();
  return {
    map,
    async get(k: string) {
      return map.has(k) ? map.get(k)! : null;
    },
    async set(k: string, v: string, ..._args: unknown[]) {
      const nx = _args.includes("NX");
      if (nx && map.has(k)) return null;
      map.set(k, v);
      return "OK";
    },
    async del(k: string) {
      map.delete(k) as unknown as void;
      return 1;
    },
  };
}

function testApp(): { app: FastifyInstance; valkey: ReturnType<typeof fakeValkey>; hits: () => number } {
  const valkey = fakeValkey();
  const ctx = { valkey } as unknown as EdgeContext;
  let hits = 0;
  const app = Fastify({ logger: false });
  app.register(async (scope) => {
    scope.addHook("onRequest", async (req) => {
      (req as unknown as { userId: string }).userId = "u-1";
    });
    registerIdempotency(scope, ctx);
    scope.post("/v1/thing", async () => {
      hits += 1;
      return { ok: true, hit: hits };
    });
    scope.get("/v1/thing", async () => {
      hits += 1;
      return { ok: true, hit: hits };
    });
  });
  return { app, valkey, hits: () => hits };
}

test("key format validation", () => {
  const mk = (v: string | undefined) =>
    ({ headers: v === undefined ? {} : { "idempotency-key": v } }) as Parameters<
      typeof idempotencyKeyOf
    >[0];
  assert.equal(idempotencyKeyOf(mk(undefined)), null); // absent header → no dedupe
  assert.equal(idempotencyKeyOf(mk("abc-DEF_123")), "abc-DEF_123");
  assert.equal(idempotencyKeyOf(mk("bad key!")), null); // unsafe characters
  assert.equal(idempotencyKeyOf(mk("x".repeat(129))), null); // too long
  assert.equal(idempotencyKeyOf(mk("")), null);
});

test("encode/decode round-trip; junk decodes to null", () => {
  const raw = encodeReply(201, '{"ok":true}');
  assert.deepEqual(decodeReply(raw), { status: 201, body: '{"ok":true}' });
  assert.equal(decodeReply("not json"), null);
  assert.equal(decodeReply('{"status":"x"}'), null);
});

test("same key replays the recorded response and does not re-execute", async () => {
  const { app, hits } = testApp();
  const first = await app.inject({
    method: "POST",
    url: "/v1/thing",
    headers: { "idempotency-key": "k-1" },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().hit, 1);
  const replay = await app.inject({
    method: "POST",
    url: "/v1/thing",
    headers: { "idempotency-key": "k-1" },
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.deepEqual(replay.json(), first.json()); // verbatim replay
  assert.equal(hits(), 1); // handler ran once
  await app.close();
});

test("a different key executes again; no header executes every time", async () => {
  const { app, hits } = testApp();
  await app.inject({ method: "POST", url: "/v1/thing", headers: { "idempotency-key": "k-1" } });
  await app.inject({ method: "POST", url: "/v1/thing", headers: { "idempotency-key": "k-2" } });
  await app.inject({ method: "POST", url: "/v1/thing" });
  await app.inject({ method: "POST", url: "/v1/thing" });
  assert.equal(hits(), 4);
  await app.close();
});

test("GET is never deduplicated (mutating methods only)", async () => {
  const { app, hits } = testApp();
  await app.inject({ method: "GET", url: "/v1/thing", headers: { "idempotency-key": "k-1" } });
  await app.inject({ method: "GET", url: "/v1/thing", headers: { "idempotency-key": "k-1" } });
  assert.equal(hits(), 2);
  await app.close();
});

test("a pending lease answers 409", async () => {
  const { app, valkey } = testApp();
  await valkey.set("idem:u-1:k-stuck", "pending");
  const res = await app.inject({
    method: "POST",
    url: "/v1/thing",
    headers: { "idempotency-key": "k-stuck" },
  });
  assert.equal(res.statusCode, 409);
  await app.close();
});

test("an invalid key is a 400, not a silent pass", async () => {
  const { app, hits } = testApp();
  const res = await app.inject({
    method: "POST",
    url: "/v1/thing",
    headers: { "idempotency-key": "bad key!" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(hits(), 0);
  await app.close();
});
