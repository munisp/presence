/**
 * AMD-CRT-01..04: client runtime wiring — the API client chokepoint,
 * the proactive session runtime, the single-flight outbox pump, and the
 * realtime adapter, plus their cross-mirror pins.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_TIMEOUT_MS,
  executeMutation,
  executeRead,
  onMutationUnauthorized,
  type ApiClientEffects,
  type WireResponse,
} from "../src/presence/apiClient.js";
import {
  createRefreshCoordinator,
  nextRefreshDelayMs,
  runProactiveRefresh,
  type RefreshEffects,
} from "../src/presence/sessionRuntime.js";
import {
  createOutboxPump,
  nextWakeAtMs,
  pumpAllowed,
  type PumpEffects,
} from "../src/presence/outboxPump.js";
import {
  channelAllowed,
  createRealtimeAdapter,
  REALTIME_RECONNECT_BASE_MS,
  REALTIME_RECONNECT_CAP_MS,
  REALTIME_TOKEN_LIFESPAN_S,
  REALTIME_TOKEN_REFRESH_MARGIN_S,
  reconnectDelayMs,
  realtimeMode,
  subscriptionPlan,
  tokenRefreshDueAtMs,
  tokenUsable,
  type RealtimeAdapterEffects,
} from "../src/presence/realtime.js";
import {
  REFRESH_ATTEMPTS,
  REFRESH_BACKOFF_MS,
  REFRESH_MARGIN_S,
  type SessionTokens,
  type TokenResponseLike,
} from "../src/presence/session.js";
import { INITIAL_CONNECTIVITY, type ConnectivitySample } from "../src/presence/connectivity.js";
import { OUTBOX_MAX_ENTRIES, type OutboxEntry } from "../src/presence/outbox.js";
import { RUNTIME_DEPENDENCY_COUNT } from "../src/presence/dependencyBudget.js";

// ------------------------------------------------------------------ helpers --

const NOW = 1_700_000_000_000;

function tokens(overrides: Partial<SessionTokens> = {}): SessionTokens {
  return {
    accessToken: "at",
    expiresAtMs: NOW + 300_000,
    refreshToken: "rt",
    deviceId: "dev-1",
    ...overrides,
  };
}

function apiEffects(overrides: Partial<ApiClientEffects> = {}) {
  const calls: Array<{ req: { method: string; path: string; headers: Record<string, string>; body?: string }; timeoutMs: number }> = [];
  const recorded: Array<{ ok: boolean; rttMs?: number }> = [];
  const effects: ApiClientEffects = {
    fetch: async (req, timeoutMs) => {
      calls.push({ req, timeoutMs });
      return { status: 200, body: "{}", rttMs: 120 } satisfies WireResponse;
    },
    nowMs: () => NOW,
    uuid: (() => {
      let n = 0;
      return () => `uuid-${++n}`;
    })(),
    random: () => 0.5,
    record: (r) => recorded.push(r),
    ...overrides,
  };
  return { effects, calls, recorded };
}

const ONLINE: ConnectivitySample = { ...INITIAL_CONNECTIVITY, state: "online" };
const OFFLINE: ConnectivitySample = { ...INITIAL_CONNECTIVITY, state: "offline" };
const DEGRADED: ConnectivitySample = { ...INITIAL_CONNECTIVITY, state: "degraded" };

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "e1",
    method: "POST",
    path: "/v1/messages",
    body: "{}",
    idempotencyKey: "k1",
    enqueuedAtMs: NOW,
    attempts: 0,
    nextAttemptAtMs: NOW,
    poisoned: false,
    ...overrides,
  };
}

// ----------------------------------------------------------- AMD-CRT-01 ----

test("AMD-CRT-01: reads carry bearer, device id, and the protocol version", async () => {
  const { effects, calls } = apiEffects();
  const out = await executeRead(effects, tokens(), { method: "GET", path: "/v1/scan" });
  assert.equal(out.kind, "response");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].req.headers.authorization, "Bearer at");
  assert.equal(calls[0].req.headers["x-device-id"], "dev-1");
  assert.equal(calls[0].req.headers["x-client-version"], "1");
  assert.equal(calls[0].timeoutMs, DEFAULT_TIMEOUT_MS);
});

test("AMD-CRT-01: every outcome feeds the classifier — success with rtt, failure without", async () => {
  const { effects, recorded } = apiEffects();
  await executeRead(effects, tokens(), { method: "GET", path: "/v1/scan" });
  assert.deepEqual(recorded, [{ ok: true, rttMs: 120 }]);

  const failing = apiEffects({
    fetch: async () => {
      throw new Error("socket dead");
    },
  });
  const out = await executeRead(failing.effects, tokens(), { method: "GET", path: "/v1/scan" });
  assert.equal(out.kind, "network-failure");
  assert.deepEqual(failing.recorded, [{ ok: false }]);
});

test("AMD-CRT-01: an offline mutation enqueues straight away — no doomed attempt", async () => {
  const { effects, calls } = apiEffects();
  const result = await executeMutation(effects, tokens(), OFFLINE, {
    method: "POST",
    path: "/v1/messages",
    body: '{"text":"hi"}',
  }, []);
  assert.equal(calls.length, 0, "the wire is never touched while offline");
  assert.equal(result.outcome.kind, "queued");
  assert.equal(result.queue.length, 1);
  assert.equal(result.queue[0].idempotencyKey, "uuid-1");
});

test("AMD-CRT-01: a wire failure enqueues the SAME idempotency key it sent", async () => {
  const sentKeys: string[] = [];
  const { effects } = apiEffects({
    fetch: async (req) => {
      sentKeys.push(req.headers["idempotency-key"]);
      throw new Error("connection reset");
    },
  });
  const result = await executeMutation(effects, tokens(), ONLINE, {
    method: "POST",
    path: "/v1/messages",
    body: '{"text":"hi"}',
  }, []);
  assert.equal(result.outcome.kind, "queued");
  if (result.outcome.kind === "queued") {
    assert.equal(sentKeys.length, 1);
    assert.equal(result.outcome.entry.idempotencyKey, sentKeys[0]);
  }
});

test("AMD-CRT-01: a full outbox refuses closed — the tap is surfaced, never dropped silently", async () => {
  const full = Array.from({ length: OUTBOX_MAX_ENTRIES }, (_, i) => entry({ id: `e${i}` }));
  const { effects } = apiEffects();
  const result = await executeMutation(effects, tokens(), OFFLINE, {
    method: "POST",
    path: "/v1/messages",
    body: "{}",
  }, full);
  assert.equal(result.outcome.kind, "refused");
  if (result.outcome.kind === "refused") {
    assert.equal(result.outcome.reason, "queue-full");
  }
});

test("AMD-CRT-01: the 401 decision is exactly-one-retry then reauthentication", () => {
  assert.equal(onMutationUnauthorized(false), "refresh-retry");
  assert.equal(onMutationUnauthorized(true), "reauthenticate");
});

// ----------------------------------------------------------- AMD-CRT-02 ----

test("AMD-CRT-02: the proactive refresh is scheduled at the margin", () => {
  const t = tokens({ expiresAtMs: NOW + 300_000 });
  assert.equal(nextRefreshDelayMs(t, NOW), 300_000 - REFRESH_MARGIN_S * 1000);
  assert.equal(nextRefreshDelayMs(t, NOW + 300_000), 0, "never negative");
});

function refreshEffects(overrides: Partial<RefreshEffects> = {}) {
  const sleeps: number[] = [];
  const refreshes: string[] = [];
  const delegate =
    overrides.refresh ??
    (async () => ({ access_token: "at2", expires_in: 300, refresh_token: "rt2" }));
  const effects: RefreshEffects = {
    ...overrides,
    // Recording wraps the delegate so overridden refreshes still count.
    refresh: async (refreshToken, deviceId) => {
      refreshes.push(refreshToken);
      return delegate(refreshToken, deviceId);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    nowMs: () => NOW,
    random: () => 0.5,
  };
  return { effects, sleeps, refreshes };
}

test("AMD-CRT-02: a successful refresh rotates and reports refreshed", async () => {
  const { effects } = refreshEffects();
  const result = await runProactiveRefresh(tokens(), effects);
  assert.equal(result.kind, "refreshed");
  if (result.kind === "refreshed") {
    assert.equal(result.tokens.accessToken, "at2");
    assert.equal(result.tokens.refreshToken, "rt2", "SEC-02 rotation is kept");
  }
});

test("AMD-CRT-02: network failures consume the bounded schedule, then reauthenticate", async () => {
  const { effects, refreshes, sleeps } = refreshEffects({
    refresh: async () => {
      throw new Error("offline");
    },
  });
  const result = await runProactiveRefresh(tokens(), effects);
  assert.equal(result.kind, "reauthenticate");
  assert.equal(refreshes.length, REFRESH_ATTEMPTS, "bounded — never a retry loop");
  // Full jitter: attempt i sleeps a uniform draw below REFRESH_BACKOFF_MS[i];
  // attempt 0 has base 0 and never sleeps, so only the later slots record.
  assert.equal(sleeps.length, REFRESH_ATTEMPTS - 1);
  sleeps.forEach((ms, i) => {
    const base = REFRESH_BACKOFF_MS[i + 1] ?? 0;
    assert.ok(ms >= 0 && ms < Math.max(base, 1), `attempt ${i + 1} inside jitter bounds`);
  });
});

test("AMD-CRT-02: a dead refresh token ends at once — retrying cannot help", async () => {
  const { effects, refreshes } = refreshEffects({
    refresh: async () => ({ error: "invalid_grant" }) as TokenResponseLike,
  });
  const result = await runProactiveRefresh(tokens(), effects);
  assert.equal(result.kind, "reauthenticate");
  assert.equal(refreshes.length, 1, "no retry against a server-side refusal");
});

test("AMD-CRT-02: a refresh response that keeps the refresh token is honored", async () => {
  const { effects } = refreshEffects({
    refresh: async () => ({ access_token: "at3", expires_in: 300 }),
  });
  const result = await runProactiveRefresh(tokens({ refreshToken: "rt-original" }), effects);
  assert.equal(result.kind, "refreshed");
  if (result.kind === "refreshed") {
    assert.equal(result.tokens.refreshToken, "rt-original", "never drop the credential");
  }
});

test("AMD-CRT-02: concurrent refreshers join ONE in-flight call", async () => {
  let resolveGate: (() => void) | null = null;
  let refreshCalls = 0;
  const { effects, refreshes } = refreshEffects({
    refresh: async () => {
      refreshCalls++;
      if (refreshCalls === 1) {
        // Only the FIRST call is gated — the trailing "runs afresh"
        // refresh must not wait on a gate nobody resolves.
        await new Promise<void>((resolve) => {
          resolveGate = resolve;
        });
      }
      return { access_token: "at2", expires_in: 300 };
    },
  });
  const coordinator = createRefreshCoordinator(effects);
  const a = coordinator.ensureFresh(tokens());
  const b = coordinator.ensureFresh(tokens());
  assert.equal(coordinator.inFlight(), true);
  resolveGate!();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(refreshes.length, 1, "one realm call for any number of joiners");
  assert.equal(ra.kind, "refreshed");
  assert.equal(rb.kind, "refreshed");
  assert.equal(coordinator.inFlight(), false);
  // A later refresh runs afresh.
  await coordinator.ensureFresh(tokens());
  assert.equal(refreshes.length, 2);
});

// ----------------------------------------------------------- AMD-CRT-03 ----

test("AMD-CRT-03: a dead link never spins the pump", async () => {
  let sends = 0;
  const persists: string[] = [];
  const pump = createOutboxPump({
    send: async () => {
      sends++;
      return { status: 200 };
    },
    nowMs: () => NOW,
    random: () => 0.5,
    persist: async (s) => {
      persists.push(s);
    },
  }, [entry()]);
  const result = await pump.kick("foreground", OFFLINE);
  assert.equal(result.outcome, "skipped-offline");
  assert.equal(sends, 0);
  assert.equal(persists.length, 0);
  assert.equal(pumpAllowed(OFFLINE), false);
  assert.equal(pumpAllowed(DEGRADED), true);
  assert.equal(pumpAllowed(ONLINE), true);
});

test("AMD-CRT-03: a due entry drains to ack and the mutation is persisted", async () => {
  const persists: string[] = [];
  const effects: PumpEffects = {
    send: async () => ({ status: 200 }),
    nowMs: () => NOW,
    random: () => 0.5,
    persist: async (s) => {
      persists.push(s);
    },
  };
  const pump = createOutboxPump(effects, [entry()]);
  const result = await pump.kick("enqueue", ONLINE);
  assert.equal(result.outcome, "drained");
  assert.equal(result.queue.length, 0, "acked entries leave the queue");
  assert.equal(result.persisted, true);
  assert.equal(persists.length, 1);
  assert.ok(!persists[0].includes("e1"), "the acked entry is gone from storage");
});

test("AMD-CRT-03: a not-yet-due head waits and touches nothing", async () => {
  let sends = 0;
  const persists: string[] = [];
  const pump = createOutboxPump({
    send: async () => {
      sends++;
      return { status: 200 };
    },
    nowMs: () => NOW,
    random: () => 0.5,
    persist: async (s) => {
      persists.push(s);
    },
  }, [entry({ nextAttemptAtMs: NOW + 60_000 })]);
  const result = await pump.kick("timer", ONLINE);
  assert.equal(result.outcome, "waiting");
  assert.equal(sends, 0);
  assert.equal(result.persisted, false, "an unchanged queue is not rewritten");
  assert.equal(persists.length, 0);
  assert.equal(nextWakeAtMs(result.queue), NOW + 60_000);
});

test("AMD-CRT-03: a 401 pauses the drain and the attempts counter is persisted", async () => {
  const persists: string[] = [];
  const pump = createOutboxPump({
    send: async () => ({ status: 401 }),
    nowMs: () => NOW,
    random: () => 0.5,
    persist: async (s) => {
      persists.push(s);
    },
  }, [entry()]);
  const result = await pump.kick("enqueue", ONLINE);
  assert.equal(result.outcome, "paused");
  assert.equal(result.queue[0].attempts, 1);
  assert.equal(persists.length, 1);
  assert.ok(persists[0].includes('"attempts":1'));
  // nextWakeAtMs ignores poisoned entries entirely.
  assert.equal(nextWakeAtMs([entry({ poisoned: true })]), null);
  assert.equal(nextWakeAtMs([]), null);
});

test("AMD-CRT-03: concurrent kicks join — one drain, one follow-up at most", async () => {
  let sends = 0;
  let releaseFirst: (() => void) | null = null;
  const pump = createOutboxPump({
    send: async () => {
      sends++;
      if (sends === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { status: 200 };
    },
    nowMs: () => NOW,
    random: () => 0.5,
    persist: async () => undefined,
  }, [entry()]);
  const a = pump.kick("enqueue", ONLINE);
  const b = pump.kick("foreground", ONLINE);
  assert.equal(pump.inFlight(), true);
  releaseFirst!();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.outcome, "drained");
  assert.equal(rb.outcome, "drained", "the joiner gets the cycle result");
  assert.equal(sends, 1, "the follow-up pass finds an empty queue and sends nothing");
  assert.equal(pump.inFlight(), false);
});

test("AMD-CRT-03: setQueue feeds the enqueue paths into the pump", () => {
  const pump = createOutboxPump({
    send: async () => ({ status: 200 }),
    nowMs: () => NOW,
    random: () => 0.5,
    persist: async () => undefined,
  });
  assert.equal(pump.queue().length, 0);
  pump.setQueue([entry()]);
  assert.equal(pump.queue().length, 1);
});

// ----------------------------------------------------------- AMD-CRT-04 ----

test("AMD-CRT-04: an empty wsUrl disables the tier — fail closed", () => {
  assert.equal(realtimeMode({ wsUrl: "" }, ONLINE), "disabled");
  assert.equal(realtimeMode({ wsUrl: "  " }, ONLINE), "disabled");
  assert.equal(realtimeMode({ wsUrl: "wss://rt" }, OFFLINE), "offline");
  assert.equal(realtimeMode({ wsUrl: "wss://rt" }, DEGRADED), "degraded");
  assert.equal(realtimeMode({ wsUrl: "wss://rt" }, ONLINE), "active");
});

test("AMD-CRT-04: reconnect backoff is full-jitter, base 1 s, capped at 60 s", () => {
  assert.equal(REALTIME_RECONNECT_BASE_MS, 1_000);
  assert.equal(REALTIME_RECONNECT_CAP_MS, 60_000);
  for (let attempt = 0; attempt < 12; attempt++) {
    const hi = reconnectDelayMs(attempt, () => 0.999);
    const lo = reconnectDelayMs(attempt, () => 0);
    const cap = Math.min(1_000 * 2 ** attempt, 60_000);
    assert.ok(hi < cap || hi <= 60_000);
    assert.ok(lo >= 0);
    assert.ok(lo <= hi);
  }
});

test("AMD-CRT-04: the token refreshes inside its 600-second life", () => {
  assert.equal(REALTIME_TOKEN_LIFESPAN_S, 600);
  assert.equal(tokenRefreshDueAtMs(NOW), NOW + (600 - REALTIME_TOKEN_REFRESH_MARGIN_S) * 1000);
  const token = { token: "t", channels: [], issuedAtMs: NOW };
  assert.equal(tokenUsable(token, NOW + 599_000), true);
  assert.equal(tokenUsable(token, NOW + 600_000), false);
});

test("AMD-CRT-04: the subscription plan enforces the grant and never churns on degraded", () => {
  assert.equal(channelAllowed("pair:a", ["pair:a"]), true);
  assert.equal(channelAllowed("pair:b", ["pair:a"]), false);
  const active = subscriptionPlan(["pair:a", "pair:stale"], ["pair:a", "pair:b"], "active");
  assert.deepEqual(active, { subscribe: ["pair:b"], unsubscribe: ["pair:stale"] });
  const degraded = subscriptionPlan(["pair:a", "pair:stale"], ["pair:a", "pair:b"], "degraded");
  assert.deepEqual(degraded.unsubscribe, [], "a flapping link never unsubscribes");
  assert.deepEqual(degraded.subscribe, ["pair:b"], "the initial join still lands");
  const off = subscriptionPlan(["pair:a"], [], "offline");
  assert.deepEqual(off, { subscribe: [], unsubscribe: ["pair:a"] });
});

test("AMD-CRT-04: the adapter connects on active, disconnects immediately on offline", async () => {
  const events: string[] = [];
  let fetches = 0;
  const effects: RealtimeAdapterEffects = {
    nowMs: () => NOW,
    random: () => 0.5,
    fetchToken: async () => {
      fetches++;
      return { token: "tok", channels: [`user:${"u1"}`, "pair:a"], issuedAtMs: NOW };
    },
    createClient: (url, token) => {
      events.push(`create:${url}:${token}`);
      return {
        connect: () => events.push("connect"),
        disconnect: () => events.push("disconnect"),
        subscribe: (c) => events.push(`sub:${c}`),
        unsubscribe: (c) => events.push(`unsub:${c}`),
      };
    },
  };
  const adapter = createRealtimeAdapter(effects);
  const mode = await adapter.sync({ wsUrl: "wss://rt" }, ONLINE);
  assert.equal(mode, "active");
  assert.deepEqual(events, ["create:wss://rt:tok", "connect", "sub:user:u1", "sub:pair:a"]);
  assert.deepEqual(adapter.subscriptions(), ["user:u1", "pair:a"]);

  // A second sync while the token is usable reuses it — no churn.
  await adapter.sync({ wsUrl: "wss://rt" }, ONLINE);
  assert.equal(fetches, 1);
  assert.equal(events.filter((e) => e === "connect").length, 1);

  // Offline: immediate disconnect, subscriptions and token dropped.
  const off = await adapter.sync({ wsUrl: "wss://rt" }, OFFLINE);
  assert.equal(off, "offline");
  assert.ok(events.includes("disconnect"));
  assert.deepEqual(adapter.subscriptions(), []);

  // Disabled: nothing connects at all.
  const fresh = createRealtimeAdapter(effects);
  assert.equal(await fresh.sync({ wsUrl: "" }, ONLINE), "disabled");
});

test("AMD-CRT-04: concurrent syncs join one connect", async () => {
  let fetches = 0;
  let release: (() => void) | null = null;
  const effects: RealtimeAdapterEffects = {
    nowMs: () => NOW,
    random: () => 0.5,
    fetchToken: async () => {
      fetches++;
      await new Promise<void>((r) => {
        release = r;
      });
      return { token: "tok", channels: ["user:u1"], issuedAtMs: NOW };
    },
    createClient: () => ({
      connect: () => undefined,
      disconnect: () => undefined,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
    }),
  };
  const adapter = createRealtimeAdapter(effects);
  const a = adapter.sync({ wsUrl: "wss://rt" }, ONLINE);
  const b = adapter.sync({ wsUrl: "wss://rt" }, ONLINE);
  assert.equal(adapter.connecting(), true);
  release!();
  await Promise.all([a, b]);
  assert.equal(fetches, 1);
  assert.equal(adapter.connecting(), false);
});

// --------------------------------------------------------- cross-mirror ----

test("cross-mirror: the addendum, edge route, allowlist, and budget all carry batch 66", () => {
  const addendum = readFileSync("../docs/spec/srs-addendum-001.md", "utf8");
  for (const id of ["AMD-CRT-01", "AMD-CRT-02", "AMD-CRT-03", "AMD-CRT-04"]) {
    assert.ok(addendum.includes(`**${id} (`), `${id} documented in the addendum`);
  }

  const tokenRoute = readFileSync("../services/edge/src/realtimeToken.ts", "utf8");
  assert.ok(tokenRoute.includes("CENTRIFUGO_TOKEN_HMAC_SECRET_KEY"), "the HMAC secret gates issue");
  assert.ok(tokenRoute.includes("503"), "fail closed when unconfigured");
  assert.ok(tokenRoute.includes("closed_at IS NULL"), "closed pairs never grant channels");

  const allowlist = readFileSync("../docs/security/sdk-allowlist.json", "utf8");
  assert.ok(allowlist.includes('"name": "centrifuge"'), "centrifuge on the SEC-18 allowlist");

  assert.equal(RUNTIME_DEPENDENCY_COUNT, 8, "centrifuge admitted through the TECH-16 gate");

  const config = readFileSync("../services/edge/src/clientConfig.ts", "utf8");
  assert.ok(config.includes("REALTIME_PUBLIC_WS_URL"), "the bootstrap carries the realtime block");
});
