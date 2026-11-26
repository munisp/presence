/**
 * Barter swaps (SRS Addendum 001 — AMD-SWP-01..05): client contract.
 *
 * A swap is a marketplace mode: a structured have/want record exchanged
 * for another, with an optional cash balancer that moves exclusively
 * through the AMD-PAY-12 hold definers inside the AMD-PAY-15 settlement
 * gate. There is no description, no photo, no free text — the wire shape
 * has no field that could carry one (FR-87/FR-96/SEC-37 unchanged).
 *
 * The constants and transition tables mirror services/edge/src/barter.ts,
 * which mirrors db/migrations/0035_barter_swaps.sql; the client test
 * cross-pins all three. The client never decides a transition or an
 * eligibility outcome — it mirrors them so a card can explain its own
 * state; the definer is the only authority.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

/** AMD-SWP-04: the pinned swap bond (₦1,000 — the presence_bonds amount). */
export const SWAP_BOND_AMOUNT_MINOR = 100_000;
/** AMD-SWP-01: at most twelve live (listed | held) swap listings per owner. */
export const SWAP_MAX_ACTIVE = 12;
/** AMD-SWP-01/03: value estimates and balances ride the AMD-PAY-05 ceiling. */
export const SWAP_MAX_VALUE_MINOR = 5_000_000;
export const SWAP_MAX_BALANCE_MINOR = 5_000_000;
/** AMD-SWP-01: 1..3 distinct want categories per listing. */
export const SWAP_MAX_WANTS = 3;
/** AMD-SWP-03: proposals expire after 72 h; accepted agreements escalate
 * to disputed after 168 h without a completed exchange. */
export const SWAP_PROPOSE_TTL_SECONDS = 259_200;
export const SWAP_ACCEPT_TTL_SECONDS = 604_800;
/** AMD-SWP-02: the candidate surface is pinned small. */
export const SWAP_CANDIDATE_LIMIT = 50;
/** AMD-SWP-01: NGN is the launch currency (AMD-PAY-10). */
export const SWAP_CURRENCY = "NGN";

/** AMD-SWP-01: the swap listing state machine. */
export const SWAP_LISTING_STATES = ["listed", "held", "swapped", "removed"] as const;
export type SwapListingState = (typeof SWAP_LISTING_STATES)[number];
/** AMD-SWP-03: the agreement state machine. */
export const SWAP_AGREEMENT_STATES = [
  "proposed", "accepted", "completed", "cancelled", "disputed",
] as const;
export type SwapAgreementState = (typeof SWAP_AGREEMENT_STATES)[number];
/** AMD-SWP-04: the bond state machine. */
export const SWAP_BOND_STATES = ["active", "released", "forfeited"] as const;
export type SwapBondState = (typeof SWAP_BOND_STATES)[number];

/**
 * AMD-SWP-01: every legal listing transition — byte-identical to the
 * swap_listing_guard transition table in the migration.
 */
export const SWAP_LISTING_TRANSITIONS: ReadonlyArray<
  readonly [SwapListingState, SwapListingState]
> = [
  ["listed", "held"],
  ["listed", "removed"],
  ["held", "listed"],
  ["held", "swapped"],
];

/**
 * AMD-SWP-03/05: every legal agreement transition — byte-identical to the
 * swap_agreement_guard transition table in the migration.
 */
export const SWAP_AGREEMENT_TRANSITIONS: ReadonlyArray<
  readonly [SwapAgreementState, SwapAgreementState]
> = [
  ["proposed", "accepted"],
  ["proposed", "cancelled"],
  ["accepted", "completed"],
  ["accepted", "disputed"],
  ["disputed", "completed"],
  ["disputed", "cancelled"],
];

// ---------------------------------------------------------------------------
// Wire shapes (fail closed)
// ---------------------------------------------------------------------------

/** The wire shape of an own-listing row (GET /v1/swaps/listings/mine). */
export interface SwapListingWire {
  swapListingId: string;
  haveCategory: string;
  wantCategories: string[];
  valueEstimateMinor: number;
  currency: string;
  market: string;
  state: SwapListingState;
  createdAt: string;
  closedAt: string | null;
}

/** The wire shape of a candidate row (GET /v1/swaps/candidates) — no owner. */
export interface SwapCandidateWire {
  swapListingId: string;
  haveCategory: string;
  wantCategories: string[];
  valueEstimateMinor: number;
  market: string;
  listedAt: string;
}

/** The wire shape of an agreement row (GET /v1/swaps/agreements[/:id]). */
export interface SwapAgreementWire {
  agreementId: string;
  proposerListing: string;
  counterpartyListing: string;
  proposer: string;
  counterparty: string;
  balanceMinor: number;
  requiresBond: boolean;
  state: SwapAgreementState;
  proposerConfirmedAt: string | null;
  counterpartyConfirmedAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  disputedAt: string | null;
  completedAt: string | null;
}

const NODE_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+){0,4}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isNodeId(value: unknown): value is string {
  return typeof value === "string" && NODE_ID_RE.test(value);
}

function isMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isWantSet(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SWAP_MAX_WANTS) {
    return false;
  }
  for (const want of value) {
    if (!isNodeId(want)) return false;
  }
  return new Set(value).size === value.length;
}

/**
 * A wire listing the client cannot read is dropped, never repaired: an
 * unknown state or a shape with a free-text field is tampering, not data.
 */
export function parseSwapListingWire(body: unknown): SwapListingWire | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 9) return null;
  const {
    swapListingId, haveCategory, wantCategories, valueEstimateMinor,
    currency, market, state, createdAt, closedAt,
  } = body;
  if (!isUuid(swapListingId)) return null;
  if (!isNodeId(haveCategory)) return null;
  if (!isWantSet(wantCategories)) return null;
  if (!isMinor(valueEstimateMinor) || valueEstimateMinor === 0
      || (valueEstimateMinor as number) > SWAP_MAX_VALUE_MINOR) return null;
  if (currency !== SWAP_CURRENCY) return null;
  if (typeof market !== "string" || market.length < 1 || market.length > 64) return null;
  if (typeof state !== "string"
      || !(SWAP_LISTING_STATES as readonly string[]).includes(state)) return null;
  if (typeof createdAt !== "string") return null;
  if (!isIsoOrNull(closedAt)) return null;
  return {
    swapListingId, haveCategory, wantCategories,
    valueEstimateMinor: valueEstimateMinor as number,
    currency, market, state: state as SwapListingState, createdAt, closedAt,
  };
}

/**
 * A candidate row carries no owner (FR-30): the wire shape has no field
 * that could carry one, and a row that arrives with one is refused.
 */
export function parseSwapCandidateWire(body: unknown): SwapCandidateWire | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 6) return null;
  const {
    swapListingId, haveCategory, wantCategories, valueEstimateMinor,
    market, listedAt,
  } = body;
  if (!isUuid(swapListingId)) return null;
  if (!isNodeId(haveCategory)) return null;
  if (!isWantSet(wantCategories)) return null;
  if (!isMinor(valueEstimateMinor) || valueEstimateMinor === 0
      || (valueEstimateMinor as number) > SWAP_MAX_VALUE_MINOR) return null;
  if (typeof market !== "string" || market.length < 1 || market.length > 64) return null;
  if (typeof listedAt !== "string") return null;
  return {
    swapListingId, haveCategory, wantCategories,
    valueEstimateMinor: valueEstimateMinor as number, market, listedAt,
  };
}

/** An agreement wire the client cannot read is dropped, never repaired. */
export function parseSwapAgreementWire(body: unknown): SwapAgreementWire | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 14) return null;
  const {
    agreementId, proposerListing, counterpartyListing, proposer, counterparty,
    balanceMinor, requiresBond, state, proposerConfirmedAt,
    counterpartyConfirmedAt, createdAt, decidedAt, disputedAt, completedAt,
  } = body;
  if (!isUuid(agreementId) || !isUuid(proposerListing) || !isUuid(counterpartyListing)) {
    return null;
  }
  if (!isUuid(proposer) || !isUuid(counterparty)) return null;
  if (proposer === counterparty) return null;
  if (!isMinor(balanceMinor) || (balanceMinor as number) > SWAP_MAX_BALANCE_MINOR) {
    return null;
  }
  if (typeof requiresBond !== "boolean") return null;
  if (typeof state !== "string"
      || !(SWAP_AGREEMENT_STATES as readonly string[]).includes(state)) return null;
  if (!isIsoOrNull(proposerConfirmedAt) || !isIsoOrNull(counterpartyConfirmedAt)) {
    return null;
  }
  if (typeof createdAt !== "string") return null;
  if (!isIsoOrNull(decidedAt) || !isIsoOrNull(disputedAt) || !isIsoOrNull(completedAt)) {
    return null;
  }
  return {
    agreementId, proposerListing, counterpartyListing, proposer, counterparty,
    balanceMinor: balanceMinor as number, requiresBond,
    state: state as SwapAgreementState,
    proposerConfirmedAt, counterpartyConfirmedAt,
    createdAt, decidedAt, disputedAt, completedAt,
  };
}

// ---------------------------------------------------------------------------
// Proposal drafting (AMD-SWP-03) — the client-known refusals
// ---------------------------------------------------------------------------

export interface SwapProposalDraft {
  myListingId: string;
  theirListingId: string;
  balanceMinor: number;
  requiresBond: boolean;
}

export type SwapProposalRefusal =
  | "self_swap"
  | "invalid_balance"
  | "listing_not_listed"
  | "own_candidate";

/**
 * The refusals the client can know before the wire: a swap is never
 * self-referential, the balancer rides the AMD-PAY-05 ceiling, and the
 * proposer's own listing must be listed. KYC, blocks and the reciprocal
 * category check are server-side — the client never learns another
 * user's standing (FR-30 discipline).
 */
export function buildSwapProposalDraft(
  myListing: Pick<SwapListingWire, "swapListingId" | "state">,
  candidate: Pick<SwapCandidateWire, "swapListingId">,
  balanceMinor: number,
  requiresBond: boolean,
): { ok: true; draft: SwapProposalDraft } | { ok: false; refusal: SwapProposalRefusal } {
  if (myListing.swapListingId === candidate.swapListingId) {
    return { ok: false, refusal: "self_swap" };
  }
  if (myListing.state !== "listed") {
    return { ok: false, refusal: "listing_not_listed" };
  }
  if (!Number.isSafeInteger(balanceMinor) || balanceMinor < 0
      || balanceMinor > SWAP_MAX_BALANCE_MINOR) {
    return { ok: false, refusal: "invalid_balance" };
  }
  return {
    ok: true,
    draft: {
      myListingId: myListing.swapListingId,
      theirListingId: candidate.swapListingId,
      balanceMinor,
      requiresBond,
    },
  };
}

// ---------------------------------------------------------------------------
// Formatting, badges, action rules
// ---------------------------------------------------------------------------

/** Deterministic NGN formatting: ₦50,000.00 — no locale APIs. */
export function formatSwapBalance(balanceMinor: number, currency: string = SWAP_CURRENCY): string {
  const sign = balanceMinor < 0 ? "-" : "";
  const abs = Math.abs(balanceMinor);
  const naira = Math.floor(abs / 100);
  const kobo = String(abs % 100).padStart(2, "0");
  const grouped = String(naira).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₦${grouped}.${kobo}`;
}

/** Short state badge for a swap listing card. */
export function swapListingBadge(state: SwapListingState): string {
  switch (state) {
    case "listed": return "Listed";
    case "held": return "In a proposal";
    case "swapped": return "Swapped";
    case "removed": return "Removed";
  }
}

/** Short state badge for a swap agreement card. */
export function swapAgreementBadge(state: SwapAgreementState): string {
  switch (state) {
    case "proposed": return "Waiting for an answer";
    case "accepted": return "Exchange in progress";
    case "completed": return "Swap completed";
    case "cancelled": return "Cancelled";
    case "disputed": return "In dispute";
  }
}

/** A live swap listing counts against the owner's twelve-listing cap. */
export function swapListingIsLive(state: SwapListingState): boolean {
  return state === "listed" || state === "held";
}

/** The propose action exists only on a listed listing the viewer owns,
 * aimed at a candidate the viewer does not. */
export function canProposeSwap(state: SwapListingState, isSelf: boolean): boolean {
  return state === "listed" && isSelf;
}

/** The respond action exists only on a proposed agreement the viewer
 * did not send. */
export function canRespondSwap(state: SwapAgreementState, viewerIsProposer: boolean): boolean {
  return state === "proposed" && !viewerIsProposer;
}

/** The cancel action exists only on a proposed agreement the viewer sent. */
export function canCancelSwap(state: SwapAgreementState, viewerIsProposer: boolean): boolean {
  return state === "proposed" && viewerIsProposer;
}

/** The confirm action exists only on an accepted agreement, for a party
 * that has not confirmed yet. */
export function canConfirmSwap(
  state: SwapAgreementState,
  viewerIsParty: boolean,
  viewerConfirmedAt: string | null,
): boolean {
  return state === "accepted" && viewerIsParty && viewerConfirmedAt === null;
}

/** Either party may dispute an accepted agreement; nobody may dispute a
 * closed one. */
export function canDisputeSwap(state: SwapAgreementState, viewerIsParty: boolean): boolean {
  return state === "accepted" && viewerIsParty;
}

/** A bond can be staked on a bond-required agreement that is proposed or
 * accepted — never on a closed one. */
export function canStakeBond(
  state: SwapAgreementState,
  requiresBond: boolean,
  viewerIsParty: boolean,
): boolean {
  return requiresBond && viewerIsParty
    && (state === "proposed" || state === "accepted");
}

/**
 * The render model for an agreement card: the structured rows a surface
 * shows, in order. No free text exists to render (FR-96/SEC-37).
 */
export function swapAgreementItems(
  agreement: Pick<SwapAgreementWire, "balanceMinor" | "requiresBond" | "state">,
  viewerIsProposer: boolean,
): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = [
    { label: "State", value: swapAgreementBadge(agreement.state) },
  ];
  if (agreement.balanceMinor > 0) {
    items.push({
      label: viewerIsProposer ? "You add" : "They add",
      value: formatSwapBalance(agreement.balanceMinor),
    });
  }
  if (agreement.requiresBond) {
    items.push({ label: "Swap bond", value: formatSwapBalance(SWAP_BOND_AMOUNT_MINOR) });
  }
  return items;
}
