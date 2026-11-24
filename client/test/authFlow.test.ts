/** FR-01: passkey sign-in — PKCE flow discipline, fail-closed parsing. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_POST_LOGOUT_REDIRECT_URI,
  APP_REDIRECT_URI,
  AUTH_BOOTSTRAP_PATH,
  PKCE_CHALLENGE_METHOD,
  beginAuthorization,
  buildLogoutUrl,
  buildRefreshExchange,
  buildTokenExchange,
  deriveChallenge,
  generateState,
  generateVerifier,
  parseCallback,
  resolveAuthConfig,
  type ClientAuthConfig,
  type RandomSource,
} from "../src/presence/authFlow.js";

/** Deterministic RNG: fills with a repeating incrementing pattern. */
function fakeRandom(seed: number): RandomSource {
  return (bytes: number) => {
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[i] = (seed + i) & 0xff;
    return out;
  };
}

const CFG: ClientAuthConfig = {
  issuer: "https://auth.example/realms/consumer",
  clientId: "presence-app",
  redirectUri: APP_REDIRECT_URI,
  postLogoutRedirectUri: APP_POST_LOGOUT_REDIRECT_URI,
};

test("the pinned redirect URIs match the realm export exactly", () => {
  assert.equal(APP_REDIRECT_URI, "presence://auth/callback");
  assert.equal(APP_POST_LOGOUT_REDIRECT_URI, "presence://auth/logout");
  assert.equal(PKCE_CHALLENGE_METHOD, "S256");
  assert.equal(AUTH_BOOTSTRAP_PATH, "/v1/client/config");
});

test("the verifier is 43 base64url chars from 32 random bytes (RFC 7636)", () => {
  const verifier = generateVerifier(fakeRandom(7));
  assert.equal(verifier.length, 43);
  assert.match(verifier, /^[A-Za-z0-9\-_]+$/);
  assert.equal(verifier.includes("="), false, "base64url is unpadded");
});

test("S256 derives the RFC 7636 appendix-B challenge for the known verifier", () => {
  // RFC 7636 appendix B worked example.
  assert.equal(
    deriveChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("the authorize URL carries code, S256 and state — and no password surface", () => {
  const attempt = beginAuthorization(CFG, fakeRandom(1));
  assert.ok(attempt.url.startsWith("https://auth.example/realms/consumer/protocol/openid-connect/auth?"));
  for (const required of [
    "response_type=code",
    "client_id=presence-app",
    `redirect_uri=${encodeURIComponent("presence://auth/callback")}`,
    "scope=openid",
    `state=${attempt.state}`,
    `code_challenge=${deriveChallenge(attempt.verifier)}`,
    "code_challenge_method=S256",
  ]) {
    assert.ok(attempt.url.includes(required), `authorize URL must carry ${required}`);
  }
  assert.equal(attempt.url.includes("password"), false, "FR-01: no password is ever set");
  assert.equal(attempt.url.includes("kc_action"), false);
});

test("entropy flows through: distinct seeds give distinct attempts", () => {
  const a = beginAuthorization(CFG, fakeRandom(1));
  const b = beginAuthorization(CFG, fakeRandom(2));
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.url, b.url);
});

test("state is 32 hex chars from 16 random bytes", () => {
  assert.match(generateState(fakeRandom(3)), /^[0-9a-f]{32}$/);
});

test("a well-formed callback yields the code", () => {
  const result = parseCallback("presence://auth/callback?code=abc123&state=s1", "s1");
  assert.deepEqual(result, { ok: true, code: "abc123" });
});

test("a state mismatch fails closed — never a best-effort sign-in", () => {
  const result = parseCallback("presence://auth/callback?code=abc123&state=OTHER", "s1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "state-mismatch");
});

test("a provider error is surfaced, code or not", () => {
  const result = parseCallback("presence://auth/callback?error=access_denied&state=s1", "s1");
  assert.deepEqual(result, { ok: false, reason: "provider-error", detail: "access_denied" });
});

test("a missing code fails closed", () => {
  const result = parseCallback("presence://auth/callback?state=s1", "s1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-code");
});

test("the token exchange posts the verifier with the code", () => {
  const post = buildTokenExchange(CFG, "code-1", "verifier-1");
  assert.equal(post.url, "https://auth.example/realms/consumer/protocol/openid-connect/token");
  assert.equal(post.headers["content-type"], "application/x-www-form-urlencoded");
  for (const pair of [
    "grant_type=authorization_code",
    "client_id=presence-app",
    `redirect_uri=${encodeURIComponent("presence://auth/callback")}`,
    "code=code-1",
    "code_verifier=verifier-1",
  ]) {
    assert.ok(post.body.includes(pair), `token body must carry ${pair}`);
  }
});

test("the refresh exchange carries only the refresh grant", () => {
  const post = buildRefreshExchange(CFG, "rt-1");
  assert.ok(post.body.includes("grant_type=refresh_token"));
  assert.ok(post.body.includes("refresh_token=rt-1"));
  assert.equal(post.body.includes("code_verifier"), false);
});

test("the logout URL is RP-initiated: id_token_hint plus the pinned redirect", () => {
  const url = buildLogoutUrl(CFG, "id-token-1");
  assert.ok(url.startsWith("https://auth.example/realms/consumer/protocol/openid-connect/logout?"));
  assert.ok(url.includes("id_token_hint=id-token-1"));
  assert.ok(url.includes(`post_logout_redirect_uri=${encodeURIComponent("presence://auth/logout")}`));
  assert.ok(url.includes("client_id=presence-app"));
});

test("the logout URL omits an empty id_token_hint", () => {
  const url = buildLogoutUrl(CFG, undefined);
  assert.equal(url.includes("id_token_hint"), false);
  assert.ok(url.includes("post_logout_redirect_uri="));
});

test("the bootstrap resolves into the full client config", () => {
  const cfg = resolveAuthConfig({
    auth: { issuer: "https://auth.example/realms/consumer/", clientId: "presence-app" },
  });
  assert.deepEqual(cfg, {
    issuer: "https://auth.example/realms/consumer", // trailing slash trimmed
    clientId: "presence-app",
    redirectUri: APP_REDIRECT_URI,
    postLogoutRedirectUri: APP_POST_LOGOUT_REDIRECT_URI,
  });
});

test("an empty issuer or client id fails closed — sign-in is unavailable", () => {
  assert.equal(resolveAuthConfig({}), null);
  assert.equal(resolveAuthConfig({ auth: {} }), null);
  assert.equal(resolveAuthConfig({ auth: { issuer: "", clientId: "presence-app" } }), null);
  assert.equal(resolveAuthConfig({ auth: { issuer: "https://a/b", clientId: "  " } }), null);
  assert.equal(resolveAuthConfig({ auth: { issuer: 42, clientId: "presence-app" } }), null);
});
