import assert from "node:assert/strict";
import test from "node:test";

import {
  INDOOR_FALLBACK_NOTICE,
  indoorPresenceHonoursFr89,
  planIndoorPresence,
} from "../src/presence/indoorPresence.js";
import {
  PRESENCE_SOURCE_CONFIDENCE,
  VENUE_CHECKIN_ENDPOINT,
  preferredPresenceSource,
} from "../src/presence/journeyContracts.js";

test("inside a partner venue the primary path is venue check-in", () => {
  const plan = planIndoorPresence({ insidePartnerVenue: true, checkinCode: "abc123" })!;
  assert.equal(plan.primary, "venue-checkin");
  assert.equal(plan.checkin!.action, "checkin");
  assert.equal(plan.checkin!.endpoint, VENUE_CHECKIN_ENDPOINT);
});

test("the cell is the fallback indoors, never the default", () => {
  const plan = planIndoorPresence({ insidePartnerVenue: true, checkinCode: "abc123" })!;
  assert.equal(plan.fallback, "cell");
  assert.equal(plan.fallbackNotice, INDOOR_FALLBACK_NOTICE);
  assert.notEqual(plan.primary, "cell");
});

test("the FR-48 confidence ordering ranks check-in strictly above the cell", () => {
  assert.ok(
    PRESENCE_SOURCE_CONFIDENCE["venue-checkin"] > PRESENCE_SOURCE_CONFIDENCE.cell,
  );
  assert.equal(preferredPresenceSource(["venue-checkin", "cell"]), "venue-checkin");
});

test("an empty code still puts check-in first but refuses at the wire", () => {
  const plan = planIndoorPresence({ insidePartnerVenue: true, checkinCode: "   " })!;
  assert.equal(plan.primary, "venue-checkin");
  assert.equal(plan.checkin!.action, "refuse");
});

test("outside a partner venue the module does not apply", () => {
  assert.equal(
    planIndoorPresence({ insidePartnerVenue: false, checkinCode: "abc123" }),
    null,
  );
});

test("garbage context fails closed", () => {
  assert.equal(
    planIndoorPresence({ insidePartnerVenue: "yes" as unknown as boolean, checkinCode: "x" }),
    null,
  );
  assert.equal(
    planIndoorPresence({ insidePartnerVenue: true, checkinCode: 42 as unknown as string }),
    null,
  );
});

test("the master guard walks the whole contract", () => {
  assert.equal(indoorPresenceHonoursFr89(), true);
});
