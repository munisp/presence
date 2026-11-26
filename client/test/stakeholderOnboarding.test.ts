/** AMD-ONB-01..06: stakeholder onboarding — client contract tests. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  APPLICATION_KINDS,
  APPLICATION_STATUSES,
  POLYGON_MAX_POINTS,
  POLYGON_MIN_POINTS,
  STATEMENT_MAX,
  STATEMENT_MIN,
  TERMS_VERSION_PATTERN,
  VENUE_NAME_MAX,
  buildProviderPayload,
  buildVenuePartnerPayload,
  onboardingSteps,
  parseApplicationList,
  parseOnboardingStatus,
} from "../src/presence/stakeholderOnboarding.js";

const MIGRATION = readFileSync("../db/migrations/0037_onboarding.sql", "utf8");
const EDGE_MODULE = readFileSync("../services/edge/src/onboarding.ts", "utf8");
const COPY = readFileSync("src/presence/copyRegistry.ts", "utf8");

test("AMD-ONB-01: the vocabulary mirrors the SQL and the edge module", () => {
  assert.deepEqual([...APPLICATION_KINDS], ["venue_partner", "provider"]);
  assert.deepEqual([...APPLICATION_STATUSES], ["pending", "approved", "rejected", "withdrawn"]);
  assert.ok(MIGRATION.includes("CHECK (kind IN ('venue_partner', 'provider'))"));
  assert.ok(
    MIGRATION.includes("CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn'))"),
  );
  for (const kind of APPLICATION_KINDS) assert.ok(EDGE_MODULE.includes(`"${kind}"`), kind);
  // The pinned bounds agree across the three mirrors.
  assert.equal(VENUE_NAME_MAX, 80);
  assert.equal(POLYGON_MIN_POINTS, 4);
  assert.equal(POLYGON_MAX_POINTS, 64);
  assert.equal(STATEMENT_MIN, 10);
  assert.equal(STATEMENT_MAX, 500);
  assert.ok(MIGRATION.includes("BETWEEN 2 AND 80"));
  assert.ok(MIGRATION.includes("BETWEEN 4 AND 64"));
  assert.ok(MIGRATION.includes("BETWEEN 10 AND 500"));
  assert.ok(EDGE_MODULE.includes("VENUE_NAME_MAX = 80"));
  assert.ok(EDGE_MODULE.includes("POLYGON_MIN_POINTS = 4"));
  assert.ok(EDGE_MODULE.includes("STATEMENT_MIN = 10"));
});

const VENUE_OK = {
  name: "Rooftop Lounge",
  polygon: [
    [3.37, 6.45],
    [3.38, 6.45],
    [3.38, 6.46],
    [3.37, 6.46],
  ] as Array<[number, number]>,
  statement: "We run a rooftop venue in Yaba.",
};

test("AMD-ONB-01: the venue payload builder validates exactly like the definer", () => {
    const built = buildVenuePartnerPayload(VENUE_OK);
  assert.ok(built);
  assert.equal(built.name, "Rooftop Lounge");
  assert.equal(built.polygon.length, 4);
  // Too few / too many points.
  assert.equal(buildVenuePartnerPayload({ ...VENUE_OK, polygon: VENUE_OK.polygon.slice(0, 3) }), null);
  assert.equal(
    buildVenuePartnerPayload({ ...VENUE_OK, polygon: Array(65).fill([3.37, 6.45]) }),
    null,
  );
  // Out-of-range coordinates and malformed points.
  assert.equal(
    buildVenuePartnerPayload({ ...VENUE_OK, polygon: [...VENUE_OK.polygon.slice(0, 3), [181, 6.5]] }),
    null,
  );
  assert.equal(
    buildVenuePartnerPayload({ ...VENUE_OK, polygon: [...VENUE_OK.polygon.slice(0, 3), [3.4, 91]] }),
    null,
  );
  assert.equal(
    buildVenuePartnerPayload({ ...VENUE_OK, polygon: [...VENUE_OK.polygon.slice(0, 3), [3.4]] }),
    null,
  );
  // Name and statement bounds.
  assert.equal(buildVenuePartnerPayload({ ...VENUE_OK, name: "x" }), null);
  assert.equal(buildVenuePartnerPayload({ ...VENUE_OK, name: "x".repeat(81) }), null);
  assert.equal(buildVenuePartnerPayload({ ...VENUE_OK, statement: "too short" }), null);
  assert.equal(buildVenuePartnerPayload({ ...VENUE_OK, statement: "x".repeat(501) }), null);
  // Schedule mirrors the 0020 shape.
  assert.equal(
    buildVenuePartnerPayload({
      ...VENUE_OK,
      schedule: { timezone: "Africa/Lagos", weekly: [{ day: "mon", open: "08:00", close: "22:00" }] },
    })?.schedule?.timezone,
    "Africa/Lagos",
  );
  assert.equal(
    buildVenuePartnerPayload({ ...VENUE_OK, schedule: { weekly: [{ day: "nope", open: "08:00", close: "22:00" }] } as never }),
    null,
  );
  assert.equal(
    buildVenuePartnerPayload({ ...VENUE_OK, schedule: { weekly: [{ day: "mon", open: "8:00", close: "22:00" }] } as never }),
    null,
  );
});

test("AMD-ONB-01: the provider payload builder validates exactly like the definer", () => {
  const ok = buildProviderPayload({ termsVersion: "v1.2", statement: "I sell refurbished phones." });
  assert.deepEqual(ok, { termsVersion: "v1.2", statement: "I sell refurbished phones." });
  assert.ok(TERMS_VERSION_PATTERN.test("v1.0"));
  assert.equal(buildProviderPayload({ termsVersion: "1.0", statement: "x".repeat(12) }), null);
  assert.equal(buildProviderPayload({ termsVersion: "v1", statement: "x".repeat(12) }), null);
  assert.equal(buildProviderPayload({ termsVersion: "v1.0", statement: "short" }), null);
  assert.equal(buildProviderPayload({ termsVersion: "v1.0", statement: 42 }), null);
});

test("the application list parser fails closed", () => {
  const row = {
    applicationId: "296377fa-1b73-40a5-adc4-28fcfefd8c30",
    kind: "venue_partner",
    status: "pending",
    requestedAt: "2026-11-27T10:00:00.000Z",
    decidedAt: null,
    decisionReason: null,
  };
  assert.deepEqual(parseApplicationList({ applications: [row] }), [row]);
  assert.deepEqual(parseApplicationList({ applications: [] }), []);
  assert.equal(parseApplicationList(null), null);
  assert.equal(parseApplicationList({}), null);
  assert.equal(parseApplicationList({ applications: [{ ...row, kind: "astrology" }] }), null);
  assert.equal(parseApplicationList({ applications: [{ ...row, status: "limbo" }] }), null);
  assert.equal(parseApplicationList({ applications: [{ ...row, applicationId: "nope" }] }), null);
  assert.equal(parseApplicationList({ applications: [{ ...row, decisionReason: 7 }] }), null);
});

const BASE_STATUS = {
  ageDeclared: true,
  kycState: "verified" as const,
  kycReviewRequested: false,
  avatarSet: true,
  verticalsChosen: true,
  complete: true,
};

test("the status parser fails closed", () => {
  assert.deepEqual(parseOnboardingStatus(BASE_STATUS), BASE_STATUS);
  assert.equal(parseOnboardingStatus(null), null);
  assert.equal(parseOnboardingStatus({ ...BASE_STATUS, kycState: "limbo" }), null);
  assert.equal(parseOnboardingStatus({ ...BASE_STATUS, complete: "yes" }), null);
  assert.equal(parseOnboardingStatus({ ...BASE_STATUS, avatarSet: undefined }), null);
});

test("AMD-ONB-06: the stepper renders exactly one ready step", () => {
  // Fresh account: age first, everything else waits.
  let steps = onboardingSteps({
    ageDeclared: false, kycState: "pending", kycReviewRequested: false,
    avatarSet: false, verticalsChosen: false, complete: false,
  });
  assert.deepEqual(steps.map((s) => s.state), ["ready", "waiting", "waiting", "waiting"]);

  // KYC requested and pending: the step is ready with the under-review note.
  steps = onboardingSteps({
    ageDeclared: true, kycState: "pending", kycReviewRequested: true,
    avatarSet: false, verticalsChosen: false, complete: false,
  });
  assert.deepEqual(steps.map((s) => s.state), ["done", "ready", "waiting", "waiting"]);
  assert.equal(steps[1].noteKey, "ui.onboarding.kyc.under-review");

  // Rejected: blocked with the re-request note.
  steps = onboardingSteps({
    ageDeclared: true, kycState: "rejected", kycReviewRequested: false,
    avatarSet: false, verticalsChosen: false, complete: false,
  });
  assert.equal(steps[1].state, "blocked");
  assert.equal(steps[1].noteKey, "ui.onboarding.kyc.rejected");

  // Complete: every step done, none ready.
  steps = onboardingSteps(BASE_STATUS);
  assert.deepEqual(steps.map((s) => s.state), ["done", "done", "done", "done"]);

  // Copy keys exist for every step and note the stepper can emit.
  for (const s of onboardingSteps({ ...BASE_STATUS, ageDeclared: false, kycState: "pending" as const, kycReviewRequested: true, complete: false })) {
    assert.ok(COPY.includes(`"${s.labelKey}"`), s.labelKey);
    if (s.noteKey) assert.ok(COPY.includes(`"${s.noteKey}"`), s.noteKey);
  }
  for (const status of APPLICATION_STATUSES) {
    assert.ok(COPY.includes(`"ui.onboarding.application.state.${status}"`), status);
  }
});
