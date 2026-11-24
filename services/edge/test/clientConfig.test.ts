/** TR-33: client config route — env-driven pinning policy, unauthenticated. */

import assert from "node:assert/strict";
import Fastify from "fastify";
import { test } from "node:test";

import { registerClientConfigRoute, resolveClientConfig } from "../src/clientConfig.js";
import { API_VERSION } from "../src/versioning.js";

// ---------------------------------------------------------------- resolver --

test("defaults: pinning disabled, version 1, API posture at floor 1, no auth issuer", () => {
  assert.deepEqual(resolveClientConfig({}), {
    configVersion: 1,
    pinning: { enabled: false, pins: [] },
    api: { version: API_VERSION, minClientVersion: 1 },
    auth: { issuer: "", clientId: "presence-app" },
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

test("TR-27: the api object carries the floor from CLIENT_MIN_VERSION", () => {
  assert.deepEqual(resolveClientConfig({ CLIENT_MIN_VERSION: "3" }).api, {
    version: API_VERSION,
    minClientVersion: 3,
  });
  assert.deepEqual(resolveClientConfig({ CLIENT_MIN_VERSION: "abc" }).api, {
    version: API_VERSION,
    minClientVersion: 1,
  });
});

// ------------------------------------------------------- FR-01 auth block --

test("FR-01: the public issuer wins and trailing slashes are trimmed", () => {
  const cfg = resolveClientConfig({
    KEYCLOAK_PUBLIC_ISSUER_URL: "https://auth.presence.example/realms/consumer/",
    KEYCLOAK_ISSUER: "http://keycloak:8080/realms/consumer",
  });
  assert.equal(cfg.auth.issuer, "https://auth.presence.example/realms/consumer");
  assert.equal(cfg.auth.clientId, "presence-app");
});

test("FR-01: the in-cluster issuer is the compose/dev fallback only", () => {
  const cfg = resolveClientConfig({ KEYCLOAK_ISSUER: "http://keycloak:8080/realms/consumer" });
  assert.equal(cfg.auth.issuer, "http://keycloak:8080/realms/consumer");
});

test("FR-01: an explicit client id wins over the realm-exported default", () => {
  const cfg = resolveClientConfig({
    KEYCLOAK_PUBLIC_ISSUER_URL: "https://auth.example/realms/consumer",
    KEYCLOAK_CLIENT_ID: "presence-app-staging",
  });
  assert.deepEqual(cfg.auth, {
    issuer: "https://auth.example/realms/consumer",
    clientId: "presence-app-staging",
  });
});

// ------------------------------------------------------------------- route --

test("GET /v1/client/config answers without any credentials", async () => {
  const app = Fastify({ logger: false });
  registerClientConfigRoute(app);
  const prevPins = process.env.CLIENT_TLS_PINS;
  const prevVersion = process.env.CLIENT_CONFIG_VERSION;
  const prevFloor = process.env.CLIENT_MIN_VERSION;
  const prevIssuer = process.env.KEYCLOAK_PUBLIC_ISSUER_URL;
  const prevClientId = process.env.KEYCLOAK_CLIENT_ID;
  try {
    process.env.CLIENT_TLS_PINS = "pinX,pinY";
    process.env.CLIENT_CONFIG_VERSION = "42";
    process.env.CLIENT_MIN_VERSION = "2";
    process.env.KEYCLOAK_PUBLIC_ISSUER_URL = "https://auth.example/realms/consumer";
    delete process.env.KEYCLOAK_CLIENT_ID;
    const res = await app.inject({ method: "GET", url: "/v1/client/config" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      configVersion: 42,
      pinning: { enabled: true, pins: ["pinX", "pinY"] },
      api: { version: API_VERSION, minClientVersion: 2 },
      auth: { issuer: "https://auth.example/realms/consumer", clientId: "presence-app" },
    });
  } finally {
    if (prevPins === undefined) delete process.env.CLIENT_TLS_PINS;
    else process.env.CLIENT_TLS_PINS = prevPins;
    if (prevVersion === undefined) delete process.env.CLIENT_CONFIG_VERSION;
    else process.env.CLIENT_CONFIG_VERSION = prevVersion;
    if (prevFloor === undefined) delete process.env.CLIENT_MIN_VERSION;
    else process.env.CLIENT_MIN_VERSION = prevFloor;
    if (prevIssuer === undefined) delete process.env.KEYCLOAK_PUBLIC_ISSUER_URL;
    else process.env.KEYCLOAK_PUBLIC_ISSUER_URL = prevIssuer;
    if (prevClientId === undefined) delete process.env.KEYCLOAK_CLIENT_ID;
    else process.env.KEYCLOAK_CLIENT_ID = prevClientId;
    await app.close();
  }
});
