/** AMD-SVC-01..05: service bookings — formatting, badges, wire parsers,
 * action rules, transition and constant cross-pins. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ENGLISH_COPY } from "../src/presence/copyRegistry.js";
import {
  buildServiceBookingDraft,
  canConfirmMilestone,
  canDisputeService,
  canStartService,
  formatServiceAmount,
  milestoneAmounts,
  nextMilestone,
  parseServiceBookingWire,
  parseServiceEventWire,
  SERVICE_BOOKING_STATES,
  SERVICE_BOOKING_TRANSITIONS,
  SERVICE_CURRENCY,
  SERVICE_MAX_AMOUNT_MINOR,
  SERVICE_MAX_MILESTONES,
  SERVICE_START_TTL_SECONDS,
  SERVICE_STALE_SECONDS,
  serviceBookingBadge,
  serviceBookingItems,
  serviceRole,
} from "../src/presence/serviceBooking.js";

const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const LISTING_ID = "22222222-2222-4222-8222-222222222222";
const ESCROW_ID = "33333333-3333-4333-8333-333333333333";
const CUSTOMER_ID = "44444444-4444-4444-8444-444444444444";
const PROVIDER_ID = "55555555-5555-4555-8555-555555555555";

const BOOKING_WIRE = {
  bookingId: BOOKING_ID,
  listingId: LISTING_ID,
  customer: CUSTOMER_ID,
  provider: PROVIDER_ID,
  agreedMinor: 250_000,
  currency: "NGN",
  milestones: 3,
  escrowId: ESCROW_ID,
  state: "in_progress",
  createdAt: "2026-11-26T10:00:00Z",
  startedAt: "2026-11-26T11:00:00Z",
  completedAt: null,
  cancelledAt: null,
  disputedAt: null,
};

const EVENT_WIRE = {
  eventId: "7",
  actor: CUSTOMER_ID,
  fromState: "in_progress",
  toState: "milestone_confirmed",
  at: "2026-11-26T12:00:00Z",
};

test("AMD-SVC-02/04: the constants mirror the edge module", () => {
  // Cross-pinned: the edge mirrors the migration contract.
  const edge = readFileSync("../services/edge/src/services.ts", "utf8");
  assert.match(edge, /SERVICE_MAX_AMOUNT_MINOR = 5_000_000/);
  assert.match(edge, /SERVICE_MAX_MILESTONES = 12/);
  assert.match(edge, /SERVICE_START_TTL_SECONDS = 604_800/);
  assert.match(edge, /SERVICE_STALE_SECONDS = 2_592_000/);
  assert.match(edge, /SERVICE_CURRENCY = "NGN"/);
  assert.equal(SERVICE_MAX_AMOUNT_MINOR, 5_000_000);
  assert.equal(SERVICE_MAX_MILESTONES, 12);
  assert.equal(SERVICE_START_TTL_SECONDS, 604_800);
  assert.equal(SERVICE_STALE_SECONDS, 2_592_000);
  assert.equal(SERVICE_CURRENCY, "NGN");
});

test("AMD-SVC-01: the state machine mirrors the edge module", () => {
  const edge = readFileSync("../services/edge/src/services.ts", "utf8");
  assert.match(
    edge,
    /SERVICE_BOOKING_STATES = \[\s*"accepted", "in_progress", "completed", "cancelled", "disputed",?\s*\]/,
  );
  assert.deepEqual(
    [...SERVICE_BOOKING_STATES],
    ["accepted", "in_progress", "completed", "cancelled", "disputed"],
  );
});

test("AMD-SVC-01: the transition table mirrors the migration guard", () => {
  const migration = readFileSync("../db/migrations/0036_service_bookings.sql", "utf8");
  assert.match(
    migration,
    /OLD\.state = 'accepted'\s+AND NEW\.state IN \('in_progress', 'cancelled', 'disputed'\)/,
  );
  assert.match(
    migration,
    /OLD\.state = 'in_progress'\s+AND NEW\.state IN \('completed', 'disputed'\)/,
  );
  assert.match(
    migration,
    /OLD\.state = 'disputed'\s+AND NEW\.state IN \('completed', 'cancelled'\)/,
  );
  assert.deepEqual(SERVICE_BOOKING_TRANSITIONS, [
    ["accepted", "in_progress"],
    ["accepted", "cancelled"],
    ["accepted", "disputed"],
    ["in_progress", "completed"],
    ["in_progress", "disputed"],
    ["disputed", "completed"],
    ["disputed", "cancelled"],
  ]);
});

test("AMD-SVC-02: the migration bounds pin the edge and client constants", () => {
  const migration = readFileSync("../db/migrations/0036_service_bookings.sql", "utf8");
  // agreed_minor bound, milestones bound, NGN pin, the 168 h / 30 d clocks.
  assert.match(migration, /CHECK \(agreed_minor > 0 AND agreed_minor <= 5000000\)/);
  assert.match(migration, /CHECK \(milestones BETWEEN 1 AND 12\)/);
  assert.match(migration, /CHECK \(currency = 'NGN'\)/);
  assert.match(migration, /interval '168 hours'/);
  assert.match(migration, /interval '30 days'/);
});

test("AMD-SVC-02: deterministic NGN formatting (no locale APIs)", () => {
  assert.equal(formatServiceAmount(0), "₦0.00");
  assert.equal(formatServiceAmount(50_000), "₦500.00");
  assert.equal(formatServiceAmount(100_000), "₦1,000.00");
  assert.equal(formatServiceAmount(5_000_000), "₦50,000.00");
  assert.equal(formatServiceAmount(123_456_789), "₦1,234,567.89");
});

test("AMD-SVC-02: the milestone schedule mirrors the book_service split", () => {
  // Even split; the last milestone absorbs the remainder.
  assert.deepEqual(milestoneAmounts(300_000, 3), [100_000, 100_000, 100_000]);
  assert.deepEqual(milestoneAmounts(100_000, 3), [33_333, 33_333, 33_334]);
  assert.deepEqual(milestoneAmounts(250_000, 1), [250_000]);
  assert.deepEqual(milestoneAmounts(5_000_000, 12).reduce((a, b) => a + b, 0), 5_000_000);
  // Out-of-bound inputs produce no schedule.
  assert.deepEqual(milestoneAmounts(0, 3), []);
  assert.deepEqual(milestoneAmounts(5_000_001, 3), []);
  assert.deepEqual(milestoneAmounts(100_000, 0), []);
  assert.deepEqual(milestoneAmounts(100_000, 13), []);
});

test("AMD-SVC-01: badges are exhaustive over the state machine", () => {
  assert.equal(serviceBookingBadge("accepted"), "Booked — waiting for the provider");
  assert.equal(serviceBookingBadge("in_progress"), "Work in progress");
  assert.equal(serviceBookingBadge("completed"), "Completed");
  assert.equal(serviceBookingBadge("cancelled"), "Cancelled");
  assert.equal(serviceBookingBadge("disputed"), "In dispute");
  assert.equal(SERVICE_BOOKING_STATES.length, 5);
});

test("AMD-SVC-01: the booking wire parser fails closed", () => {
  assert.deepEqual(parseServiceBookingWire(BOOKING_WIRE), BOOKING_WIRE);
  // An extra key — anything — refuses the row.
  assert.equal(parseServiceBookingWire({ ...BOOKING_WIRE, note: "bring tools" }), null);
  assert.equal(parseServiceBookingWire({ ...BOOKING_WIRE, address: "x" }), null);
  // An unknown state refuses the row.
  assert.equal(parseServiceBookingWire({ ...BOOKING_WIRE, state: "scheduled" }), null);
  // A non-NGN currency refuses the row (AMD-PAY-10).
  assert.equal(parseServiceBookingWire({ ...BOOKING_WIRE, currency: "USD" }), null);
  // A self-booking refuses the row.
  assert.equal(parseServiceBookingWire({ ...BOOKING_WIRE, provider: CUSTOMER_ID }), null);
  // Zero/over-ceiling amounts and bad milestone counts refuse.
  assert.equal(parseServiceBookingWire({ ...BOOKING_WIRE, agreedMinor: 0 }), null);
  assert.equal(parseServiceBookingWire({ ...BOOKING_WIRE, agreedMinor: 5_000_001 }), null);
  assert.equal(parseServiceBookingWire({ ...BOOKING_WIRE, milestones: 0 }), null);
  assert.equal(parseServiceBookingWire({ ...BOOKING_WIRE, milestones: 13 }), null);
  assert.equal(parseServiceBookingWire(null), null);
  assert.equal(parseServiceBookingWire("accepted"), null);
});

test("AMD-SVC-05: the event wire parser fails closed", () => {
  assert.deepEqual(parseServiceEventWire(EVENT_WIRE), EVENT_WIRE);
  // The creation event has no actor-side requirement but a null from_state.
  assert.deepEqual(
    parseServiceEventWire({
      eventId: "1", actor: CUSTOMER_ID, fromState: null,
      toState: "accepted", at: "2026-11-26T10:00:00Z",
    }),
    { eventId: "1", actor: CUSTOMER_ID, fromState: null,
      toState: "accepted", at: "2026-11-26T10:00:00Z" },
  );
  // An extra key refuses the row.
  assert.equal(parseServiceEventWire({ ...EVENT_WIRE, note: "x" }), null);
  // bigserial crosses the wire as a numeric string — anything else refuses.
  assert.equal(parseServiceEventWire({ ...EVENT_WIRE, eventId: 7 }), null);
  assert.equal(parseServiceEventWire({ ...EVENT_WIRE, eventId: "x" }), null);
  // A garbage actor or from_state refuses.
  assert.equal(parseServiceEventWire({ ...EVENT_WIRE, actor: "me" }), null);
  assert.equal(parseServiceEventWire({ ...EVENT_WIRE, fromState: "bogus" }), null);
  assert.equal(parseServiceEventWire(null), null);
});

test("AMD-SVC-02: the booking draft mirrors the client-known refusals", () => {
  const service = { listingId: LISTING_ID, kind: "service", state: "listed" };
  const ok = buildServiceBookingDraft(service, 250_000, 3);
  assert.deepEqual(ok, {
    ok: true,
    draft: { listingId: LISTING_ID, agreedMinor: 250_000, milestones: 3 },
  });
  // Only service-kind listings are bookable.
  assert.deepEqual(
    buildServiceBookingDraft({ ...service, kind: "goods" }, 250_000, 3),
    { ok: false, refusal: "not_a_service" },
  );
  // The listing must be live.
  assert.deepEqual(
    buildServiceBookingDraft({ ...service, state: "sold" }, 250_000, 3),
    { ok: false, refusal: "listing_not_listed" },
  );
  // The amount rides the AMD-PAY-05 ceiling.
  assert.deepEqual(
    buildServiceBookingDraft(service, 5_000_001, 3),
    { ok: false, refusal: "invalid_amount" },
  );
  assert.deepEqual(buildServiceBookingDraft(service, 0, 3), {
    ok: false, refusal: "invalid_amount",
  });
  assert.deepEqual(buildServiceBookingDraft(service, 1.5, 3), {
    ok: false, refusal: "invalid_amount",
  });
  // The milestone count fits the escrow array bound.
  assert.deepEqual(buildServiceBookingDraft(service, 250_000, 0), {
    ok: false, refusal: "invalid_milestones",
  });
  assert.deepEqual(buildServiceBookingDraft(service, 250_000, 13), {
    ok: false, refusal: "invalid_milestones",
  });
});

test("AMD-SVC-01/02/03: the action rules mirror the state machine", () => {
  // Start: the provider, on an accepted booking only.
  assert.equal(canStartService("accepted", true), true);
  assert.equal(canStartService("accepted", false), false);
  assert.equal(canStartService("in_progress", true), false);
  // Confirm: the customer, in progress, while a milestone remains.
  assert.equal(canConfirmMilestone("in_progress", true, 2), true);
  assert.equal(canConfirmMilestone("in_progress", true, null), false);
  assert.equal(canConfirmMilestone("in_progress", false, 2), false);
  assert.equal(canConfirmMilestone("accepted", true, 1), false);
  // Dispute: either party, live states only.
  assert.equal(canDisputeService("accepted", true), true);
  assert.equal(canDisputeService("in_progress", true), true);
  assert.equal(canDisputeService("in_progress", false), false);
  assert.equal(canDisputeService("completed", true), false);
  assert.equal(canDisputeService("disputed", true), false);
  // Roles resolve strictly from the party columns.
  assert.equal(serviceRole(BOOKING_WIRE, CUSTOMER_ID), "customer");
  assert.equal(serviceRole(BOOKING_WIRE, PROVIDER_ID), "provider");
  assert.equal(serviceRole(BOOKING_WIRE, ESCROW_ID), null);
});

test("AMD-SVC-05: the event stream derives the next milestone", () => {
  const booking = { milestones: 3, state: "in_progress" as const };
  assert.equal(nextMilestone(booking, []), 1);
  assert.equal(nextMilestone(booking, [{ toState: "milestone_confirmed" }]), 2);
  assert.equal(
    nextMilestone(booking, [
      { toState: "milestone_confirmed" },
      { toState: "milestone_confirmed" },
    ]),
    3,
  );
  // A completed booking's last release arrived as the completed event.
  assert.equal(
    nextMilestone({ milestones: 3, state: "completed" as const },
      [{ toState: "milestone_confirmed" }, { toState: "completed" }]),
    null,
  );
  // A cancelled booking has nothing awaiting.
  assert.equal(nextMilestone({ milestones: 3, state: "cancelled" as const }, []), null);
});

test("AMD-SVC-02: the booking card render model is structured only", () => {
  const items = serviceBookingItems(
    { state: "in_progress", agreedMinor: 250_000, milestones: 3 },
    "customer",
    [{ toState: "milestone_confirmed" }],
  );
  assert.deepEqual(items, [
    { label: "State", value: "Work in progress" },
    { label: "You pay", value: "₦2,500.00" },
    { label: "Milestones", value: "1 of 3 released" },
  ]);
  // The provider sees the amount from their side.
  const theirs = serviceBookingItems(
    { state: "accepted", agreedMinor: 250_000, milestones: 3 },
    "provider",
    [],
  );
  assert.deepEqual(theirs, [
    { label: "State", value: "Booked — waiting for the provider" },
    { label: "You earn", value: "₦2,500.00" },
    { label: "Milestones", value: "0 of 3 released" },
  ]);
  // A completed booking shows a full schedule even though the last release
  // arrived as the completed event.
  const done = serviceBookingItems(
    { state: "completed", agreedMinor: 250_000, milestones: 2 },
    "customer",
    [{ toState: "milestone_confirmed" }, { toState: "completed" }],
  );
  assert.deepEqual(done[2], { label: "Milestones", value: "2 of 2 released" });
});

test("NFR-27: the services copy keys exist in the launch locale", () => {
  const keys = [
    "ui.services.title",
    "ui.services.book",
    "ui.services.start",
    "ui.services.confirm-milestone",
    "ui.services.dispute",
    "ui.services.kyc-required",
    "ui.services.milestones",
    "ui.services.ghost-refund",
    "ui.services.booking.state.accepted",
    "ui.services.booking.state.in_progress",
    "ui.services.booking.state.completed",
    "ui.services.booking.state.cancelled",
    "ui.services.booking.state.disputed",
    "ui.vertical.services.label",
    "ui.vertical.services.summary",
  ];
  for (const key of keys) {
    assert.equal(typeof ENGLISH_COPY[key], "string", key);
    assert.ok((ENGLISH_COPY[key] as string).length > 0, key);
  }
});
