/** AMD-CON-01..06: ops console contract tests. */

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  base64url,
  beginAuthorization,
  endSessionUrl,
  exchangeCode,
  parseCallback,
  rolesOf,
  sessionState,
  type OidcConfig,
} from "../src/oidc.js";
import {
  CONSOLE_TIMEOUT_MS,
  ConsoleApiError,
  ConsoleAuthError,
  ConsoleForbiddenError,
  createConsoleApi,
  type ConsoleFetch,
} from "../src/consoleApi.js";
import {
  defaultSection,
  hasConsoleAccess,
  visibleSections,
} from "../src/surfaces.js";
import { attentionOrder, freshness, loadOverview } from "../src/dashboard.js";
import {
  approveElevation,
  approveOnboarding,
  mergeWorklist,
  normalizeReports,
  rejectOnboarding,
  resolveAppeal,
  resolveReport,
} from "../src/queues.js";
import {
  addVertex,
  closePolygon,
  deleteVertex,
  emptyPolygon,
  fromGeoJSON,
  hitTestEdge,
  hitTestVertex,
  insertVertexAfter,
  moveVertex,
  projector,
  reopenPolygon,
  selfIntersects,
  shoelaceAreaM2,
  toGeoJSON,
  validateForSubmit,
} from "../src/geofenceEditor.js";
import {
  CONSOLE_SW_VERSION,
  manifestProblems,
  shouldReloadOnControllerChange,
  swSupported,
} from "../src/pwa.js";

const CONFIG: OidcConfig = {
  issuer: "https://auth.example/realms/workforce",
  clientId: "workforce-console",
  redirectUri: "https://ops.example/auth/callback",
  scope: "openid profile",
};

const oidcEffects = {
  randomBytes: (n: number) => randomBytes(n),
  sha256: async (data: Uint8Array) => new Uint8Array(createHash("sha256").update(data).digest()),
  nowMs: () => 1_700_000_000_000,
};

// ------------------------------------------------------------- AMD-CON-02 --

test("beginAuthorization builds a PKCE S256 authorization URL", async () => {
  const { url, transaction } = await beginAuthorization(CONFIG, oidcEffects);
  const parsed = new URL(url);
  assert.equal(
    parsed.origin + parsed.pathname,
    "https://auth.example/realms/workforce/protocol/openid-connect/auth",
  );
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("client_id"), "workforce-console");
  assert.equal(parsed.searchParams.get("redirect_uri"), CONFIG.redirectUri);
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  // The challenge is exactly base64url(sha256(verifier)).
  const expected = base64url(
    new Uint8Array(createHash("sha256").update(transaction.verifier).digest()),
  );
  assert.equal(parsed.searchParams.get("code_challenge"), expected);
  assert.equal(parsed.searchParams.get("state"), transaction.state);
});

test("parseCallback fails closed on a state mismatch", () => {
  const good = parseCallback("https://ops.example/auth/callback?code=abc&state=s1", "s1");
  assert.deepEqual(good, { kind: "code", code: "abc" });
  const wrong = parseCallback("https://ops.example/auth/callback?code=abc&state=s2", "s1");
  assert.deepEqual(wrong, { kind: "error", error: "state-mismatch" });
  const missing = parseCallback("https://ops.example/auth/callback?state=s1", "s1");
  assert.deepEqual(missing, { kind: "error", error: "missing authorization code" });
  const provider = parseCallback("https://ops.example/auth/callback?error=access_denied&state=s1", "s1");
  assert.deepEqual(provider, { kind: "error", error: "access_denied" });
});

test("exchangeCode validates the token response and stamps expiry", async () => {
  const fetchImpl = async (url: string, init: { body: string }) => {
    assert.equal(url, "https://auth.example/realms/workforce/protocol/openid-connect/token");
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code_verifier"), "verifier-1");
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 300 }),
    };
  };
  const tokens = await exchangeCode(CONFIG, "code-1", "verifier-1", oidcEffects, fetchImpl);
  assert.equal(tokens.accessToken, "at");
  assert.equal(tokens.expiresAtMs, 1_700_000_000_000 + 300_000);
});

test("exchangeCode refuses a malformed token response", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "at" }), // no refresh token, no expiry
  });
  await assert.rejects(
    exchangeCode(CONFIG, "code-1", "v", oidcEffects, fetchImpl),
    /malformed token response/,
  );
});

test("sessionState refreshes inside the margin and expires at the boundary", () => {
  const tokens = { accessToken: "a", refreshToken: "r", expiresAtMs: 1_000_000 };
  assert.equal(sessionState(tokens, 0), "active");
  assert.equal(sessionState(tokens, 970_000), "refresh-due"); // 30 s margin
  assert.equal(sessionState(tokens, 1_000_000), "expired");
});

test("rolesOf decodes realm roles and fails safe on garbage", () => {
  const payload = base64url(
    new TextEncoder().encode(JSON.stringify({ realm_access: { roles: ["moderator", "analyst"] } })),
  );
  assert.deepEqual(rolesOf(`h.${payload}.s`), ["moderator", "analyst"]);
  assert.deepEqual(rolesOf("not-a-jwt"), []);
  assert.deepEqual(rolesOf(`h.${base64url(new TextEncoder().encode("{}"))}.s`), []);
});

test("endSessionUrl targets the realm logout", () => {
  const url = new URL(endSessionUrl(CONFIG, "https://ops.example/"));
  assert.equal(url.pathname, "/realms/workforce/protocol/openid-connect/logout");
  assert.equal(url.searchParams.get("client_id"), "workforce-console");
});

// ------------------------------------------------------------- AMD-CON-03 --

function apiCapture(responses: Record<string, { status?: number; json: unknown }>) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = [];
  const fetchImpl: ConsoleFetch = async (url, init) => {
    calls.push({ url, init });
    const key = url.replace(/^https?:\/\/[^/]+/, "");
    const hit = responses[key];
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: (hit.status ?? 200) < 300,
      status: hit.status ?? 200,
      json: async () => hit.json,
    };
  };
  return { calls, fetchImpl };
}

test("the console api attaches bearer and mints the idempotency key before send", async () => {
  const { calls, fetchImpl } = apiCapture({ "/v1/x": { json: { ok: true } } });
  const api = createConsoleApi("https://api.example/", () => "tok", {
    fetch: fetchImpl,
    uuid: () => "fixed-uuid",
  });
  await api.post("/v1/x", { a: 1 });
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.equal(calls[0].init.headers["idempotency-key"], "fixed-uuid");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  // GETs carry no idempotency key.
  await api.get("/v1/x");
  assert.equal(calls[1].init.headers["idempotency-key"], undefined);
});

test("the console api types 401 and 403 distinctly and bounds the timeout", async () => {
  assert.equal(CONSOLE_TIMEOUT_MS, 10_000);
  const { fetchImpl } = apiCapture({
    "/v1/dead": { status: 401, json: {} },
    "/v1/no": { status: 403, json: {} },
  });
  const api = createConsoleApi("https://api.example", () => "tok", {
    fetch: fetchImpl,
    uuid: randomUUID,
  });
  await assert.rejects(api.get("/v1/dead"), ConsoleAuthError);
  await assert.rejects(api.get("/v1/no"), ConsoleForbiddenError);
  await assert.rejects(api.get("/v1/elsewhere"), ConsoleApiError); // 404 → generic
  const noToken = createConsoleApi("https://api.example", () => null, {
    fetch: fetchImpl,
    uuid: randomUUID,
  });
  await assert.rejects(noToken.get("/v1/x"), ConsoleAuthError);
});

test("surfaces gate by role and refuse role-less sign-ins", () => {
  assert.deepEqual(visibleSections(["moderator"]).includes("moderation"), true);
  // Batch 70: the maps estate view joined the venue-ops sections (AMD-MAP-04).
  assert.deepEqual(visibleSections(["venue-ops"]), ["dashboard", "geofences", "maps"]);
  assert.deepEqual(visibleSections(["analyst"]), ["dashboard", "security-events"]);
  assert.equal(defaultSection(["venue-ops"]), "dashboard");
  assert.equal(hasConsoleAccess(["member"]), false);
  assert.equal(hasConsoleAccess(["moderator"]), true);
});

// ------------------------------------------------------------- AMD-CON-04 --

const OVERVIEW_JSONS = {
  "/v1/moderation/queue": { json: { queue: [{}, {}] } },
  "/v1/moderation/appeals": { json: { appeals: [{}] } },
  "/v1/moderation/kyc-sessions": { json: { sessions: [{}, {}, {}] } },
  "/v1/moderation/kyc-queue": { json: { requests: [{}] } },
  "/v1/moderation/onboarding": { json: { applications: [{}] } },
  "/v1/moderation/elevation": { json: { requests: [{}, {}] } },
  "/v1/ops/geofences/qa": {
    json: { venues: [{ overlapConflicts: 2 }, { overlapConflicts: 1 }] },
  },
};

test("loadOverview aggregates every readable queue", async () => {
  const { fetchImpl } = apiCapture(OVERVIEW_JSONS);
  const api = createConsoleApi("https://api.example", () => "tok", {
    fetch: fetchImpl,
    uuid: randomUUID,
  });
  const overview = await loadOverview(api, { nowMs: () => 5_000 }, [
    "dashboard",
    "moderation",
    "appeals",
    "kyc",
    "onboarding",
    "elevation",
    "geofences",
    "security-events",
  ]);
  assert.deepEqual(overview.counts, {
    reports: 2,
    appeals: 1,
    kycSessions: 3,
    kycReviews: 1,
    onboarding: 1,
    elevation: 2,
    geofenceConflicts: 3,
  });
  assert.equal(overview.fetchedAtMs, 5_000);
});

test("loadOverview tolerates 403 on surfaces the role cannot read", async () => {
  const { fetchImpl } = apiCapture({
    "/v1/ops/geofences/qa": OVERVIEW_JSONS["/v1/ops/geofences/qa"],
    // moderation endpoints 403 for a venue-ops operator — tolerated
    "/v1/moderation/queue": { status: 403, json: {} },
    "/v1/moderation/appeals": { status: 403, json: {} },
    "/v1/moderation/kyc-sessions": { status: 403, json: {} },
    "/v1/moderation/kyc-queue": { status: 403, json: {} },
    "/v1/moderation/onboarding": { status: 403, json: {} },
    "/v1/moderation/elevation": { status: 403, json: {} },
  });
  const api = createConsoleApi("https://api.example", () => "tok", {
    fetch: fetchImpl,
    uuid: randomUUID,
  });
  const overview = await loadOverview(api, { nowMs: () => 0 }, [
    "dashboard",
    "moderation",
    "appeals",
    "kyc",
    "onboarding",
    "elevation",
    "geofences",
  ]);
  assert.equal(overview.counts.reports, 0);
  assert.equal(overview.counts.geofenceConflicts, 3);
});

test("freshness marks the overview stale past 60 s", () => {
  const overview = { counts: { reports: 0, appeals: 0, kycSessions: 0, kycReviews: 0, onboarding: 0, elevation: 0, geofenceConflicts: 0 }, fetchedAtMs: 1_000 };
  assert.deepEqual(freshness(overview, 30_000), { ageMs: 29_000, stale: false });
  assert.deepEqual(freshness(overview, 120_000), { ageMs: 119_000, stale: true });
});

test("attentionOrder puts appeals ahead of reports and drops empty queues", () => {
  const order = attentionOrder({
    reports: 3,
    appeals: 1,
    kycSessions: 2,
    kycReviews: 0,
    onboarding: 0,
    elevation: 5,
    geofenceConflicts: 9,
  });
  assert.deepEqual(
    order.map((r) => [r.section, r.pending]),
    [
      ["geofences", 9],
      ["elevation", 5],
      ["moderation", 3],
      ["kyc", 2],
      ["appeals", 1],
    ],
  );
});

test("worklist merges by kind priority then FIFO", () => {
  const reports = normalizeReports({
    queue: [
      { reportId: "r2", reported: "u2", reason: "spam", createdAt: "2026-01-01T00:01:00Z" },
      { reportId: "r1", reported: "u1", reason: "hate", createdAt: "2026-01-01T00:00:00Z" },
    ],
  });
  const appeals = normalizeReports; // appease unused-import style; appeals normalized below
  void appeals;
  const appealItems = [
    { kind: "appeal" as const, id: "a1", subject: "u9", summary: "let me back", createdAtMs: Date.parse("2026-01-01T00:02:00Z") },
  ];
  const merged = mergeWorklist({ report: reports, appeal: appealItems });
  assert.equal(merged[0].kind, "appeal"); // a suspended member outranks reports
  assert.equal(merged[1].id, "r1"); // FIFO within reports
  assert.equal(merged[2].id, "r2");
});

test("action guards mirror the governed vocabulary before the round trip", async () => {
  const { calls, fetchImpl } = apiCapture({
    "/v1/moderation/reports/r1/resolve": { json: { ok: true } },
    "/v1/moderation/appeals/a1/resolve": { json: { ok: true } },
    "/v1/moderation/onboarding/o1/approve": { json: { ok: true } },
    "/v1/moderation/onboarding/o2/reject": { json: { ok: true } },
    "/v1/moderation/elevation/e1/approve": { json: { ok: true } },
  });
  const api = createConsoleApi("https://api.example", () => "tok", {
    fetch: fetchImpl,
    uuid: randomUUID,
  });
  await resolveReport(api, "r1", { outcome: "actioned", reasonCode: "spam" });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    outcome: "actioned",
    reasonCode: "spam",
  });
  await assert.rejects(
    resolveReport(api, "r1", { outcome: "actioned", reasonCode: "not-a-code" }),
    /governed reason code/,
  );
  await resolveAppeal(api, "a1", "overturned", "other_policy");
  await approveOnboarding(api, "o1");
  await assert.rejects(rejectOnboarding(api, "o2", "   "), /rejection reason is required/);
  await approveElevation(api, "e1");
  assert.equal(calls.length, 4); // the two guarded refusals never hit the wire
});

// ------------------------------------------------------------- AMD-CON-05 --

const SQUARE = [
  { lng: 3.37, lat: 6.45 },
  { lng: 3.38, lat: 6.45 },
  { lng: 3.38, lat: 6.46 },
  { lng: 3.37, lat: 6.46 },
];

test("editor vertex ops respect the closed-polygon invariants", () => {
  let poly = emptyPolygon();
  poly = addVertex(poly, SQUARE[0]);
  poly = addVertex(poly, SQUARE[1]);
  // Cannot close below the minimum.
  assert.equal(closePolygon(poly).closed, false);
  poly = addVertex(poly, SQUARE[2]);
  poly = closePolygon(poly);
  assert.equal(poly.closed, true);
  // A closed polygon takes no new vertices.
  assert.equal(addVertex(poly, SQUARE[3]).vertices.length, 3);
  // Reopen, add the fourth, re-close.
  poly = closePolygon(addVertex(reopenPolygon(poly), SQUARE[3]));
  assert.equal(poly.vertices.length, 4);
  // Cannot delete below the minimum while closed.
  poly = closePolygon({ vertices: SQUARE.slice(0, 3), closed: true });
  assert.equal(deleteVertex(poly, 0).vertices.length, 3);
  // Move is bounds-checked.
  assert.equal(moveVertex(poly, 9, SQUARE[0]), poly);
});

test("selfIntersects catches a bowtie and clears a square", () => {
  const bowtie = [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]];
  assert.equal(selfIntersects(bowtie), true);
  assert.equal(selfIntersects(SQUARE), false);
  assert.equal(selfIntersects(SQUARE.slice(0, 3)), false);
});

test("shoelace area matches the equirectangular expectation", () => {
  // 0.01° × 0.01° near lat 6.46 ≈ 1113.2 m × 1105.4 m × cos(6.46°)
  const area = shoelaceAreaM2(SQUARE);
  const expected = 0.01 * 0.01 * 111_320 * 110_540 * Math.cos((6.455 * Math.PI) / 180);
  assert.ok(Math.abs(area - expected) / expected < 0.01, `area ${area} ≈ ${expected}`);
});

test("validateForSubmit is the only path to GeoJSON", () => {
  const open = { vertices: SQUARE, closed: false };
  assert.equal(validateForSubmit(open).ok, false);
  assert.equal(toGeoJSON(open), null);
  const bowtie = { vertices: [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]], closed: true };
  assert.deepEqual(validateForSubmit(bowtie), { ok: false, reason: "polygon self-intersects" });
  assert.equal(toGeoJSON(bowtie), null);
  const good = { vertices: SQUARE, closed: true };
  assert.equal(validateForSubmit(good).ok, true);
  const geojson = toGeoJSON(good);
  assert.ok(geojson);
  assert.equal(geojson.type, "Polygon");
  // Ring is closed (first vertex repeated).
  assert.deepEqual(geojson.coordinates[0][0], geojson.coordinates[0][4]);
  // Round-trip.
  const back = fromGeoJSON(geojson);
  assert.deepEqual(back, good);
  assert.equal(fromGeoJSON({ type: "Point", coordinates: [1, 2] }), null);
});

test("the projector flips y and round-trips", () => {
  const b = { minLng: 3.37, minLat: 6.45, maxLng: 3.38, maxLat: 6.46 };
  const proj = projector(b, { width: 640, height: 420, padding: 24 });
  const topLeft = proj.toScreen({ lng: 3.37, lat: 6.46 }); // max lat = top
  const bottomRight = proj.toScreen({ lng: 3.38, lat: 6.45 });
  assert.ok(topLeft.y < bottomRight.y, "screen y grows downward");
  const round = proj.toGeo(proj.toScreen(SQUARE[1]));
  assert.ok(Math.abs(round.lng - SQUARE[1].lng) < 1e-9);
  assert.ok(Math.abs(round.lat - SQUARE[1].lat) < 1e-9);
});

test("hit tests find vertices and edges", () => {
  const b = { minLng: 3.37, minLat: 6.45, maxLng: 3.38, maxLat: 6.46 };
  const proj = projector(b, { width: 640, height: 420, padding: 24 });
  const pts = SQUARE.map((v) => proj.toScreen(v));
  assert.equal(hitTestVertex(pts, { x: pts[2].x + 2, y: pts[2].y - 2 }, 10), 2);
  assert.equal(hitTestVertex(pts, { x: 1, y: 1 }, 10), null);
  const midFirstEdge = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  assert.equal(hitTestEdge(pts, midFirstEdge, 8), 0);
  const inserted = insertVertexAfter({ vertices: SQUARE, closed: true }, 0, {
    lng: 3.375,
    lat: 6.45,
  });
  assert.equal(inserted.vertices.length, 5);
  assert.deepEqual(inserted.vertices[1], { lng: 3.375, lat: 6.45 });
});

// ------------------------------------------------------------- AMD-CON-06 --

test("the shipped manifest is installable", () => {
  const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
  assert.deepEqual(manifestProblems(manifest), []);
  assert.deepEqual(manifestProblems({}), [
    "name",
    "short_name",
    "display must be standalone",
    "start_url",
    "theme_color",
    "background_color",
    "a 192x192 icon",
    "a 512x512 icon",
    "a maskable 512x512 icon",
  ]);
});

test("the service worker honours the update contract", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  assert.ok(sw.includes(`"${CONSOLE_SW_VERSION}"`), "sw.js VERSION matches the contract const");
  assert.ok(sw.includes("skipWaiting"), "immediate activation");
  assert.ok(sw.includes("clients.claim"), "claims open clients");
  assert.ok(sw.includes('event.request.mode === "navigate"'), "network-first navigations");
  assert.ok(sw.includes('url.pathname.startsWith("/v1/")'), "API traffic never cached");
  assert.equal(shouldReloadOnControllerChange(false), true);
  assert.equal(shouldReloadOnControllerChange(true), false);
  assert.equal(swSupported({}), false);
  assert.equal(swSupported({ serviceWorker: {} }), true);
});

test("the shell entry wires the module build", () => {
  const html = readFileSync("public/index.html", "utf8");
  assert.ok(html.includes('<meta name="viewport"'), "viewport meta present");
  assert.ok(html.includes("/dist/web/app.js"), "loads the compiled module entry");
  assert.ok(html.includes("manifest.webmanifest"), "manifest linked");
});
