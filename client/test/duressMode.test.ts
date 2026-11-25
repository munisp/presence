/** AMD-INN-05: duress mode — pinned pipeline, fail-safe ordering. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DURESS_PIPELINE,
  executeDuressExit,
  planDuressExit,
} from "../src/presence/duressMode.js";
import { createMemoryBackend, LOCAL_STATE_ALLOWLIST } from "../src/presence/localState.js";

test("AMD-INN-05: the pipeline is pinned and ordered", () => {
  assert.deepEqual(planDuressExit(), [
    "withdraw-presence",
    "wipe-local-state",
    "neutral-screen",
  ]);
  assert.equal(DURESS_PIPELINE.length, 3);
});

test("AMD-INN-05: duress wipes every allowlisted key", async () => {
  const backend = createMemoryBackend();
  for (const key of LOCAL_STATE_ALLOWLIST) {
    await backend.setItem(key, "x");
  }
  const shown: string[] = [];
  const results = await executeDuressExit(backend, {
    withdrawPresence: async () => {},
    showNeutralScreen: () => shown.push("neutral"),
  });
  assert.deepEqual(backend.keys(), []);
  assert.deepEqual(shown, ["neutral"]);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(
    results.map((r) => r.step),
    [...DURESS_PIPELINE],
  );
});

test("AMD-INN-05: a failed withdrawal never blocks the wipe", async () => {
  const backend = createMemoryBackend();
  await backend.setItem(LOCAL_STATE_ALLOWLIST[0], "x");
  let neutral = false;
  const results = await executeDuressExit(backend, {
    withdrawPresence: async () => {
      throw new Error("offline");
    },
    showNeutralScreen: () => {
      neutral = true;
    },
  });
  assert.deepEqual(backend.keys(), []);
  assert.equal(neutral, true);
  assert.deepEqual(
    results.map((r) => r.ok),
    [false, true, true],
  );
});

test("AMD-INN-05: the module imports only the local-state wipe", () => {
  const src = readFileSync("src/presence/duressMode.ts", "utf8");
  const imports = src.match(/^import .* from "(\..*)";$/gm) ?? [];
  assert.deepEqual(imports, ['import { clearLocalState, KeyValueBackend } from "./localState.js";']);
});
