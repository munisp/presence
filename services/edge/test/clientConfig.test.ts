/** TR-33: client config route — env-driven pinning policy, unauthenticated. */

import assert from "node:assert/strict";
import Fastify from "fastify";
import { test } from "node:test";

import { registerClientConfigRoute, resolveClientConfig } from "../src/clientConfig.js";

// ---------------------------------------------------------------- resolver --

test("defaults: pinning disabled, version 1", () => {
  assert.deepEqual(resolveClientConfig({}), {
    configVersion: 1,
    pinning: { enabled: false, pins: [] },
  });
});

test("pins in env enable pinning; whitespace and empties are dropped", () => {
  const cfg = resolveClientConfig({
    CLIENT_CONFIG_VERSION: "7",
    CLIENT_TLS_PINS: " pinA , ,pinB ,",
  });
  assert.equal(cfg.configVersion, 7);
  assert.deepEqual(cfg.pinning, { enabled: true, pins: ["pinA", "pinB"] });
});

test("an unusable version falls back to 1, never NaN or zero", () => {
  assert.equal(resolveClientConfig({ CLIENT_CONFIG_VERSION: "abc" }).configVersion, 1);
  assert.equal(resolveClientConfig({ CLIENT_CONFIG_VERSION: "0" }).configVersion, 1);
});

// ------------------------------------------------------------------- route --

test("GET /v1/client/config answers without any credentials", async () => {
  const app = Fastify({ logger: false });
  registerClientConfigRoute(app);
  const prevPins = process.env.CLIENT_TLS_PINS;
  const prevVersion = process.env.CLIENT_CONFIG_VERSION;
  try {
    process.env.CLIENT_TLS_PINS = "pinX,pinY";
    process.env.CLIENT_CONFIG_VERSION = "42";
    const res = await app.inject({ method: "GET", url: "/v1/client/config" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      configVersion: 42,
      pinning: { enabled: true, pins: ["pinX", "pinY"] },
    });
  } finally {
    if (prevPins === undefined) delete process.env.CLIENT_TLS_PINS;
    else process.env.CLIENT_TLS_PINS = prevPins;
    if (prevVersion === undefined) delete process.env.CLIENT_CONFIG_VERSION;
    else process.env.CLIENT_CONFIG_VERSION = prevVersion;
    await app.close();
  }
});
