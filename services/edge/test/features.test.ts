/** FR-63 venue feature flag unit tests (stubbed pg). */

import assert from "node:assert/strict";
import { test } from "node:test";
import Postgres from "pg";
import { venueFeatureEnabled } from "../src/features.js";

function fakePg(rows: Array<{ enabled: boolean }>): Postgres.Pool {
  return {
    query: async (text: string, params: unknown[]) => {
      assert.match(text, /venue_features/);
      assert.equal(params.length, 2);
      return { rows };
    },
  } as unknown as Postgres.Pool;
}

test("no row means the feature is ON (flags only narrow)", async () => {
  assert.equal(await venueFeatureEnabled(fakePg([]), "v-1", "announcements"), true);
});

test("an enabled row is on; a disabled row is off", async () => {
  assert.equal(await venueFeatureEnabled(fakePg([{ enabled: true }]), "v-1", "rooms"), true);
  assert.equal(await venueFeatureEnabled(fakePg([{ enabled: false }]), "v-1", "rooms"), false);
});
