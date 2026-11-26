/**
 * Batch 65 — AMD-NET-01..05: the offline and poor-connectivity pack.
 *
 * Pins the action outbox (FIFO, enqueue-time idempotency keys, bounded
 * full-jitter retries, poison rules, caps), the bounded read cache
 * (allowlist, stale flags, wholesale replace, corruption), the
 * connectivity classifier (state machine, hysteresis, feature gates),
 * the session's bounded refresh retry inside the 30 s margin, the
 * last-mile transfer budgets, and the wipe-by-construction extension —
 * plus cross-mirror pins on the spec addendum, the edge compression and
 * conditional config, and the documentation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_BODY_BYTES,
  OUTBOX_MAX_ENTRIES,
  OUTBOX_STORAGE_KEY,
  backoffDelayMs,
  classifyResponse,
  drainOutbox,
  enqueueAction,
  loadOutbox,
  pendingCount,
  poisonedEntries,
  retryPoisoned,
  serializeOutbox,
  type OutboxContext,
  type OutboxEntry,
} from "../src/presence/outbox.js";
import {
  READ_CACHE_MAX_BYTES,
  READ_CACHE_STORAGE_KEY,
  READ_CACHE_TTLS_MS,
  isReadCacheKey,
  loadReadCache,
  putDocument,
  readDocument,
  serializeReadCache,
  type ReadCache,
} from "../src/presence/readCache.js";
import {
  DEGRADED_RTT_MS,
  FAILURE_WINDOW,
  INITIAL_CONNECTIVITY,
  LINK_SURFACE_MAP,
  featureGateForLink,
  recordObservation,
} from "../src/presence/connectivity.js";
import {
  LINK_PROFILES,
  SURFACE_TRANSFER_BUDGETS,
  budgetReport,
  fitsTransferBudget,
  maxBytesForBudget,
  transferSeconds,
} from "../src/presence/transferBudget.js";
import {
  REFRESH_ATTEMPTS,
  REFRESH_BACKOFF_MS,
  REFRESH_MARGIN_S,
  onUnauthorized,
  refreshAttemptDelayMs,
  refreshScheduleFitsMargin,
} from "../src/presence/session.js";
import {
  LOCAL_STATE_ALLOWLIST,
  clearLocalState,
  createMemoryBackend,
} from "../src/presence/localState.js";
import { ENGLISH_COPY } from "../src/presence/copyRegistry.js";

// ------------------------------------------------------------ test rig --

let uuidCounter = 0;
function makeCtx(nowMs: number, random: () => number = () => 0.5): OutboxContext {
  return {
    nowMs: () => nowMs,
    uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    random,
  };
}

function draft(body = "{}"): { method: "POST"; path: string; body: string } {
  return { method: "POST", path: "/v1/presence", body };
}

// ------------------------------------------------ AMD-NET-01: the outbox --

test("outbox: enqueue mints the idempotency key at enqueue time", () => {
  const { queue, result } = enqueueAction([], draft(), makeCtx(1_000));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const entry = result.entry;
  assert.equal(queue.length, 1);
  assert.match(entry.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(entry.attempts, 0);
  assert.equal(entry.poisoned, false);
  assert.equal(entry.nextAttemptAtMs, 1_000); // due immediately
  // A retry reuses the SAME key — minted once, at enqueue.
  const afterFailure = retryPoisoned([{ ...entry, poisoned: true }], entry.id, 2_000);
  assert.equal(afterFailure[0]!.idempotencyKey, entry.idempotencyKey);
});

test("outbox: caps fail closed — 100 entries, 64 KiB bodies", () => {
  assert.equal(OUTBOX_MAX_ENTRIES, 100);
  assert.equal(OUTBOX_MAX_BODY_BYTES, 64 * 1024);
  const full = Array.from({ length: OUTBOX_MAX_ENTRIES }, (_, i) => ({
    id: `e${i}`, method: "POST" as const, path: "/v1/x", body: "{}",
    idempotencyKey: `k${i}`, enqueuedAtMs: 0, attempts: 0, nextAttemptAtMs: 0, poisoned: false,
  }));
  const over = enqueueAction(full, draft(), makeCtx(0));
  assert.deepEqual(over.result, { ok: false, reason: "queue-full" });
  assert.equal(over.queue.length, OUTBOX_MAX_ENTRIES);
  const big = enqueueAction([], draft("x".repeat(OUTBOX_MAX_BODY_BYTES + 1)), makeCtx(0));
  assert.deepEqual(big.result, { ok: false, reason: "body-too-large" });
});

test("outbox: response classification — 2xx ack, 401 pause, 426 and 4xx poison", () => {
  assert.equal(classifyResponse(200), "ack");
  assert.equal(classifyResponse(204), "ack");
  assert.equal(classifyResponse(401), "pause");
  assert.equal(classifyResponse(426), "poison");
  assert.equal(classifyResponse(400), "poison");
  assert.equal(classifyResponse(404), "poison");
  assert.equal(classifyResponse(422), "poison");
  assert.equal(classifyResponse(500), "retry");
  assert.equal(classifyResponse(503), "retry");
});

test("outbox: drain is FIFO — acks remove, later entries follow in order", async () => {
  const ctx = makeCtx(0);
  let q = enqueueAction([], draft('{"n":1}'), ctx).queue;
  q = enqueueAction(q, draft('{"n":2}'), ctx).queue;
  const sent: string[] = [];
  const { queue, outcome } = await drainOutbox(q, async (e) => {
    sent.push(e.body);
    return { status: 200 };
  }, ctx);
  assert.deepEqual(sent, ['{"n":1}', '{"n":2}']);
  assert.equal(queue.length, 0);
  assert.equal(outcome, "drained");
});

test("outbox: 401 pauses the whole drain — nothing leapfrogs the head", async () => {
  const ctx = makeCtx(0);
  let q = enqueueAction([], draft('{"n":1}'), ctx).queue;
  q = enqueueAction(q, draft('{"n":2}'), ctx).queue;
  const sent: string[] = [];
  const { queue, outcome } = await drainOutbox(q, async (e) => {
    sent.push(e.body);
    return { status: 401 };
  }, ctx);
  assert.deepEqual(sent, ['{"n":1}']); // the second entry never ran
  assert.equal(outcome, "paused");
  assert.equal(pendingCount(queue), 2);
  assert.equal(queue[0]!.attempts, 1); // the attempt is recorded
});

test("outbox: 4xx poisons without blocking the entries behind it", async () => {
  const ctx = makeCtx(0);
  let q = enqueueAction([], draft('{"n":1}'), ctx).queue;
  q = enqueueAction(q, draft('{"n":2}'), ctx).queue;
  const statuses = [422, 200];
  const { queue, outcome } = await drainOutbox(q, async () => ({ status: statuses.shift()! }), ctx);
  assert.equal(outcome, "drained");
  assert.equal(queue.length, 1); // the acked entry left; the poisoned one stays
  assert.equal(poisonedEntries(queue).length, 1);
  assert.equal(pendingCount(queue), 0); // entry 2 acked and left
});

test("outbox: retries are bounded — the fifth failure poisons", async () => {
  const ctx = makeCtx(0);
  let q = enqueueAction([], draft(), ctx).queue;
  assert.equal(OUTBOX_MAX_ATTEMPTS, 5);
  for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
    const res = await drainOutbox(q, async () => ({ status: 500 }), ctx);
    q = res.queue;
    if (attempt < OUTBOX_MAX_ATTEMPTS) {
      assert.equal(res.outcome, "waiting");
      assert.equal(q[0]!.attempts, attempt);
      assert.equal(q[0]!.poisoned, false);
      // Fast-forward past the backoff to run the next attempt.
      q = q.map((e) => ({ ...e, nextAttemptAtMs: 0 }));
    } else {
      assert.equal(q[0]!.poisoned, true);
      assert.equal(poisonedEntries(q).length, 1);
    }
  }
});

test("outbox: network failure is a retry, not a poison", async () => {
  const ctx = makeCtx(0);
  const q0 = enqueueAction([], draft(), ctx).queue;
  const { queue, outcome } = await drainOutbox(
    q0,
    async () => { throw new Error("ECONNRESET"); },
    ctx,
  );
  assert.equal(outcome, "waiting");
  assert.equal(queue[0]!.attempts, 1);
  assert.equal(queue[0]!.poisoned, false);
});

test("outbox: backoff is full-jitter, base 2 s, capped at 5 minutes", () => {
  assert.equal(backoffDelayMs(1, () => 0), 0);
  assert.equal(backoffDelayMs(1, () => 0.999) < 2_000, true);
  assert.equal(backoffDelayMs(2, () => 0.999) < 4_000, true);
  assert.equal(backoffDelayMs(3, () => 0.999) < 8_000, true);
  assert.equal(backoffDelayMs(20, () => 0.999) < 300_000, true); // capped
});

test("outbox: persistence round-trips; corrupt JSON loads empty", () => {
  const ctx = makeCtx(0);
  const q = enqueueAction([], draft('{"x":1}'), ctx).queue;
  const restored = loadOutbox(serializeOutbox(q));
  assert.deepEqual(restored, q);
  assert.deepEqual(loadOutbox("not json"), []);
  assert.deepEqual(loadOutbox('{"version":1}'), []);
  assert.deepEqual(loadOutbox(null), []);
});

// ------------------------------------------- AMD-NET-02: the read cache --

test("read cache: the allowlist is exactly four document kinds", () => {
  assert.equal(isReadCacheKey("scan:last"), true);
  assert.equal(isReadCacheKey("conversations:list"), true);
  assert.equal(isReadCacheKey("venues:nearby"), true);
  assert.equal(
    isReadCacheKey("messages:123e4567-e89b-42d3-a456-426614174000:page0"),
    true,
  );
  assert.equal(isReadCacheKey("messages:whatever:page0"), false);
  assert.equal(isReadCacheKey("messages:123e4567-e89b-42d3-a456-426614174000:page1"), false);
  assert.equal(isReadCacheKey("location:history"), false);
  assert.equal(isReadCacheKey("contacts"), false);
});

test("read cache: fresh within the TTL, stale after it, absent never resurrects", () => {
  const put = putDocument({}, "scan:last", { results: [] }, 1_000);
  assert.equal(put.ok, true);
  if (!put.ok) return;
  const fresh = readDocument(put.cache, "scan:last", 1_000 + READ_CACHE_TTLS_MS["scan:last"]!);
  assert.equal(fresh.state, "fresh");
  const stale = readDocument(put.cache, "scan:last", 1_000 + READ_CACHE_TTLS_MS["scan:last"]! + 1);
  if (stale.state === "stale") assert.equal(stale.cachedAtMs, 1_000);
  else assert.fail(`expected stale, got ${stale.state}`);
  assert.equal(readDocument(put.cache, "venues:nearby", 1_000).state, "absent");
  assert.equal(readDocument(put.cache, "location:history", 1_000).state, "absent");
});

test("read cache: refresh replaces WHOLESALE — never merges", () => {
  const first = putDocument({}, "conversations:list", { items: ["a", "b"] }, 1_000);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = putDocument(first.cache, "conversations:list", { items: ["c"] }, 2_000);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const read = readDocument(second.cache, "conversations:list", 2_000);
  if (read.state === "fresh") {
    assert.deepEqual(read.payload, { items: ["c"] }); // no "a"/"b" leaked through
  } else {
    assert.fail(`expected fresh, got ${read.state}`);
  }
});

test("read cache: corrupt JSON and schema drift read as empty", () => {
  assert.deepEqual(loadReadCache("not json"), {});
  assert.deepEqual(loadReadCache('{"version":999,"documents":{}}'), {});
  assert.deepEqual(loadReadCache(null), {});
  const cache: ReadCache = {};
  const put = putDocument(cache, "scan:last", { ok: true }, 500);
  assert.equal(put.ok, true);
  if (!put.ok) return;
  const restored = loadReadCache(serializeReadCache(put.cache));
  assert.equal(readDocument(restored, "scan:last", 500).state, "fresh");
  // Non-allowlisted keys smuggled into the store are dropped on load.
  const smuggled = JSON.stringify({
    version: 1,
    documents: { "location:history": { schemaVersion: 1, cachedAtMs: 0, payload: [] } },
  });
  assert.deepEqual(loadReadCache(smuggled), {});
});

test("read cache: the 256 KiB cap evicts oldest-first, oversize refuses", () => {
  assert.equal(READ_CACHE_MAX_BYTES, 256 * 1024);
  let cache: ReadCache = {};
  const filler = "x".repeat(90 * 1024);
  for (const key of ["scan:last", "conversations:list"] as const) {
    const put = putDocument(cache, key, { data: filler }, 1_000);
    assert.equal(put.ok, true);
    if (put.ok) cache = put.cache;
  }
  // A third large document evicts the oldest (scan:last) to fit the cap.
  const third = putDocument(cache, "venues:nearby", { data: filler }, 2_000);
  assert.equal(third.ok, true);
  if (!third.ok) return;
  assert.equal(readDocument(third.cache, "scan:last", 2_000).state, "absent");
  assert.equal(readDocument(third.cache, "venues:nearby", 2_000).state, "fresh");
  // A single document larger than the whole cache is refused.
  const huge = putDocument({}, "scan:last", { data: "y".repeat(300 * 1024) }, 3_000);
  assert.deepEqual(huge, { ok: false, reason: "document-too-large" });
  // Non-allowlisted keys are refused.
  assert.deepEqual(putDocument({}, "contacts", {}, 0), { ok: false, reason: "key-not-allowlisted" });
});

// ------------------------------------ AMD-NET-03: classifier and session --

test("classifier: two consecutive failures go offline; hysteresis promotes", () => {
  let s = INITIAL_CONNECTIVITY;
  s = recordObservation(s, { ok: false });
  assert.equal(s.state, "online"); // one failure is not offline
  s = recordObservation(s, { ok: false });
  assert.equal(s.state, "offline"); // two consecutive failures
  s = recordObservation(s, { ok: true, rttMs: 100 });
  assert.equal(s.state, "offline"); // ONE healthy probe is not enough
  s = recordObservation(s, { ok: true, rttMs: 100 });
  // Two healthy probes promote — but only as far as the measurements
  // justify: the 8-observation window is still half failures, so the
  // honest landing is degraded, not online.
  assert.equal(s.state, "degraded");
  // Keep the healthy probes coming; once the failed observations age out
  // of the window, the link earns online.
  for (let i = 0; i < 6; i += 1) s = recordObservation(s, { ok: true, rttMs: 100 });
  assert.equal(s.state, "online");
});

test("classifier: slow EMA degrades; promotion respects hysteresis", () => {
  let s = INITIAL_CONNECTIVITY;
  for (let i = 0; i < 8; i += 1) s = recordObservation(s, { ok: true, rttMs: 2_500 });
  assert.equal(s.state, "degraded");
  assert.equal(DEGRADED_RTT_MS, 1_500);
  // Slow probes are not "healthy" — the streak resets, the state holds.
  s = recordObservation(s, { ok: true, rttMs: 2_000 });
  assert.equal(s.state, "degraded");
  s = recordObservation(s, { ok: true, rttMs: 100 });
  assert.equal(s.state, "degraded"); // first healthy probe — not yet
  s = recordObservation(s, { ok: true, rttMs: 100 });
  // Second healthy probe: hysteresis satisfied AND the EMA (alpha 0.25)
  // has fallen back under 1500 ms — promotion lands on online.
  assert.equal(s.state, "online");
});

test("classifier: a lossy window degrades the link", () => {
  let s = INITIAL_CONNECTIVITY;
  // 3 failures in 8 = 37.5% > 25% — but never two CONSECUTIVE, so not offline.
  const seq = [false, true, false, true, true, false, true, true];
  for (const ok of seq) s = recordObservation(s, { ok, rttMs: ok ? 200 : undefined });
  assert.equal(s.state, "degraded");
  assert.equal(FAILURE_WINDOW, 8);
});

test("classifier: feature gates map full / reduced / none", () => {
  assert.equal(featureGateForLink("online"), "full");
  assert.equal(featureGateForLink("degraded"), "reduced");
  assert.equal(featureGateForLink("offline"), "none");
  assert.equal(LINK_SURFACE_MAP.none.realtimeRefresh, false);
  assert.equal(LINK_SURFACE_MAP.reduced.imageryPrefetch, false);
  assert.equal(LINK_SURFACE_MAP.full.backgroundSync, true);
});

test("session: bounded refresh retry fits the 30 s margin; 401 semantics unchanged", () => {
  assert.equal(REFRESH_ATTEMPTS, 3);
  assert.deepEqual([...REFRESH_BACKOFF_MS], [0, 2_000, 8_000]);
  assert.equal(REFRESH_MARGIN_S, 30);
  assert.equal(refreshScheduleFitsMargin(), true);
  assert.equal(refreshAttemptDelayMs(0, () => 0.999), 0);
  assert.equal(refreshAttemptDelayMs(1, () => 0.999) < 2_000, true);
  assert.equal(refreshAttemptDelayMs(2, () => 0.999) < 8_000, true);
  // The reactive 401 path still retries exactly once — never a loop.
  assert.equal(onUnauthorized(false), "refresh-retry");
  assert.equal(onUnauthorized(true), "reauthenticate");
});

// ------------------------------------- AMD-NET-05: last-mile budgets --

test("transfer budgets: the 2G profile is the design floor", () => {
  assert.deepEqual(LINK_PROFILES.edge2g, { downKbps: 50, rttMs: 1_200 });
  // 1 KiB on edge2g: 1.2 s RTT + 8192 bits / 50 kbps ≈ 1.364 s.
  const seconds = transferSeconds(1024, LINK_PROFILES.edge2g);
  assert.ok(Math.abs(seconds - (1.2 + 8192 / 50_000)) < 1e-9);
});

test("transfer budgets: every surface budget is pinned and assertable", () => {
  assert.equal(SURFACE_TRANSFER_BUDGETS.scan.maxSeconds, 8);
  assert.equal(SURFACE_TRANSFER_BUDGETS.publish.maxSeconds, 4);
  assert.equal(SURFACE_TRANSFER_BUDGETS.configBootstrap.maxSeconds, 6);
  assert.equal(SURFACE_TRANSFER_BUDGETS.configRevalidate.maxSeconds, 1.3);
  assert.equal(SURFACE_TRANSFER_BUDGETS.message.maxSeconds, 6);
  // A 304 revalidation body (~200 B of headers) costs barely one RTT.
  assert.equal(fitsTransferBudget("configRevalidate", 200), true);
  // The scan budget admits a real payload but not an unbounded one.
  assert.equal(fitsTransferBudget("scan", 20 * 1024), true);
  assert.equal(fitsTransferBudget("scan", 1024 * 1024), false);
  assert.ok(maxBytesForBudget("publish") > 0);
  const report = budgetReport({ scan: 20 * 1024, publish: 2 * 1024 });
  assert.equal(report.length, 5);
  assert.equal(report.every((r) => r.seconds <= r.maxSeconds), true);
});

// -------------------------------------- wipe by construction (TR-30) --

test("wipe: logout clears the outbox and the read cache by construction", async () => {
  for (const key of [OUTBOX_STORAGE_KEY, READ_CACHE_STORAGE_KEY]) {
    assert.ok(
      (LOCAL_STATE_ALLOWLIST as readonly string[]).includes(key),
      `${key} must be on the TR-30 allowlist so the wipe covers it`,
    );
  }
  const backend = createMemoryBackend();
  await backend.setItem(OUTBOX_STORAGE_KEY, serializeOutbox([]));
  await backend.setItem(READ_CACHE_STORAGE_KEY, serializeReadCache({}));
  await backend.setItem("presence.session.refreshToken", "rt");
  await clearLocalState(backend);
  assert.deepEqual(backend.keys(), []);
});

// ------------------------------------------------ copy registry keys --

test("copy: the connectivity surfaces have English copy", () => {
  for (const key of [
    "ui.connectivity.offline",
    "ui.connectivity.degraded",
    "ui.connectivity.outboxPending",
    "ui.connectivity.staleCopy",
    "ui.connectivity.poisonPrompt",
  ]) {
    assert.ok(ENGLISH_COPY[key], `missing copy key ${key}`);
  }
});

// ------------------------------------------------ cross-mirror pins --

test("spec: the addendum carries AMD-NET-01..05 and the batch-65 footer", () => {
  const addendum = readFileSync("../docs/spec/srs-addendum-001.md", "utf8");
  for (const id of ["AMD-NET-01", "AMD-NET-02", "AMD-NET-03", "AMD-NET-04", "AMD-NET-05"]) {
    assert.ok(addendum.includes(`**${id} (`), `addendum missing ${id}`);
  }
  assert.ok(addendum.includes("AMD-NET-01..05 added alongside batch 65"));
  assert.ok(addendum.includes("tests/test_batch65.py"));
});

test("edge: compression is registered and the config endpoint is conditional", () => {
  const app = readFileSync("../services/edge/src/app.ts", "utf8");
  assert.ok(app.includes("@fastify/compress"), "edge app must register compression");
  const config = readFileSync("../services/edge/src/clientConfig.ts", "utf8");
  assert.ok(config.includes("if-none-match") || config.includes("ifNoneMatch"), "304 handling");
  assert.ok(config.includes("etag"), "ETag emission");
  assert.ok(config.includes("max-age=60"), "Cache-Control max-age=60");
});

test("docs: the connectivity UX note exists and documents the model", () => {
  const doc = readFileSync("../docs/ux/connectivity.md", "utf8");
  for (const needle of ["AMD-NET-01", "AMD-NET-02", "AMD-NET-03", "AMD-NET-04", "AMD-NET-05",
    "outbox", "stale", "hysteresis", "edge2g"]) {
    assert.ok(doc.includes(needle), `connectivity doc missing "${needle}"`);
  }
});

test("storage keys: outbox and cache persist under their pinned keys", () => {
  assert.equal(OUTBOX_STORAGE_KEY, "presence.outbox.queue");
  assert.equal(READ_CACHE_STORAGE_KEY, "presence.cache.read");
});
