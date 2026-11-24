/** FR-85: reduced-power cadence — no more than one publish per ten minutes. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  POWER_MODES,
  POWER_MODE_PRESENTATION,
  PRESENCE_SESSION_TTL_S,
  REDUCED_POWER_NOTICE,
  REDUCED_PUBLISH_INTERVAL_S,
  STANDARD_PUBLISH_INTERVAL_S,
  isPublishDue,
  isPublishDueAfterSwitch,
  nextPublishDueAtMs,
  publishIntervalS,
} from "../src/presence/powerMode.js";

test("reduced mode caps the cadence at once per ten minutes (FR-85)", () => {
  assert.equal(REDUCED_PUBLISH_INTERVAL_S, 600);
  assert.equal(publishIntervalS("reduced"), 600);
  assert.ok(publishIntervalS("reduced") >= 600, "never more often than the SRS ceiling");
});

test("both cadences stay strictly below the FR-14 session TTL", () => {
  assert.equal(PRESENCE_SESSION_TTL_S, 900);
  assert.ok(STANDARD_PUBLISH_INTERVAL_S < PRESENCE_SESSION_TTL_S);
  // The reduced interval leaves a retry margin before the session lapses.
  assert.ok(PRESENCE_SESSION_TTL_S - REDUCED_PUBLISH_INTERVAL_S >= 300);
});

test("the user can select either mode and reduced carries the timeliness notice", () => {
  assert.deepEqual([...POWER_MODES], ["standard", "reduced"]);
  assert.equal(POWER_MODE_PRESENTATION.reduced.detail, REDUCED_POWER_NOTICE);
  assert.match(REDUCED_POWER_NOTICE, /slower|longer/i, "notice must say matches are less timely");
});

test("scheduler arithmetic honours the interval", () => {
  const t0 = 1_700_000_000_000;
  assert.equal(isPublishDue("standard", null, t0), true, "fresh session publishes at once");
  assert.equal(isPublishDue("standard", t0, t0 + 299_999), false);
  assert.equal(isPublishDue("standard", t0, t0 + 300_000), true);
  assert.equal(isPublishDue("reduced", t0, t0 + 599_999), false);
  assert.equal(isPublishDue("reduced", t0, t0 + 600_000), true);
  assert.equal(nextPublishDueAtMs("reduced", t0), t0 + 600_000);
});

test("mode switches apply to the next publish — never early, never skipped", () => {
  const t0 = 1_700_000_000_000;
  // standard -> reduced stretches the wait from the last publish.
  assert.equal(isPublishDueAfterSwitch("reduced", t0, t0 + 400_000), false);
  assert.equal(isPublishDueAfterSwitch("reduced", t0, t0 + 600_000), true);
  // reduced -> standard shortens it; a publish may be due immediately.
  assert.equal(isPublishDueAfterSwitch("standard", t0, t0 + 400_000), true);
});
