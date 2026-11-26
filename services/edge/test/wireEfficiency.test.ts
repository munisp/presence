/**
 * AMD-NET-04: wire efficiency — the edge compresses responses above the
 * 1 KiB threshold (brotli preferred, gzip fallback) and leaves small
 * responses untouched. The member this platform is for is on a contested
 * last mile; every byte is a budgeted cost (AMD-NET-05).
 */

import assert from "node:assert/strict";
import zlib from "node:zlib";
import Fastify from "fastify";
import fastifyCompress from "@fastify/compress";
import { test } from "node:test";

/** The same registration options as app.ts — pinned here behaviorally. */
async function buildCompressibleApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCompress, {
    global: true,
    threshold: 1024,
    encodings: ["br", "gzip"],
  });
  app.get("/large", async () => ({ data: "x".repeat(8 * 1024) }));
  app.get("/small", async () => ({ ok: true }));
  return app;
}

test("responses above 1 KiB are brotli-compressed when the client accepts it", async () => {
  const app = await buildCompressibleApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/large",
      headers: { "accept-encoding": "br, gzip" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-encoding"], "br");
    const compressed = res.rawPayload.length;
    const plain = JSON.stringify({ data: "x".repeat(8 * 1024) }).length;
    assert.ok(compressed < plain / 4, `brotli should crush repetitive JSON (${compressed} vs ${plain})`);
    // And the payload actually decodes back to the original body.
    const decoded = zlib.brotliDecompressSync(res.rawPayload).toString("utf8");
    assert.deepEqual(JSON.parse(decoded), { data: "x".repeat(8 * 1024) });
  } finally {
    await app.close();
  }
});

test("gzip is the fallback when the client does not accept brotli", async () => {
  const app = await buildCompressibleApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/large",
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-encoding"], "gzip");
    const decoded = zlib.gunzipSync(res.rawPayload).toString("utf8");
    assert.deepEqual(JSON.parse(decoded), { data: "x".repeat(8 * 1024) });
  } finally {
    await app.close();
  }
});

test("responses below the 1 KiB threshold pass through uncompressed", async () => {
  const app = await buildCompressibleApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/small",
      headers: { "accept-encoding": "br, gzip" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-encoding"], undefined);
    assert.deepEqual(res.json(), { ok: true });
  } finally {
    await app.close();
  }
});

test("a client that accepts no encoding gets identity bytes", async () => {
  const app = await buildCompressibleApp();
  try {
    const res = await app.inject({ method: "GET", url: "/large" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-encoding"], undefined);
    assert.ok(res.rawPayload.length > 8 * 1024);
  } finally {
    await app.close();
  }
});
