/**
 * TR-02/TECH-15: the scan path reads profiles from the cache only — a fake
 * clock advances expiry without sleeping, and a counting fake pg proves no
 * synchronous query happens on a cachedProfile call.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CORPUS_REFRESH_MS, Store } from "../src/store.js";

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fakePg(rows: { node_id: string; weight: number }[] = [{ node_id: "music.indie", weight: 1 }]) {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("profile_interests")) return { rows };
      return { rows: [] };
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a cold miss answers null and warms asynchronously — never synchronously", async () => {
  const pg = fakePg();
  const store = new Store(pg as never, {} as never, fakeClock());

  assert.equal(store.cachedProfile("u1"), null);
  assert.equal(pg.calls.length, 1, "the warm fires in the background");

  await tick();
  assert.deepEqual(store.cachedProfile("u1"), { "music.indie": 1 });
  assert.equal(pg.calls.length, 1, "the warm completed; no second query");
});

test("a user with no profile row stays uncached as null", async () => {
  const pg = fakePg([]);
  const store = new Store(pg as never, {} as never, fakeClock());

  assert.equal(store.cachedProfile("u1"), null);
  await tick();
  // The warm ran and found nothing; a second miss warms again (the corpus
  // loop bounds the frequency in production).
  assert.equal(store.cachedProfile("u1"), null);
});

test("a stale entry is served and refreshed — still no synchronous read", async () => {
  const clock = fakeClock();
  const pg = fakePg();
  const store = new Store(pg as never, {} as never, clock);

  assert.equal(store.cachedProfile("u1"), null);
  await tick();
  assert.equal(pg.calls.length, 1);

  // TECH-15: advance the injected clock past the freshness window — no sleep.
  clock.advance(CORPUS_REFRESH_MS + 1);
  const served = store.cachedProfile("u1");
  assert.deepEqual(served, { "music.indie": 1 }, "stale is served this scan");
  assert.equal(pg.calls.length, 2, "and the refresh fires for the next scan");
});

test("profile() caches within the freshness window measured by the clock", async () => {
  const clock = fakeClock();
  const pg = fakePg();
  const store = new Store(pg as never, {} as never, clock);

  await store.profile("u1");
  await store.profile("u1");
  assert.equal(pg.calls.length, 1, "within the window the cache answers");

  clock.advance(CORPUS_REFRESH_MS);
  await store.profile("u1");
  assert.equal(pg.calls.length, 2, "past the window Postgres is read again");
});
