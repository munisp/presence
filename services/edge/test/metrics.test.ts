/**
 * NFR-07/NFR-33: metrics registry exposition semantics plus the realtime
 * publish instrumentation — a fake clock makes the observed duration exact
 * (TECH-15) and a mocked fetch drives success, non-OK and throw paths.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { EdgeContext, publishRealtime } from "../src/context.js";
import { Counter, Gauge, Histogram, metrics, Registry } from "../src/metrics.js";

// ---------------------------------------------------------------- registry --

test("counter renders name, type and labelled series", () => {
  const reg = new Registry();
  const c = reg.counter("widget_total", "widgets", ["kind"]);
  c.inc({ kind: "a" });
  c.inc({ kind: "a" });
  c.inc({ kind: 'b"quoted"' });
  const out = c.render();
  assert.match(out, /^# TYPE widget_total counter$/m);
  assert.match(out, /^widget_total\{kind="a"\} 2$/m);
  assert.match(out, /^widget_total\{kind="b\\"quoted\\""\} 1$/m);
});

test("histogram buckets are cumulative with sum and count", () => {
  const h = new Histogram("lat_seconds", "latency", [0.1, 0.5], ["route"]);
  h.observe(0.05, { route: "/x" });
  h.observe(0.4, { route: "/x" });
  h.observe(2, { route: "/x" });
  const out = h.render();
  assert.match(out, /^lat_seconds_bucket\{route="\/x",le="0\.1"\} 1$/m);
  assert.match(out, /^lat_seconds_bucket\{route="\/x",le="0\.5"\} 2$/m);
  assert.match(out, /^lat_seconds_bucket\{route="\/x",le="\+Inf"\} 3$/m);
  assert.match(out, /^lat_seconds_sum\{route="\/x"\} 2\.45$/m);
  assert.match(out, /^lat_seconds_count\{route="\/x"\} 3$/m);
});

test("gauge renders the last set value", () => {
  const g = new Gauge("depth", "queue depth");
  g.set(7);
  g.set(3);
  assert.match(g.render(), /^depth 3$/m);
});

// ------------------------------------------------- publish instrumentation --

function ctxWithClock(start = 1_000_000) {
  let t = start;
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
  const ctx = {
    centrifugoUrl: "http://centrifugo.test",
    centrifugoApiKey: "k",
    clock,
  } as unknown as EdgeContext;
  return { ctx, clock };
}

function rendered(series: string): string {
  // The registry is process-global; find the series block by name.
  const out = metrics.render();
  const lines = out.split("\n").filter((l) => l.startsWith(series) && !l.startsWith("#"));
  return lines.join("\n");
}

test("a successful publish is timed per channel class (NFR-07)", async () => {
  mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  const { ctx, clock } = ctxWithClock();
  const run = publishRealtime(ctx, "user:u1", { ok: true });
  clock.advance(120); // the broker answered after 120 ms of fake time
  await run;

  const out = rendered("presence_realtime_publish_duration_seconds");
  assert.match(out, /presence_realtime_publish_duration_seconds_count\{channel_class="user"\} 1/);
  assert.match(out, /presence_realtime_publish_duration_seconds_sum\{channel_class="user"\} 0\.12/);
  mock.restoreAll();
});

test("a non-OK broker response counts as a failure, no throw", async () => {
  mock.method(globalThis, "fetch", async () => new Response("boom", { status: 500 }));
  const { ctx } = ctxWithClock();
  await publishRealtime(ctx, "pair:p1", { ok: true });

  const out = rendered("presence_realtime_publish_failures_total");
  assert.match(out, /presence_realtime_publish_failures_total\{channel_class="pair"\} 1/);
  mock.restoreAll();
});

test("a fetch throw counts the failure and rethrows", async () => {
  mock.method(globalThis, "fetch", async () => {
    throw new Error("connection refused");
  });
  const { ctx } = ctxWithClock();
  await assert.rejects(publishRealtime(ctx, "room:r1", {}), /connection refused/);

  const out = rendered("presence_realtime_publish_failures_total");
  assert.match(out, /presence_realtime_publish_failures_total\{channel_class="room"\} 1/);
  mock.restoreAll();
});
