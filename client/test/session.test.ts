/** FR-01: session lifecycle — refresh margin, single 401 retry, logout order. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createMemoryBackend, LOCAL_STATE_ALLOWLIST } from "../src/presence/localState.js";
import { WITHDRAWAL_WIRE } from "../src/presence/presenceLifecycle.js";
import {
  ACCESS_TOKEN_LIFESPAN_S,
  DEVICE_ENROLMENT_WIRE,
  FIRST_SIGN_IN_PIPELINE,
  LOGOUT_PIPELINE,
  LOGOUT_WITHDRAWAL_WIRE,
  REFRESH_MARGIN_S,
  SESSION_REFRESH_TOKEN_KEY,
  authHeaders,
  executeLogout,
  isAccessTokenUsable,
  logoutHonoursFr19,
  onUnauthorized,
  persistRefreshToken,
  refreshDueAtMs,
  refreshedSession,
  restoreRefreshToken,
  sessionFromTokenResponse,
  shouldRefresh,
  type SessionTokens,
} from "../src/presence/session.js";

const T0 = 1_700_000_000_000;

function tokens(overrides: Partial<SessionTokens> = {}): SessionTokens {
  return {
    accessToken: "at-1",
    expiresAtMs: T0 + ACCESS_TOKEN_LIFESPAN_S * 1000,
    refreshToken: "rt-1",
    deviceId: "dev-1",
    ...overrides,
  };
}

test("the pinned constants match the realm and the SRS", () => {
  assert.equal(ACCESS_TOKEN_LIFESPAN_S, 300); // SEC-02: 5-minute consumer tokens
  assert.equal(REFRESH_MARGIN_S, 30);
  assert.equal(SESSION_REFRESH_TOKEN_KEY, "presence.session.refreshToken");
  assert.ok(LOCAL_STATE_ALLOWLIST.includes(SESSION_REFRESH_TOKEN_KEY));
  assert.deepEqual(DEVICE_ENROLMENT_WIRE, { method: "POST", path: "/v1/devices" });
});

test("refresh falls due exactly REFRESH_MARGIN_S before expiry", () => {
  const t = tokens();
  assert.equal(refreshDueAtMs(t), T0 + 270_000);
  assert.equal(shouldRefresh(t, T0), false);
  assert.equal(shouldRefresh(t, T0 + 269_999), false);
  assert.equal(shouldRefresh(t, T0 + 270_000), true);
  assert.equal(isAccessTokenUsable(t, T0 + 299_999), true);
  assert.equal(isAccessTokenUsable(t, T0 + 300_000), false);
});

test("every authed call carries the bearer and the FR-05 device id", () => {
  assert.deepEqual(authHeaders(tokens()), {
    authorization: "Bearer at-1",
    "x-device-id": "dev-1",
  });
});

test("a 401 earns exactly one refresh-retry, then re-authentication", () => {
  assert.equal(onUnauthorized(false), "refresh-retry");
  assert.equal(onUnauthorized(true), "reauthenticate");
});

test("a well-formed token response becomes a session; garbage fails closed", () => {
  const session = sessionFromTokenResponse(
    { access_token: "at", expires_in: 300, refresh_token: "rt", id_token: "idt" },
    "dev-1",
    T0,
  );
  assert.deepEqual(session, {
    accessToken: "at",
    expiresAtMs: T0 + 300_000,
    refreshToken: "rt",
    deviceId: "dev-1",
    idToken: "idt",
  });
  for (const bad of [
    {},
    { access_token: "", expires_in: 300, refresh_token: "rt" },
    { access_token: "at", expires_in: 0, refresh_token: "rt" },
    { access_token: "at", expires_in: "300", refresh_token: "rt" },
    { access_token: "at", expires_in: 300 },
    { access_token: "at", expires_in: 300, refresh_token: "" },
  ]) {
    assert.equal(sessionFromTokenResponse(bad, "dev-1", T0), null);
  }
});

test("refresh rotation keeps the old refresh token only when none is sent", () => {
  const prev = tokens();
  const rotated = refreshedSession(
    prev,
    { access_token: "at-2", expires_in: 300, refresh_token: "rt-2" },
    T0 + 1000,
  );
  assert.equal(rotated?.refreshToken, "rt-2");
  const kept = refreshedSession(prev, { access_token: "at-2", expires_in: 300 }, T0 + 1000);
  assert.equal(kept?.refreshToken, "rt-1");
  assert.equal(kept?.accessToken, "at-2");
  assert.equal(refreshedSession(prev, { expires_in: 300 }, T0), null);
  assert.equal(refreshedSession(prev, { access_token: "at-2" }, T0), null);
});

test("the persisted refresh token restores only when non-empty", async () => {
  const backend = createMemoryBackend();
  await persistRefreshToken(backend, "rt-persisted");
  assert.equal(backend.keys().length, 1);
  assert.equal(restoreRefreshToken(await backend.getItem(SESSION_REFRESH_TOKEN_KEY)), "rt-persisted");
  assert.equal(restoreRefreshToken(null), null);
  assert.equal(restoreRefreshToken(""), null);
  assert.equal(restoreRefreshToken("   "), null);
});

test("the pinned pipelines carry the FR-01/FR-19 order", () => {
  assert.deepEqual(FIRST_SIGN_IN_PIPELINE, ["exchange-code", "enrol-device", "persist-refresh-token"]);
  assert.deepEqual(LOGOUT_PIPELINE, ["withdraw-presence", "rp-initiated-logout", "clear-local-state"]);
  assert.ok(logoutHonoursFr19(LOGOUT_PIPELINE));
  assert.equal(logoutHonoursFr19(["rp-initiated-logout", "withdraw-presence", "clear-local-state"]), false);
  assert.equal(logoutHonoursFr19(["clear-local-state"]), false);
  // The logout's first step is FR-19's withdrawal wire, shared — not a copy.
  assert.equal(LOGOUT_WITHDRAWAL_WIRE, WITHDRAWAL_WIRE);
});

test("logout withdraws first, hits the IdP second, wipes last", async () => {
  const backend = createMemoryBackend();
  await backend.setItem("presence.powerMode", "reduced");
  await backend.setItem(SESSION_REFRESH_TOKEN_KEY, "rt-1");
  const order: string[] = [];
  await executeLogout(
    tokens(),
    "https://auth.example/realms/consumer/protocol/openid-connect/logout?id_token_hint=x",
    {
      withdrawPresence: async (headers) => {
        order.push("withdraw-presence");
        assert.deepEqual(headers, { authorization: "Bearer at-1", "x-device-id": "dev-1" });
        assert.equal(backend.keys().length, 2, "local state survives the withdrawal");
      },
      endIdpSession: async (url) => {
        order.push("rp-initiated-logout");
        assert.ok(url.includes("openid-connect/logout"));
        assert.equal(backend.keys().length, 2, "local state survives until the IdP session ends");
      },
    },
    backend,
  );
  assert.deepEqual(order, ["withdraw-presence", "rp-initiated-logout"]);
  assert.deepEqual(backend.keys(), [], "TR-30: the wipe runs last and covers every allowlisted key");
});
