/**
 * SEC-03: JIT elevation constants, request parsing/screening, and the
 * env-gated Keycloak role binding.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ELEVATION_GRANT_TTL_MS,
  ELEVATION_REQUEST_TTL_MS,
  ELEVATION_SCOPES,
  parseElevationRequestBody,
} from "../src/elevation.js";
import {
  KeycloakAdminClient,
  bindModeratorRole,
  keycloakAdminFromEnv,
} from "../src/keycloakAdmin.js";

test("elevation TTLs are pinned to the workforce session ceiling and request window", () => {
  assert.equal(ELEVATION_GRANT_TTL_MS, 4 * 60 * 60 * 1000, "grant TTL = ssoSessionMaxLifespan 14400s");
  assert.equal(ELEVATION_REQUEST_TTL_MS, 24 * 60 * 60 * 1000);
  assert.deepEqual(ELEVATION_SCOPES, ["moderation"]);
});

test("request body parsing: defaults, windows, scope set", () => {
  const ok = parseElevationRequestBody({ justification: "covering the weekend incident queue" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.value, { scope: "moderation", justification: "covering the weekend incident queue" });
  assert.equal(parseElevationRequestBody({ scope: "root", justification: "x".repeat(20) }).ok, false);
  assert.equal(parseElevationRequestBody({ justification: "short" }).ok, false);
  assert.equal(parseElevationRequestBody({ justification: "x".repeat(501) }).ok, false);
  assert.equal(parseElevationRequestBody(null).ok, false);
});

test("the justification passes through the SEC-26 screener", () => {
  const parsed = parseElevationRequestBody({
    justification: "mail me at mod@example.com for the case files",
  });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /screening/);
});

const ENV = {
  KEYCLOAK_ADMIN_BASE_URL: "http://keycloak:8080/",
  KEYCLOAK_ADMIN_CLIENT_ID: "presence-edge-admin",
  KEYCLOAK_ADMIN_CLIENT_SECRET: "s3cret",
} as NodeJS.ProcessEnv;

test("the env gate yields no client unless every credential is present", () => {
  assert.equal(keycloakAdminFromEnv({} as never), null);
  assert.equal(keycloakAdminFromEnv({ KEYCLOAK_ADMIN_BASE_URL: "http://k:8080" } as never), null);
  const cfg = keycloakAdminFromEnv(ENV);
  assert.ok(cfg);
  assert.equal(cfg.baseUrl, "http://keycloak:8080", "trailing slash stripped");
  assert.equal(cfg.realm, "workforce");
  assert.equal(cfg.tokenRealm, "master");
});

test("grant: token → role lookup → POST mapping, with the token cached", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fakeFetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const u = String(url);
    if (u.endsWith("/protocol/openid-connect/token")) {
      return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 300 }), { status: 200 });
    }
    if (u.endsWith("/roles/moderator")) {
      return new Response(JSON.stringify({ id: "role-1", name: "moderator" }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const cfg = keycloakAdminFromEnv(ENV)!;
  const client = new KeycloakAdminClient(cfg, fakeFetch);
  await client.grantModeratorRole("sub-1");
  await client.grantModeratorRole("sub-2");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["POST", "GET", "POST", "GET", "POST"],
    "second grant reuses the cached token but re-reads the role rep",
  );
  assert.equal(calls[0].url, "http://keycloak:8080/realms/master/protocol/openid-connect/token");
  assert.equal(
    calls[2].url,
    "http://keycloak:8080/admin/realms/workforce/users/sub-1/role-mappings/realm",
  );
  // Revoke uses DELETE against the same mapping endpoint.
  calls.length = 0;
  await client.revokeModeratorRole("sub-1");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET", "DELETE"],
  );
});

test("a failed admin call throws inside the client but never out of bindModeratorRole", async () => {
  const cfg = keycloakAdminFromEnv(ENV)!;
  const failing = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  await assert.rejects(new KeycloakAdminClient(cfg, failing).grantModeratorRole("sub-1"));
  // bindModeratorRole swallows and logs — the Postgres grant stays authoritative.
  await bindModeratorRole(cfg, "grant", "sub-1", new KeycloakAdminClient(cfg, failing));
  // Unconfigured: a documented no-op — no fetch is even attempted.
  await bindModeratorRole(null, "revoke", "sub-1", new KeycloakAdminClient(cfg, failing));
});
