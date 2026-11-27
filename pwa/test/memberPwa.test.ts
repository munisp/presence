/**
 * AMD-PWA-01..06 contract tests — the live behaviour behind the pytest
 * pins in tests/test_batch68.py. Plain node --test against the compiled
 * ESM, same discipline as the console suite.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  beginAuthorization,
  parseCallback,
  sessionState,
  subjectOf,
  PKCE_VERIFIER_BYTES,
  SESSION_REFRESH_MARGIN_MS,
  type OidcConfig,
  type TokenSet,
} from "../src/oidc.js";
import { createMemberApi, MemberAuthError, MemberNotFoundError } from "../src/memberApi.js";
import {
  featureGateForLink,
  initialClassifierState,
  observe,
  withBrowserSignal,
} from "../src/connectivity.js";
import {
  isReadCacheKey,
  readDocument,
  wipeReadCache,
  writeDocument,
  READ_CACHE_MAX_BYTES,
  READ_CACHE_STORAGE_KEY,
} from "../src/readCache.js";
import {
  drainOnce,
  enqueue,
  pendingEntries,
  poisonedEntries,
  wipeOutbox,
  OUTBOX_MAX_ENTRIES,
  OUTBOX_STORAGE_KEY,
  type OutboxEntry,
} from "../src/outbox.js";
import {
  attentionItems,
  badgeCountFor,
  fetchHome,
  formatMinor,
  type HomeDocument,
} from "../src/home.js";
import { deleteConfirmed, parseDevices, wipeAll, PERSISTED_KEYS } from "../src/account.js";
import { applyBadge, manifestProblems, shouldReloadOnControllerChange } from "../src/pwa.js";

const CONFIG: OidcConfig = {
  issuer: "https://auth.example/realms/consumer",
  clientId: "presence-web",
  redirectUri: "https://app.example/auth/callback",
  scope: "openid profile",
};

const effects = {
  randomBytes: (n: number) => new Uint8Array(n).fill(7),
  sha256: async (data: Uint8Array) => new Uint8Array(32).fill(data.length),
  nowMs: () => 1_000_000,
};

function memoryStorage(): Map<string, string> & {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
} {
  const map = new Map<string, string>();
  return Object.assign(map, {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
}

/* AMD-PWA-02 — member sign-in */

test("beginAuthorization mints a PKCE S256 transaction and the auth URL", async () => {
  const { url, transaction } = await beginAuthorization(CONFIG, effects);
  assert.equal(transaction.verifier.length > 0, true);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("client_id"), "presence-web");
  assert.equal(parsed.searchParams.get("state"), transaction.state);
  assert.equal(PKCE_VERIFIER_BYTES, 32);
});

test("parseCallback fails closed on state mismatch", () => {
  const result = parseCallback("https://app.example/auth/callback?code=abc&state=wrong", "right");
  assert.deepEqual(result, { kind: "error", error: "state-mismatch" });
});

test("sessionState flips to refresh-due inside the margin", () => {
  const tokens: TokenSet = { accessToken: "a", refreshToken: "r", expiresAtMs: 100_000 };
  assert.equal(sessionState(tokens, 100_000 - SESSION_REFRESH_MARGIN_MS - 1), "active");
  assert.equal(sessionState(tokens, 100_000 - SESSION_REFRESH_MARGIN_MS), "refresh-due");
  assert.equal(sessionState(tokens, 100_000), "expired");
});

test("subjectOf never throws on garbage", () => {
  assert.equal(subjectOf("not-a-jwt"), null);
  const jwt = `x.${Buffer.from(JSON.stringify({ sub: "member-1" })).toString("base64url")}.y`;
  assert.equal(subjectOf(jwt), "member-1");
});

/* AMD-PWA-03 — member transport */

test("memberApi mints an idempotency key before send and types 401/404", async () => {
  const seen: { headers: Record<string, string>; method: string }[] = [];
  const api = createMemberApi("", () => "token", {
    fetch: async (url, init) => {
      seen.push({ headers: init.headers, method: init.method });
      if (url.endsWith("/gone")) return { ok: false, status: 404, json: async () => ({}) };
      if (url.endsWith("/dead")) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    uuid: () => "uuid-1",
    nowMs: () => 0,
    observe: () => {},
  });
  await api.post("/v1/consent/p1/express", {});
  assert.equal(seen[0].headers["idempotency-key"], "uuid-1");
  await assert.rejects(() => api.get("/gone"), MemberNotFoundError);
  await assert.rejects(() => api.get("/dead"), MemberAuthError);
});

test("memberApi replays the outbox's enqueue-time idempotency key", async () => {
  const seen: string[] = [];
  const api = createMemberApi("", () => "token", {
    fetch: async (_url, init) => {
      seen.push(init.headers["idempotency-key"]);
      return { ok: true, status: 200, json: async () => ({}) };
    },
    uuid: () => "fresh-uuid",
    nowMs: () => 0,
    observe: () => {},
  });
  await api.post("/v1/consent/p1/express", {}, "enqueue-time-key");
  assert.deepEqual(seen, ["enqueue-time-key"]);
});

test("memberApi reports observations to the classifier", async () => {
  const observations: { ok: boolean; rttMs?: number }[] = [];
  const api = createMemberApi("", () => "token", {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    uuid: () => "u",
    nowMs: (() => {
      let t = 0;
      return () => (t += 100);
    })(),
    observe: (obs) => observations.push(obs),
  });
  await api.get("/v1/wallets");
  assert.equal(observations.length, 1);
  assert.equal(observations[0].ok, true);
});

/* AMD-PWA-04 — classifier, read cache, outbox */

test("classifier demotes on failures and promotes with hysteresis", () => {
  let link = initialClassifierState();
  link = observe(link, { ok: false });
  assert.equal(link.state, "online");
  link = observe(link, { ok: false });
  assert.equal(link.state, "offline");
  assert.equal(featureGateForLink(link.state), "none");
  link = observe(link, { ok: true, rttMs: 100 });
  assert.equal(link.state, "offline"); // hysteresis: one probe is not enough
  link = observe(link, { ok: true, rttMs: 100 });
  assert.equal(link.state, "degraded"); // one step at a time
  link = observe(link, { ok: true, rttMs: 100 });
  link = observe(link, { ok: true, rttMs: 100 });
  assert.equal(link.state, "online");
});

test("browser offline signal short-circuits to offline", () => {
  const link = withBrowserSignal(initialClassifierState(), false);
  assert.equal(link.state, "offline");
  assert.equal(featureGateForLink(link.state), "none");
});

test("read cache is allowlisted, wholesale, stale-marked and capped", () => {
  const storage = memoryStorage();
  assert.equal(isReadCacheKey("consent:pairs"), true);
  assert.equal(isReadCacheKey("admin:secrets"), false);
  writeDocument(storage, "consent:pairs", [{ pairId: "p1" }], 1_000);
  assert.equal(readDocument(storage, "consent:pairs", 1_000 + 60_000).kind, "fresh");
  assert.equal(readDocument(storage, "consent:pairs", 1_000 + 300_000).kind, "stale");
  writeDocument(storage, "consent:pairs", [{ pairId: "p2" }], 2_000);
  const hit = readDocument(storage, "consent:pairs", 2_000);
  assert.deepEqual(hit.kind === "fresh" ? hit.document : null, [{ pairId: "p2" }]);
  assert.equal((storage.getItem(READ_CACHE_STORAGE_KEY) ?? "").length <= READ_CACHE_MAX_BYTES + 4096, true);
  wipeReadCache(storage);
  assert.equal(readDocument(storage, "consent:pairs", 2_000).kind, "absent");
});

test("outbox drains FIFO, pauses on 401, poisons on 4xx", async () => {
  const storage = memoryStorage();
  const fx = { nowMs: () => 0, uuid: (() => { let n = 0; return () => `id-${++n}`; })(), random: () => 0.5 };
  enqueue(storage, { method: "POST", path: "/a", body: {} }, fx);
  enqueue(storage, { method: "POST", path: "/b", body: {} }, fx);
  assert.equal(pendingEntries(storage).length, 2);
  const sentOrder: string[] = [];
  const result = await drainOnce(
    storage,
    async (entry: OutboxEntry) => {
      sentOrder.push(entry.path);
      return entry.path === "/a" ? { kind: "ack" } : { kind: "pause" };
    },
    fx,
  );
  assert.deepEqual(sentOrder, ["/a", "/b"]);
  assert.equal(result.paused, true);
  assert.equal(pendingEntries(storage).length, 1); // /b survives the pause
  await drainOnce(storage, async () => ({ kind: "poison" }) as const, fx);
  assert.equal(poisonedEntries(storage).length, 1);
  wipeOutbox(storage);
  assert.equal(storage.getItem(OUTBOX_STORAGE_KEY), null);
});

test("outbox refuses a full queue loudly", () => {
  const storage = memoryStorage();
  const fx = { nowMs: () => 0, uuid: () => "id", random: () => 0.5 };
  for (let i = 0; i < OUTBOX_MAX_ENTRIES; i += 1) {
    enqueue(storage, { method: "POST", path: `/p${i}`, body: {} }, fx);
  }
  assert.throws(() => enqueue(storage, { method: "POST", path: "/overflow", body: {} }, fx), /outbox-full/);
});

/* AMD-PWA-03 — home document */

const HOME: HomeDocument = {
  identity: { kind: "ok", document: { handle: "ada", displayName: "Ada", photoUrl: null } },
  kycStatus: { kind: "ok", document: "pending" },
  pairs: {
    kind: "ok",
    document: [
      { pairId: "p1", state: "NUDGED", counterpart: null, offerExpiresAt: null },
      { pairId: "p2", state: "OPEN", counterpart: "grace", offerExpiresAt: null },
    ],
  },
  wallets: {
    kind: "ok",
    document: [
      { walletId: "w1", currency: "NGN", status: "active", balanceMinor: 125_000, heldMinor: 5_000, availableMinor: 120_000 },
    ],
  },
};

test("attention model orders pairs before kyc before holds", () => {
  const items = attentionItems(HOME);
  assert.equal(items[0].kind, "pair-awaiting-you");
  assert.equal(items.some((i) => i.kind === "kyc-incomplete"), true);
  assert.equal(items.some((i) => i.kind === "wallet-on-hold"), true);
});

test("badge counts only pairs awaiting the member", () => {
  assert.equal(badgeCountFor(HOME), 1);
});

test("fetchHome tolerates 404 identity and keeps the rest", async () => {
  const api = createMemberApi("", () => "token", {
    fetch: async (url) => {
      if (url.endsWith("/v1/profile/identity")) return { ok: false, status: 404, json: async () => ({}) };
      if (url.endsWith("/v1/identity/status")) return { ok: true, status: 200, json: async () => ({ status: "verified" }) };
      if (url.endsWith("/v1/consent")) return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      return { ok: true, status: 200, json: async () => ({ wallets: [] }) };
    },
    uuid: () => "u",
    nowMs: () => 0,
    observe: () => {},
  });
  const home = await fetchHome(api);
  assert.equal(home.identity.kind, "absent");
  assert.equal(home.kycStatus.kind, "ok");
});

test("formatMinor renders NGN with the naira sign", () => {
  assert.equal(formatMinor(125_000, "NGN"), "₦1,250.00");
  assert.equal(formatMinor(125_000, "USD"), "USD 1,250.00");
});

/* AMD-PWA-05 — installability and update discipline */

test("shipped manifest is installable", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url)); // dist/test
  const manifest = JSON.parse(readFileSync(join(here, "../../public/manifest.webmanifest"), "utf8"));
  assert.deepEqual(manifestProblems(manifest), []);
});

test("controllerchange reload is once-guarded", () => {
  assert.equal(shouldReloadOnControllerChange(false), true);
  assert.equal(shouldReloadOnControllerChange(true), false);
});

test("applyBadge sets and clears, and no-ops without support", async () => {
  const calls: (number | undefined)[] = [];
  const nav = { setAppBadge: async (n?: number) => void calls.push(n), clearAppBadge: async () => void calls.push(0) };
  await applyBadge(nav, 3);
  await applyBadge(nav, 0);
  assert.deepEqual(calls, [3, 0]);
  await applyBadge({}, 5); // unsupported — must not throw
});

/* AMD-PWA-06 — privacy self-service */

test("delete confirmation is the exact phrase", () => {
  assert.equal(deleteConfirmed("DELETE"), true);
  assert.equal(deleteConfirmed(" DELETE "), true);
  assert.equal(deleteConfirmed("delete"), false);
  assert.equal(deleteConfirmed("DELET"), false);
});

test("wipeAll removes every persisted key from every storage", () => {
  const a = memoryStorage();
  const b = memoryStorage();
  for (const key of PERSISTED_KEYS) {
    a.setItem(key, "x");
    b.setItem(key, "x");
  }
  wipeAll([a, b]);
  for (const key of PERSISTED_KEYS) {
    assert.equal(a.getItem(key), null);
    assert.equal(b.getItem(key), null);
  }
});

test("parseDevices tolerates snake_case and missing fields", () => {
  const devices = parseDevices({
    devices: [
      { device_id: "d1", platform: "android", last_seen_at: "2026-11-01" },
      { deviceId: "d2", platform: "ios", lastSeenAt: null },
      { platform: "broken" },
    ],
  });
  assert.equal(devices.length, 2);
  assert.equal(devices[0].deviceId, "d1");
  assert.equal(devices[1].lastSeenAt, null);
});
