/** AMD-VERT-01..05: vertical gate unit tests — map, parser, gate. */

import assert from "node:assert/strict";
import { test } from "node:test";
import Postgres from "pg";

import { EdgeContext } from "../src/context.js";
import {
  LOCKED_VERTICAL,
  VERTICALS,
  parseVerticalsPatchBody,
  verticalForTemplate,
  verticalGate,
} from "../src/verticals.js";

test("AMD-VERT-01: the ten verticals, locked core first", () => {
  assert.deepEqual([...VERTICALS], [
    "discovery", "venues", "groups", "dating", "marketplace",
    "services", "payments", "trust", "introductions", "serendipity",
  ]);
  assert.equal(LOCKED_VERTICAL, "discovery");
});

test("AMD-VERT-03: route templates map to their vertical", () => {
  const gated: Array<[string, string]> = [
    ["/v1/dating", "dating"],
    ["/v1/dating/preferences", "dating"],
    ["/v1/marketplace/listings", "marketplace"],
    ["/v1/marketplace/listings/mine", "marketplace"],
    ["/v1/swaps/listings", "marketplace"],
    ["/v1/swaps/listings/mine", "marketplace"],
    ["/v1/swaps/proposals", "marketplace"],
    ["/v1/services/bookings", "services"],
    ["/v1/services/bookings/mine", "services"],
    ["/v1/services/bookings/:bookingId/start", "services"],
    ["/v1/transfers", "payments"],
    ["/v1/wallets", "payments"],
    ["/v1/wallets/:walletId/entries", "payments"],
    ["/v1/presence/bond", "trust"],
    ["/v1/presence/bond/release", "trust"],
    ["/v1/met-receipts", "trust"],
    ["/v1/escrows", "trust"],
    ["/v1/escrows/:escrowId/dispute", "trust"],
    ["/v1/disclosure-grants", "trust"],
    ["/v1/attestation", "trust"],
    ["/v1/introductions", "introductions"],
    ["/v1/introductions/:introId/answer", "introductions"],
    ["/v1/serendipity/windows", "serendipity"],
    ["/v1/serendipity/windows/:windowId/state", "serendipity"],
    ["/v1/rooms/:roomKey", "venues"],
    ["/v1/rooms/:roomKey/join", "venues"],
    ["/v1/tables", "venues"],
    ["/v1/tables/:tableId/join", "venues"],
    ["/v1/slots/:slotId/book", "venues"],
    ["/v1/announcements", "venues"],
    ["/v1/announcements/:announcementId/respond", "venues"],
    ["/v1/presence/checkin", "venues"],
    ["/v1/venues/:venueId/rooms", "venues"],
    ["/v1/groups/:tableId/stake", "groups"],
    ["/v1/groups/:tableId/stake/refund", "groups"],
  ];
  for (const [template, vertical] of gated) {
    assert.equal(verticalForTemplate(template), vertical, template);
  }
});

test("AMD-VERT-03: moderation, account, ops and core surfaces stay ungated", () => {
  for (const template of [
    "/v1/presence",
    "/v1/presence/intent",
    "/v1/account/verticals",
    "/v1/account/visibility",
    "/v1/consent/:pairId/nudge",
    "/v1/blocks",
    "/v1/profile/interests",
    "/v1/moderation/wallets/:walletId/freeze",
    "/v1/moderation/wallets/reconciliation",
    "/v1/moderation/escrows/:escrowId/resolve",
    "/v1/moderation/bonds/:bondId/forfeit",
    "/v1/venues/:venueId/dashboard",
    "/v1/venues/:venueId/checkin-tokens",
    "/v1/venues/disclosure-verify",
    "/v1/taxonomy/releases",
    "/v1/telemetry/metrics",
  ]) {
    assert.equal(verticalForTemplate(template), null, template);
  }
});

test("AMD-VERT-05: the patch parser is strict", () => {
  assert.deepEqual(
    parseVerticalsPatchBody({ patch: { dating: false }, source: "onboarding" }),
    { patch: { dating: false }, source: "onboarding" },
  );
  assert.deepEqual(
    parseVerticalsPatchBody({ patch: { venues: true, trust: false }, source: "settings" }),
    { patch: { venues: true, trust: false }, source: "settings" },
  );
  // Affirming the locked core is allowed; narrowing it is refused.
  assert.notEqual(
    parseVerticalsPatchBody({ patch: { discovery: true }, source: "onboarding" }),
    null,
  );
  assert.equal(
    parseVerticalsPatchBody({ patch: { discovery: false }, source: "onboarding" }),
    null,
  );
  // Unknown keys, values, sources, shapes.
  assert.equal(parseVerticalsPatchBody({ patch: { bogus: true }, source: "settings" }), null);
  assert.equal(parseVerticalsPatchBody({ patch: { dating: "yes" }, source: "settings" }), null);
  assert.equal(parseVerticalsPatchBody({ patch: {}, source: "settings" }), null);
  assert.equal(parseVerticalsPatchBody({ patch: { dating: true }, source: "ops" }), null);
  assert.equal(parseVerticalsPatchBody({ patch: { dating: true } }), null);
  assert.equal(parseVerticalsPatchBody({ patch: { dating: true }, source: "settings", extra: 1 }), null);
  assert.equal(parseVerticalsPatchBody(null), null);
  assert.equal(parseVerticalsPatchBody("x"), null);
  assert.equal(parseVerticalsPatchBody({ patch: [1], source: "settings" }), null);
});

/** A pg stub good enough for withRls: connect + tx + one flag answer. */
function fakePg(enabled: boolean): Postgres.Pool {
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes("vertical_enabled")) {
        assert.deepEqual(params, ["dating"]);
        return { rows: [{ enabled }] };
      }
      return { rows: [] }; // BEGIN / COMMIT / ROLLBACK / set_config
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as Postgres.Pool;
}

function fakeReq(template: string) {
  return {
    userId: "11111111-2222-4333-8444-555555555555",
    routeOptions: { url: template },
  } as never;
}

function fakeReply() {
  const state: { code: number | null; body: unknown } = { code: null, body: null };
  const reply = {
    code(c: number) {
      state.code = c;
      return reply;
    },
    send(b: unknown) {
      state.body = b;
      return reply;
    },
  };
  return { reply: reply as never, state };
}

test("AMD-VERT-02/03: the gate narrows only what the caller switched off", async () => {
  // Vertical off → neutral 403 with the vertical named.
  const ctxOff = { pg: fakePg(false) } as EdgeContext;
  const off = fakeReply();
  await verticalGate(ctxOff)(fakeReq("/v1/dating/profile"), off.reply);
  assert.equal(off.state.code, 403);
  assert.deepEqual(off.state.body, { error: "vertical_disabled", vertical: "dating" });

  // Vertical on → the gate says nothing (no reply written).
  const ctxOn = { pg: fakePg(true) } as EdgeContext;
  const on = fakeReply();
  await verticalGate(ctxOn)(fakeReq("/v1/dating/profile"), on.reply);
  assert.equal(on.state.code, null);

  // Unmapped template → the pool is never touched.
  const never = {
    connect: async () => {
      throw new Error("pool must not be touched for ungated templates");
    },
  } as unknown as Postgres.Pool;
  const ctxCore = { pg: never } as EdgeContext;
  const core = fakeReply();
  await verticalGate(ctxCore)(fakeReq("/v1/presence"), core.reply);
  assert.equal(core.state.code, null);
  await verticalGate(ctxCore)(
    fakeReq("/v1/moderation/wallets/reconciliation"),
    core.reply,
  );
  assert.equal(core.state.code, null);
});
