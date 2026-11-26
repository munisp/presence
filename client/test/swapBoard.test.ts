/** AMD-SWP-01..05: swap board — formatting, badges, wire parsers, action
 * rules, transition and constant cross-pins. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ENGLISH_COPY } from "../src/presence/copyRegistry.js";
import {
  buildSwapProposalDraft,
  canCancelSwap,
  canConfirmSwap,
  canDisputeSwap,
  canProposeSwap,
  canRespondSwap,
  canStakeBond,
  formatSwapBalance,
  parseSwapAgreementWire,
  parseSwapCandidateWire,
  parseSwapListingWire,
  SWAP_ACCEPT_TTL_SECONDS,
  SWAP_AGREEMENT_STATES,
  SWAP_AGREEMENT_TRANSITIONS,
  SWAP_BOND_AMOUNT_MINOR,
  SWAP_BOND_STATES,
  SWAP_CANDIDATE_LIMIT,
  SWAP_CURRENCY,
  SWAP_LISTING_STATES,
  SWAP_LISTING_TRANSITIONS,
  SWAP_MAX_ACTIVE,
  SWAP_MAX_BALANCE_MINOR,
  SWAP_MAX_VALUE_MINOR,
  SWAP_MAX_WANTS,
  SWAP_PROPOSE_TTL_SECONDS,
  swapAgreementBadge,
  swapAgreementItems,
  swapListingBadge,
  swapListingIsLive,
} from "../src/presence/swapBoard.js";

const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
const AGREEMENT_ID = "33333333-3333-4333-8333-333333333333";
const PROPOSER_ID = "44444444-4444-4444-8444-444444444444";
const COUNTERPARTY_ID = "55555555-5555-4555-8555-555555555555";

const LISTING_WIRE = {
  swapListingId: LISTING_ID,
  haveCategory: "electronics.phones",
  wantCategories: ["electronics.laptops"],
  valueEstimateMinor: 250_000,
  currency: "NGN",
  market: "lagos",
  state: "listed",
  createdAt: "2026-11-26T10:00:00Z",
  closedAt: null,
};

const CANDIDATE_WIRE = {
  swapListingId: CANDIDATE_ID,
  haveCategory: "electronics.laptops",
  wantCategories: ["electronics.phones", "electronics.tablets"],
  valueEstimateMinor: 300_000,
  market: "lagos",
  listedAt: "2026-11-26T09:00:00Z",
};

const AGREEMENT_WIRE = {
  agreementId: AGREEMENT_ID,
  proposerListing: LISTING_ID,
  counterpartyListing: CANDIDATE_ID,
  proposer: PROPOSER_ID,
  counterparty: COUNTERPARTY_ID,
  balanceMinor: 50_000,
  requiresBond: true,
  state: "accepted",
  proposerConfirmedAt: null,
  counterpartyConfirmedAt: null,
  createdAt: "2026-11-26T10:00:00Z",
  decidedAt: "2026-11-26T10:05:00Z",
  disputedAt: null,
  completedAt: null,
};

test("AMD-SWP-01/03/04: the constants mirror the edge module", () => {
  // Cross-pinned: the edge mirrors the migration contract.
  const edge = readFileSync("../services/edge/src/barter.ts", "utf8");
  assert.match(edge, /SWAP_BOND_AMOUNT_MINOR = 100_000/);
  assert.match(edge, /SWAP_MAX_ACTIVE = 12/);
  assert.match(edge, /SWAP_MAX_VALUE_MINOR = 5_000_000/);
  assert.match(edge, /SWAP_MAX_BALANCE_MINOR = 5_000_000/);
  assert.match(edge, /SWAP_MAX_WANTS = 3/);
  assert.match(edge, /SWAP_PROPOSE_TTL_SECONDS = 259_200/);
  assert.match(edge, /SWAP_ACCEPT_TTL_SECONDS = 604_800/);
  assert.match(edge, /SWAP_CANDIDATE_LIMIT = 50/);
  assert.match(edge, /SWAP_CURRENCY = "NGN"/);
  assert.equal(SWAP_BOND_AMOUNT_MINOR, 100_000);
  assert.equal(SWAP_MAX_ACTIVE, 12);
  assert.equal(SWAP_MAX_VALUE_MINOR, 5_000_000);
  assert.equal(SWAP_MAX_BALANCE_MINOR, 5_000_000);
  assert.equal(SWAP_MAX_WANTS, 3);
  assert.equal(SWAP_PROPOSE_TTL_SECONDS, 259_200);
  assert.equal(SWAP_ACCEPT_TTL_SECONDS, 604_800);
  assert.equal(SWAP_CANDIDATE_LIMIT, 50);
  assert.equal(SWAP_CURRENCY, "NGN");
});

test("AMD-SWP-01/03/04: the state machines mirror the edge module", () => {
  const edge = readFileSync("../services/edge/src/barter.ts", "utf8");
  assert.match(edge, /SWAP_LISTING_STATES = \["listed", "held", "swapped", "removed"\]/);
  assert.deepEqual([...SWAP_LISTING_STATES], ["listed", "held", "swapped", "removed"]);
  assert.deepEqual(
    [...SWAP_AGREEMENT_STATES],
    ["proposed", "accepted", "completed", "cancelled", "disputed"],
  );
  assert.deepEqual([...SWAP_BOND_STATES], ["active", "released", "forfeited"]);
});

test("AMD-SWP-01/03: the transition tables mirror the migration guards", () => {
  const migration = readFileSync("../db/migrations/0035_barter_swaps.sql", "utf8");
  assert.match(migration, /OLD\.state = 'listed' AND NEW\.state IN \('held', 'removed'\)/);
  assert.match(migration, /OLD\.state = 'held'\s+AND NEW\.state IN \('listed', 'swapped'\)/);
  assert.match(migration, /OLD\.state = 'proposed' AND NEW\.state IN \('accepted', 'cancelled'\)/);
  assert.match(migration, /OLD\.state = 'accepted' AND NEW\.state IN \('completed', 'disputed'\)/);
  assert.match(migration, /OLD\.state = 'disputed' AND NEW\.state IN \('completed', 'cancelled'\)/);
  assert.deepEqual(SWAP_LISTING_TRANSITIONS, [
    ["listed", "held"],
    ["listed", "removed"],
    ["held", "listed"],
    ["held", "swapped"],
  ]);
  assert.deepEqual(SWAP_AGREEMENT_TRANSITIONS, [
    ["proposed", "accepted"],
    ["proposed", "cancelled"],
    ["accepted", "completed"],
    ["accepted", "disputed"],
    ["disputed", "completed"],
    ["disputed", "cancelled"],
  ]);
});

test("AMD-SWP-03: deterministic NGN formatting (no locale APIs)", () => {
  assert.equal(formatSwapBalance(0), "₦0.00");
  assert.equal(formatSwapBalance(50_000), "₦500.00");
  assert.equal(formatSwapBalance(100_000), "₦1,000.00");
  assert.equal(formatSwapBalance(5_000_000), "₦50,000.00");
  assert.equal(formatSwapBalance(123_456_789), "₦1,234,567.89");
});

test("AMD-SWP-01/03: badges are exhaustive over the state machines", () => {
  assert.equal(swapListingBadge("listed"), "Listed");
  assert.equal(swapListingBadge("held"), "In a proposal");
  assert.equal(swapListingBadge("swapped"), "Swapped");
  assert.equal(swapListingBadge("removed"), "Removed");
  assert.equal(swapAgreementBadge("proposed"), "Waiting for an answer");
  assert.equal(swapAgreementBadge("accepted"), "Exchange in progress");
  assert.equal(swapAgreementBadge("completed"), "Swap completed");
  assert.equal(swapAgreementBadge("cancelled"), "Cancelled");
  assert.equal(swapAgreementBadge("disputed"), "In dispute");
  assert.equal(SWAP_LISTING_STATES.length, 4);
  assert.equal(SWAP_AGREEMENT_STATES.length, 5);
});

test("AMD-SWP-01: a live listing is listed or held — the twelve-cap set", () => {
  assert.equal(swapListingIsLive("listed"), true);
  assert.equal(swapListingIsLive("held"), true);
  assert.equal(swapListingIsLive("swapped"), false);
  assert.equal(swapListingIsLive("removed"), false);
});

test("AMD-SWP-01: the listing wire parser fails closed", () => {
  assert.deepEqual(parseSwapListingWire(LISTING_WIRE), LISTING_WIRE);
  // An extra key — anything — refuses the row.
  assert.equal(parseSwapListingWire({ ...LISTING_WIRE, note: "great condition" }), null);
  assert.equal(parseSwapListingWire({ ...LISTING_WIRE, description: "x" }), null);
  assert.equal(parseSwapListingWire({ ...LISTING_WIRE, photoUrl: "x" }), null);
  // An unknown state refuses the row.
  assert.equal(parseSwapListingWire({ ...LISTING_WIRE, state: "draft" }), null);
  // A non-NGN currency refuses the row (AMD-PAY-10).
  assert.equal(parseSwapListingWire({ ...LISTING_WIRE, currency: "USD" }), null);
  // A zero or over-ceiling estimate refuses the row.
  assert.equal(parseSwapListingWire({ ...LISTING_WIRE, valueEstimateMinor: 0 }), null);
  assert.equal(
    parseSwapListingWire({ ...LISTING_WIRE, valueEstimateMinor: 5_000_001 }),
    null,
  );
  // A duplicated or empty want set refuses the row.
  assert.equal(parseSwapListingWire({ ...LISTING_WIRE, wantCategories: [] }), null);
  assert.equal(
    parseSwapListingWire({
      ...LISTING_WIRE,
      wantCategories: ["electronics.phones", "electronics.phones"],
    }),
    null,
  );
  assert.equal(parseSwapListingWire(null), null);
  assert.equal(parseSwapListingWire("listed"), null);
});

test("AMD-SWP-02: the candidate wire carries no owner — a row with one is refused", () => {
  assert.deepEqual(parseSwapCandidateWire(CANDIDATE_WIRE), CANDIDATE_WIRE);
  assert.equal(parseSwapCandidateWire({ ...CANDIDATE_WIRE, owner: PROPOSER_ID }), null);
  assert.equal(parseSwapCandidateWire({ ...CANDIDATE_WIRE, ownerId: PROPOSER_ID }), null);
  assert.equal(parseSwapCandidateWire({ ...CANDIDATE_WIRE, displayName: "Ada" }), null);
  assert.equal(parseSwapCandidateWire({ ...CANDIDATE_WIRE, state: "listed" }), null);
  assert.equal(parseSwapCandidateWire({ ...CANDIDATE_WIRE, currency: "NGN" }), null);
  assert.equal(parseSwapCandidateWire(null), null);
});

test("AMD-SWP-03: the agreement wire parser fails closed", () => {
  assert.deepEqual(parseSwapAgreementWire(AGREEMENT_WIRE), AGREEMENT_WIRE);
  assert.equal(parseSwapAgreementWire({ ...AGREEMENT_WIRE, memo: "pay fast" }), null);
  assert.equal(parseSwapAgreementWire({ ...AGREEMENT_WIRE, state: "settled" }), null);
  // A self-referential agreement refuses.
  assert.equal(
    parseSwapAgreementWire({ ...AGREEMENT_WIRE, counterparty: PROPOSER_ID }),
    null,
  );
  // An over-ceiling balancer refuses.
  assert.equal(
    parseSwapAgreementWire({ ...AGREEMENT_WIRE, balanceMinor: 5_000_001 }),
    null,
  );
  assert.equal(parseSwapAgreementWire({ ...AGREEMENT_WIRE, requiresBond: "yes" }), null);
  assert.equal(parseSwapAgreementWire(null), null);
});

test("AMD-SWP-03: the proposal draft mirrors the client-known refusals", () => {
  const mine = { swapListingId: LISTING_ID, state: "listed" as const };
  const candidate = { swapListingId: CANDIDATE_ID };
  const ok = buildSwapProposalDraft(mine, candidate, 50_000, true);
  assert.deepEqual(ok, {
    ok: true,
    draft: {
      myListingId: LISTING_ID,
      theirListingId: CANDIDATE_ID,
      balanceMinor: 50_000,
      requiresBond: true,
    },
  });
  // Never self-referential.
  assert.deepEqual(
    buildSwapProposalDraft(mine, { swapListingId: LISTING_ID }, 0, false),
    { ok: false, refusal: "self_swap" },
  );
  // The proposer's own listing must be listed.
  assert.deepEqual(
    buildSwapProposalDraft(
      { swapListingId: LISTING_ID, state: "held" as const },
      candidate,
      0,
      false,
    ),
    { ok: false, refusal: "listing_not_listed" },
  );
  // The balancer rides the AMD-PAY-05 ceiling.
  assert.deepEqual(
    buildSwapProposalDraft(mine, candidate, 5_000_001, false),
    { ok: false, refusal: "invalid_balance" },
  );
  assert.deepEqual(
    buildSwapProposalDraft(mine, candidate, -1, false),
    { ok: false, refusal: "invalid_balance" },
  );
  assert.deepEqual(
    buildSwapProposalDraft(mine, candidate, 1.5, false),
    { ok: false, refusal: "invalid_balance" },
  );
  // A zero balancer is a pure goods swap — legal.
  assert.equal(buildSwapProposalDraft(mine, candidate, 0, false).ok, true);
});

test("AMD-SWP-03/05: the action rules mirror the state machines", () => {
  // Propose: own listed listing aimed at someone else's candidate.
  assert.equal(canProposeSwap("listed", true), true);
  assert.equal(canProposeSwap("listed", false), false);
  assert.equal(canProposeSwap("held", true), false);
  // Respond: the counterparty answers a proposal.
  assert.equal(canRespondSwap("proposed", false), true);
  assert.equal(canRespondSwap("proposed", true), false);
  assert.equal(canRespondSwap("accepted", false), false);
  // Cancel: the proposer withdraws an unanswered proposal.
  assert.equal(canCancelSwap("proposed", true), true);
  assert.equal(canCancelSwap("proposed", false), false);
  assert.equal(canCancelSwap("accepted", true), false);
  // Confirm: a party to an accepted agreement, once each.
  assert.equal(canConfirmSwap("accepted", true, null), true);
  assert.equal(canConfirmSwap("accepted", true, "2026-11-26T11:00:00Z"), false);
  assert.equal(canConfirmSwap("accepted", false, null), false);
  assert.equal(canConfirmSwap("proposed", true, null), false);
  // Dispute: either party, accepted only.
  assert.equal(canDisputeSwap("accepted", true), true);
  assert.equal(canDisputeSwap("accepted", false), false);
  assert.equal(canDisputeSwap("completed", true), false);
  assert.equal(canDisputeSwap("disputed", true), false);
  // Bond: bond-required and open.
  assert.equal(canStakeBond("proposed", true, true), true);
  assert.equal(canStakeBond("accepted", true, true), true);
  assert.equal(canStakeBond("accepted", false, true), false);
  assert.equal(canStakeBond("completed", true, true), false);
  assert.equal(canStakeBond("accepted", true, false), false);
});

test("AMD-SWP-03/04: the agreement card render model is structured only", () => {
  const items = swapAgreementItems(
    { balanceMinor: 50_000, requiresBond: true, state: "accepted" },
    true,
  );
  assert.deepEqual(items, [
    { label: "State", value: "Exchange in progress" },
    { label: "You add", value: "₦500.00" },
    { label: "Swap bond", value: "₦1,000.00" },
  ]);
  // The counterparty sees the balancer from their side.
  const theirs = swapAgreementItems(
    { balanceMinor: 50_000, requiresBond: false, state: "proposed" },
    false,
  );
  assert.deepEqual(theirs, [
    { label: "State", value: "Waiting for an answer" },
    { label: "They add", value: "₦500.00" },
  ]);
  // A pure goods swap shows no balancer row.
  const pure = swapAgreementItems(
    { balanceMinor: 0, requiresBond: false, state: "completed" },
    true,
  );
  assert.deepEqual(pure, [{ label: "State", value: "Swap completed" }]);
});

test("NFR-27: the swap copy keys exist in the launch locale", () => {
  const keys = [
    "ui.swaps.title",
    "ui.swaps.create",
    "ui.swaps.propose",
    "ui.swaps.accept",
    "ui.swaps.decline",
    "ui.swaps.cancel",
    "ui.swaps.confirm",
    "ui.swaps.dispute",
    "ui.swaps.stake-bond",
    "ui.swaps.kyc-required",
    "ui.swaps.bond-required",
    "ui.swaps.balance",
    "ui.swaps.listing.state.listed",
    "ui.swaps.listing.state.held",
    "ui.swaps.listing.state.swapped",
    "ui.swaps.listing.state.removed",
    "ui.swaps.agreement.state.proposed",
    "ui.swaps.agreement.state.accepted",
    "ui.swaps.agreement.state.completed",
    "ui.swaps.agreement.state.cancelled",
    "ui.swaps.agreement.state.disputed",
  ];
  for (const key of keys) {
    assert.equal(typeof ENGLISH_COPY[key], "string", key);
    assert.ok((ENGLISH_COPY[key] as string).length > 0, key);
  }
});
