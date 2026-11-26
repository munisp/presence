/**
 * Barter swaps (SRS Addendum 001 — AMD-SWP-01..05).
 *
 * Pinned constants cross-checked against db/migrations/0035_barter_swaps.sql
 * by tests/test_batch60.py — a change here without a matching migration
 * change fails the suite.
 *
 * A swap listing is a structured record and nothing else: a have, a want
 * set, a value estimate, a market. There is no description, no photo, no
 * free text — the wire shape has no field that could carry one
 * (FR-87/FR-96/SEC-37 unchanged). The balancer and the bonds move value
 * exclusively through the AMD-PAY-12 hold definers inside the AMD-PAY-15
 * settlement gate — no new value machinery.
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

/** Taxonomy node ids are dotted lowercase paths, five levels deep at most (TR-17). */
const NODE_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+){0,4}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

export interface SwapListingDraft {
  haveCategory: string;
  wantCategories: string[];
  valueEstimateMinor: number;
  market: string;
}

/** AMD-SWP-01: {haveCategory, wantCategories, valueEstimateMinor, market} only. */
export function parseSwapListingBody(body: unknown): SwapListingDraft | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 4) return null;
  const { haveCategory, wantCategories, valueEstimateMinor, market } = body;
  if (typeof haveCategory !== "string" || !NODE_ID_RE.test(haveCategory)) return null;
  if (!Array.isArray(wantCategories) || wantCategories.length < 1
      || wantCategories.length > SWAP_MAX_WANTS) return null;
  for (const want of wantCategories) {
    if (typeof want !== "string" || !NODE_ID_RE.test(want)) return null;
  }
  if (new Set(wantCategories).size !== wantCategories.length) return null;
  if (typeof valueEstimateMinor !== "number"
      || !Number.isSafeInteger(valueEstimateMinor)
      || valueEstimateMinor <= 0 || valueEstimateMinor > SWAP_MAX_VALUE_MINOR) {
    return null;
  }
  if (typeof market !== "string" || market.length < 1 || market.length > 64) return null;
  return { haveCategory, wantCategories, valueEstimateMinor, market };
}

export interface SwapProposalDraft {
  myListingId: string;
  theirListingId: string;
  balanceMinor: number;
  requiresBond: boolean;
}

/** AMD-SWP-03: {myListingId, theirListingId, balanceMinor, requiresBond} only. */
export function parseSwapProposalBody(body: unknown): SwapProposalDraft | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 4) return null;
  const { myListingId, theirListingId, balanceMinor, requiresBond } = body;
  if (typeof myListingId !== "string" || !UUID_RE.test(myListingId)) return null;
  if (typeof theirListingId !== "string" || !UUID_RE.test(theirListingId)) return null;
  if (myListingId === theirListingId) return null;
  if (typeof balanceMinor !== "number" || !Number.isSafeInteger(balanceMinor)
      || balanceMinor < 0 || balanceMinor > SWAP_MAX_BALANCE_MINOR) {
    return null;
  }
  if (typeof requiresBond !== "boolean") return null;
  return { myListingId, theirListingId, balanceMinor, requiresBond };
}

/** AMD-SWP-03: {accept} only — the counterparty's answer to a proposal. */
export function parseSwapResponseBody(body: unknown): { accept: boolean } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1) return null;
  if (typeof body.accept !== "boolean") return null;
  return { accept: body.accept };
}

/** AMD-SWP-05: {decision, forfeitBondId?} — moderation resolution. */
export function parseSwapResolutionBody(
  body: unknown,
): { decision: "refund" | "release"; forfeitBondId: string | null } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length < 1 || keys.length > 2) return null;
  if (body.decision !== "refund" && body.decision !== "release") return null;
  let forfeitBondId: string | null = null;
  if ("forfeitBondId" in body) {
    if (typeof body.forfeitBondId !== "string" || !UUID_RE.test(body.forfeitBondId)) {
      return null;
    }
    forfeitBondId = body.forfeitBondId;
  }
  return { decision: body.decision, forfeitBondId };
}
