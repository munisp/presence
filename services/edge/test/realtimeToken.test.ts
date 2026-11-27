/** AMD-CRT-04: Centrifugo connection-token route and signer. */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { test } from "node:test";
import Postgres from "pg";

import { EdgeContext } from "../src/context.js";
import {
  CENTRIFUGO_TOKEN_TTL_S,
  memberChannels,
  registerRealtimeTokenRoute,
  signCentrifugoToken,
} from "../src/realtimeToken.js";

const USER = "11111111-2222-4333-8444-555555555555";

function fakePool(pairIds: string[]): Postgres.Pool {
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes("FROM matches")) {
        // The privacy boundary: the query is member-scoped AND excludes
        // closed pairs — never a blanket pair listing.
        assert.ok(text.includes("user_lo = $1::uuid"), "membership predicate");
        assert.ok(text.includes("user_hi = $1::uuid"), "membership predicate");
        assert.ok(text.includes("closed_at IS NULL"), "closed pairs excluded");
        assert.deepEqual(params, [USER]);
        return { rows: pairIds.map((pair_id) => ({ pair_id })) };
      }
      return { rows: [] }; // BEGIN / COMMIT / set_config
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Postgres.Pool;
}

function fakeCtx(pairIds: string[]): EdgeContext {
  return {
    pg: fakePool(pairIds),
    clock: { now: () => 1_700_000_000_000 },
  } as unknown as EdgeContext;
}

function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signature: string } {
  const [h, p, s] = token.split(".");
  const decode = (part: string) =>
    JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  return { header: decode(h), payload: decode(p), signature: s };
}

test("the signer produces a verifiable HS256 JWT", () => {
  const claims = { sub: USER, iat: 100, exp: 700, channels: [`user:${USER}`] };
  const token = signCentrifugoToken(claims, "topsecret");
  const { header, payload, signature } = decodeJwt(token);
  assert.deepEqual(header, { alg: "HS256", typ: "JWT" });
  assert.deepEqual(payload, claims);
  const expected = createHmac("sha256", "topsecret")
    .update(token.split(".").slice(0, 2).join("."))
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(signature, expected);
  // A different secret must not verify.
  const wrong = createHmac("sha256", "wrong")
    .update(token.split(".").slice(0, 2).join("."))
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.notEqual(signature, wrong);
});

test("memberChannels grants the own user channel first, then pair channels", () => {
  assert.deepEqual(memberChannels(USER, ["p1", "p2"]), [
    `user:${USER}`,
    "pair:p1",
    "pair:p2",
  ]);
});

test("503 when CENTRIFUGO_TOKEN_HMAC_SECRET_KEY is unconfigured (AMD-PAY-16 discipline)", async () => {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    (req as { userId: string }).userId = USER;
  });
  registerRealtimeTokenRoute(app, fakeCtx(["p1"]));
  const prev = process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
  delete process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
  try {
    const res = await app.inject({ method: "POST", url: "/v1/realtime/token", payload: {} });
    assert.equal(res.statusCode, 503);
    assert.match(res.json().error, /not configured/);
  } finally {
    if (prev !== undefined) process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY = prev;
    await app.close();
  }
});

test("200: a scoped 600-second token over the member's open pairs", async () => {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    (req as { userId: string }).userId = USER;
  });
  registerRealtimeTokenRoute(app, fakeCtx(["pair-a", "pair-b"]));
  const prev = process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
  process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY = "test-secret";
  try {
    const res = await app.inject({ method: "POST", url: "/v1/realtime/token", payload: {} });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.expiresIn, CENTRIFUGO_TOKEN_TTL_S);
    assert.equal(CENTRIFUGO_TOKEN_TTL_S, 600);
    assert.deepEqual(body.channels, [`user:${USER}`, "pair:pair-a", "pair:pair-b"]);
    const { payload } = decodeJwt(body.token);
    assert.equal(payload.sub, USER);
    assert.equal((payload.exp as number) - (payload.iat as number), 600);
    assert.deepEqual(payload.channels, body.channels);
    // The signature verifies against the configured secret.
    const expected = createHmac("sha256", "test-secret")
      .update(body.token.split(".").slice(0, 2).join("."))
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    assert.equal(body.token.split(".")[2], expected);
  } finally {
    if (prev === undefined) delete process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
    else process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY = prev;
    await app.close();
  }
});
