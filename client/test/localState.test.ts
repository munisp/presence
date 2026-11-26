/** TR-30: minimum local state — allowlisted, wiped on logout. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOCAL_STATE_ALLOWLIST,
  clearLocalState,
  createLocalState,
  createMemoryBackend,
} from "../src/presence/localState.js";

test("the allowlist is small, namespaced and documented", () => {
  // AMD-NET-01/02 (batch 65) added the outbox and read-cache keys: 7 → 9.
  assert.equal(LOCAL_STATE_ALLOWLIST.length, 9);
  assert.ok(LOCAL_STATE_ALLOWLIST.includes("presence.powerMode"));
  assert.ok(LOCAL_STATE_ALLOWLIST.includes("presence.ui.seenExplanations"));
  assert.ok(LOCAL_STATE_ALLOWLIST.includes("presence.ambient.prefs"));
  assert.ok(LOCAL_STATE_ALLOWLIST.includes("presence.outbox.queue"));
  assert.ok(LOCAL_STATE_ALLOWLIST.includes("presence.cache.read"));
  for (const key of LOCAL_STATE_ALLOWLIST) {
    assert.match(key, /^presence\./);
  }
  // No coordinate or contact-shaped key may ever appear here.
  for (const key of LOCAL_STATE_ALLOWLIST) {
    assert.doesNotMatch(key, /location|cell|coordinate|contact/i);
  }
});

test("state round-trips through the injected backend", async () => {
  const backend = createMemoryBackend();
  const state = createLocalState(backend);
  await state.set("presence.device.id", "dev-123");
  assert.equal(await state.get("presence.device.id"), "dev-123");
  await state.remove("presence.device.id");
  assert.equal(await state.get("presence.device.id"), null);
});

test("clearLocalState wipes every allowlisted key (TR-30)", async () => {
  const backend = createMemoryBackend();
  const state = createLocalState(backend);
  for (const key of LOCAL_STATE_ALLOWLIST) {
    await state.set(key, "value");
  }
  assert.equal(backend.keys().length, LOCAL_STATE_ALLOWLIST.length);
  await clearLocalState(backend);
  assert.equal(backend.keys().length, 0);
  for (const key of LOCAL_STATE_ALLOWLIST) {
    assert.equal(await state.get(key), null);
  }
});

test("the wipe covers the allowlist by construction — no drift", async () => {
  // If a future key is added to the allowlist, clearLocalState covers it
  // automatically: the wipe iterates the allowlist itself.
  const backend = createMemoryBackend();
  const state = createLocalState(backend);
  await state.set("presence.session.refreshToken", "tok");
  await clearLocalState(backend);
  assert.equal(backend.keys().length, 0);
});
