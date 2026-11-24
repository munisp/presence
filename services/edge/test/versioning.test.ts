/**
 * TR-27: the version contract — x-api-version on every response, 426 for
 * self-identified builds below the floor, and the exemption that keeps
 * the bootstrap detection channel reachable from every build.
 */

import assert from "node:assert/strict";
import Fastify from "fastify";
import { test } from "node:test";

import {
  API_VERSION,
  API_VERSION_HEADER,
  CLIENT_VERSION_HEADER,
  registerVersionContract,
  resolveMinClientVersion,
} from "../src/versioning.js";

function appWithFloor(env: Record<string, string | undefined>) {
  const app = Fastify({ logger: false });
  registerVersionContract(app, env);
  app.get("/v1/thing", async () => ({ ok: true }));
  app.get("/v1/client/config", async () => ({ ok: true }));
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

test("resolveMinClientVersion: default 1, parsed when valid, fallback on garbage", () => {
  assert.equal(resolveMinClientVersion({}), 1);
  assert.equal(resolveMinClientVersion({ CLIENT_MIN_VERSION: "4" }), 4);
  assert.equal(resolveMinClientVersion({ CLIENT_MIN_VERSION: "0" }), 1);
  assert.equal(resolveMinClientVersion({ CLIENT_MIN_VERSION: "junk" }), 1);
});

test("every response carries x-api-version", async () => {
  const app = appWithFloor({});
  const res = await app.inject({ method: "GET", url: "/v1/thing" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers[API_VERSION_HEADER], String(API_VERSION));
  await app.close();
});

test("a build below the floor is refused with 426", async () => {
  const app = appWithFloor({ CLIENT_MIN_VERSION: "3" });
  const res = await app.inject({
    method: "GET",
    url: "/v1/thing",
    headers: { [CLIENT_VERSION_HEADER]: "2" },
  });
  assert.equal(res.statusCode, 426);
  assert.equal(res.json().error, "client version is no longer supported (TR-27)");
  await app.close();
});

test("builds at or above the floor, missing headers and garbage headers pass", async () => {
  const app = appWithFloor({ CLIENT_MIN_VERSION: "3" });
  for (const headers of [
    { [CLIENT_VERSION_HEADER]: "3" },
    { [CLIENT_VERSION_HEADER]: "9" },
    {},
    { [CLIENT_VERSION_HEADER]: "junk" },
  ]) {
    const res = await app.inject({ method: "GET", url: "/v1/thing", headers });
    assert.equal(res.statusCode, 200, JSON.stringify(headers));
  }
  await app.close();
});

test("the bootstrap config and probes are exempt — refusing them would be failing silently", async () => {
  const app = appWithFloor({ CLIENT_MIN_VERSION: "99" });
  for (const url of ["/v1/client/config", "/healthz"]) {
    const res = await app.inject({
      method: "GET",
      url,
      headers: { [CLIENT_VERSION_HEADER]: "1" },
    });
    assert.equal(res.statusCode, 200, url);
  }
  await app.close();
});
