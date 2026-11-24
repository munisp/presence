/** TR-33: pinning removable by configuration — never bricks the client. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PINNING_CONFIG_TTL_S,
  PIN_PATTERN,
  createPinningPolicy,
  pinChainMatches,
  type RemotePinningConfig,
} from "../src/presence/certPinning.js";

const PIN_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PIN_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

function config(overrides: Partial<RemotePinningConfig>): RemotePinningConfig {
  return { enabled: false, pins: [], configVersion: 1, ...overrides };
}

test("the pin shape matches sha256/SPKI base64", () => {
  assert.ok(PIN_PATTERN.test(PIN_A));
  assert.ok(!PIN_PATTERN.test("too-short="));
  assert.ok(!PIN_PATTERN.test("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")); // no padding
});

// ------------------------------------------------- removal without update --

test("ops can remove pinning by configuration — no app update (TR-33)", async () => {
  let remote = config({ enabled: true, pins: [PIN_A], configVersion: 1 });
  let now = 1_000_000;
  const policy = createPinningPolicy({ fetchConfig: async () => remote, nowS: () => now });

  // v1: pinned.
  const first = await policy.resolve();
  assert.equal(first.pinned, true);
  assert.deepEqual(first.pins, [PIN_A]);
  assert.equal(first.source, "remote");

  // Ops clears the pins server-side and bumps the version. The SAME app
  // run picks it up after the cache TTL — no update, no store review.
  remote = config({ enabled: false, pins: [], configVersion: 2 });
  now += PINNING_CONFIG_TTL_S + 1;
  const second = await policy.resolve();
  assert.equal(second.pinned, false);
  assert.deepEqual(second.pins, []);
  assert.equal(second.appliedVersion, 2);
});

test("an older config is never applied over a newer one (monotonic)", async () => {
  let remote = config({ enabled: false, pins: [], configVersion: 2 });
  let now = 0;
  const policy = createPinningPolicy({ fetchConfig: async () => remote, nowS: () => now });
  await policy.resolve();

  remote = config({ enabled: true, pins: [PIN_A], configVersion: 1 });
  now += PINNING_CONFIG_TTL_S + 1;
  const decision = await policy.resolve();
  assert.equal(decision.source, "stale-refused");
  assert.equal(decision.pinned, false);
  assert.equal(decision.appliedVersion, 2);
});

// ------------------------------------------------------------ failure modes --

test("a fetch failure fails OPEN to OS trust — availability outranks pinning", async () => {
  const policy = createPinningPolicy({
    fetchConfig: async () => {
      throw new Error("network down");
    },
    nowS: () => 0,
  });
  const decision = await policy.resolve();
  assert.equal(decision.pinned, false);
  assert.equal(decision.source, "fallback-unavailable");
});

test("malformed configs fail open and advance the version once", async () => {
  let remote: RemotePinningConfig = config({ enabled: true, pins: [], configVersion: 3 });
  let now = 0;
  const policy = createPinningPolicy({ fetchConfig: async () => remote, nowS: () => now });
  // Enabled with an empty pin set is a self-DoS — refused, unpinned.
  let decision = await policy.resolve();
  assert.equal(decision.pinned, false);
  assert.equal(decision.source, "fallback-invalid");
  assert.equal(decision.appliedVersion, 3);

  // Bad pin shape: same treatment.
  remote = config({ enabled: true, pins: ["not-a-pin"], configVersion: 4 });
  now += PINNING_CONFIG_TTL_S + 1;
  decision = await policy.resolve();
  assert.equal(decision.pinned, false);
  assert.equal(decision.source, "fallback-invalid");
  assert.equal(decision.appliedVersion, 4);
});

// ------------------------------------------------------------------- cache --

test("the config is cached for the TTL, refetched after", async () => {
  let fetches = 0;
  let now = 10_000;
  const policy = createPinningPolicy({
    fetchConfig: async () => {
      fetches++;
      return config({ enabled: true, pins: [PIN_A, PIN_B], configVersion: 1 });
    },
    nowS: () => now,
  });
  const first = await policy.resolve();
  assert.equal(first.source, "remote");
  now += PINNING_CONFIG_TTL_S - 1;
  const cached = await policy.resolve();
  assert.equal(cached.source, "cache");
  assert.equal(fetches, 1);
  // After the TTL the policy revalidates — a refetch happens, and since
  // the version is unchanged the decision is served as a refreshed cache.
  now += 2;
  const revalidated = await policy.resolve();
  assert.equal(revalidated.source, "cache");
  assert.equal(revalidated.pinned, true);
  assert.equal(fetches, 2);
});

// ------------------------------------------------------------- enforcement --

test("pinChainMatches: unpinned always proceeds; pinned needs a chain hit", () => {
  const unpinned = { pinned: false, pins: [], appliedVersion: 1, source: "remote" as const };
  assert.equal(pinChainMatches(unpinned, []), true);
  const pinned = { pinned: true, pins: [PIN_A, PIN_B], appliedVersion: 1, source: "remote" as const };
  assert.equal(pinChainMatches(pinned, [PIN_B]), true);
  assert.equal(pinChainMatches(pinned, ["CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC="]), false);
});
