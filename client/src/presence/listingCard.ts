/**
 * AMD-MKT-01..05: listing card — client contract.
 *
 * A listing is a structured record and nothing else: kind, category, price,
 * currency, market, state. There is no description, no photo, no free text
 * — the wire shape has no field that could carry one (FR-87/FR-96/SEC-37
 * unchanged).
 *
 * The constants mirror services/edge/src/marketplace.ts, which mirrors
 * db/migrations/0032_marketplace.sql; the client test cross-pins all
 * three. Price formatting is deterministic (no locale APIs): the card
 * reads the same on every device.
 */

/** Mirror of the listing kind vocabulary (AMD-MKT-01). */
export const LISTING_KINDS = ["item", "service"] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];
/** Mirror of the AMD-PAY-05-derived price ceiling (AMD-MKT-04). */
export const LISTING_MAX_PRICE_MINOR = 5_000_000;
/** Mirror of the launch currency (AMD-MKT-04 / AMD-PAY-10). */
export const MARKETPLACE_CURRENCY = "NGN";
/** Mirror of the listing state machine (AMD-MKT-01). */
export const LISTING_STATES = ["draft", "listed", "held", "sold", "removed"] as const;
export type ListingState = (typeof LISTING_STATES)[number];
/** Mirror of the order state machine — it mirrors its escrow (AMD-MKT-03). */
export const ORDER_STATES = ["active", "completed", "refunded", "disputed"] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export interface ListingCardModel {
  listingId: string;
  kind: ListingKind;
  category: string;
  priceMinor: number;
  currency: string;
  market: string;
  state: ListingState;
}

/** Deterministic NGN formatting: ₦50,000.00 — no locale APIs. */
export function formatListingPrice(priceMinor: number, currency: string = MARKETPLACE_CURRENCY): string {
  const sign = priceMinor < 0 ? "-" : "";
  const abs = Math.abs(priceMinor);
  const naira = Math.floor(abs / 100);
  const kobo = String(abs % 100).padStart(2, "0");
  const grouped = String(naira).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₦${grouped}.${kobo}`;
}

/** Short state badge for the card. */
export function listingStateBadge(state: ListingState): string {
  switch (state) {
    case "draft": return "Draft";
    case "listed": return "Listed";
    case "held": return "On hold";
    case "sold": return "Sold";
    case "removed": return "Removed";
  }
}

/** A live listing counts against the seller's twelve-listing cap. */
export function listingIsLive(state: ListingState): boolean {
  return state === "draft" || state === "listed" || state === "held";
}

/** The buy action exists only on a listed listing the viewer does not own. */
export function canPurchase(state: ListingState, isSelf: boolean): boolean {
  return state === "listed" && !isSelf;
}

/** The confirm action exists only on an active order the viewer bought. */
export function canConfirmPurchase(state: OrderState, viewerIsBuyer: boolean): boolean {
  return state === "active" && viewerIsBuyer;
}

/** Either party may dispute an active order; nobody may dispute a closed one. */
export function canDisputePurchase(state: OrderState, viewerIsParty: boolean): boolean {
  return state === "active" && viewerIsParty;
}
