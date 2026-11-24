/**
 * TECH-12: the tracing module contract — disabled via env for bare-metal
 * runs, a live SDK otherwise. The wiring pins (tracing starts before the
 * module graph loads, OTLP endpoint env, collector stack) live in
 * tests/test_batch28.py and scripts/validate_deploy.py.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { startTracing } from "../src/tracing.js";

test("OTEL_SDK_DISABLED=true opts out entirely", () => {
  process.env.OTEL_SDK_DISABLED = "true";
  try {
    assert.equal(startTracing("presence-match"), null);
  } finally {
    delete process.env.OTEL_SDK_DISABLED;
  }
});

test("default start returns a live SDK that shuts down cleanly", async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:1"; // unreachable; no spans are emitted in-process
  const sdk = startTracing("presence-match");
  assert.ok(sdk);
  assert.equal(typeof sdk.shutdown, "function");
  await sdk.shutdown();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});
