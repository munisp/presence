/**
 * Marketplace listing primitive (SRS Addendum 001 — AMD-MKT-01..05).
 *
 * Pinned constants cross-checked against db/migrations/0032_marketplace.sql
 * by tests/test_batch57.py — a change here without a matching migration
 * change fails the suite.
 *
 * A listing is a structured record and nothing else: no description, no
 * photo, no free text (FR-87/FR-96/SEC-37 unchanged). Purchases compose
 * through the AMD-INN-03 escrow definers inside the AMD-PAY-15 settlement
 * gate — no new value machinery.
 */

/** AMD-MKT-01: a listing is an item or a service. */
export const LISTING_KINDS = ["item", "service"] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];
/** AMD-MKT-04: the price ceiling mirrors the AMD-PAY-05 per-transfer cap. */
export const LISTING_MAX_PRICE_MINOR = 5_000_000;
/** AMD-MKT-04: at most twelve live (draft | listed | held) listings per seller. */
export const LISTING_MAX_ACTIVE = 12;
/** AMD-MKT-04: NGN is the launch currency (AMD-PAY-10). */
export const MARKETPLACE_CURRENCY = "NGN";
/** Browse pages are pinned small; the route orders by listed_at desc. */
export const MARKETPLACE_BROWSE_LIMIT = 50;
/** AMD-MKT-01: the listing state machine. */
export const LISTING_STATES = ["draft", "listed", "held", "sold", "removed"] as const;
export type ListingState = (typeof LISTING_STATES)[number];
/** AMD-MKT-03: the order state machine mirrors its escrow. */
export const ORDER_STATES = ["active", "completed", "refunded", "disputed"] as const;
export type OrderState = (typeof ORDER_STATES)[number];

/** Taxonomy node ids are dotted lowercase paths, five levels deep at most (TR-17). */
const NODE_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+){0,4}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

export interface ListingDraft {
  kind: ListingKind;
  category: string;
  priceMinor: number;
  market: string;
}

/** AMD-MKT-01: {kind, category, priceMinor, market} only. */
export function parseListingBody(body: unknown): ListingDraft | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 4) return null;
  const { kind, category, priceMinor, market } = body;
  if (typeof kind !== "string" || !(LISTING_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  if (typeof category !== "string" || !NODE_ID_RE.test(category)) return null;
  if (typeof priceMinor !== "number" || !Number.isSafeInteger(priceMinor)
      || priceMinor <= 0 || priceMinor > LISTING_MAX_PRICE_MINOR) {
    return null;
  }
  if (typeof market !== "string" || market.length < 1 || market.length > 64) return null;
  return { kind: kind as ListingKind, category, priceMinor, market };
}

/** Browse filters — any subset of {category, kind, market}, nothing else. */
export function parseListingBrowseQuery(
  query: unknown,
): { category?: string; kind?: ListingKind; market?: string } | null {
  if (!isRecord(query)) return null;
  const out: { category?: string; kind?: ListingKind; market?: string } = {};
  for (const key of Object.keys(query)) {
    if (key === "category") {
      if (typeof query.category !== "string" || !NODE_ID_RE.test(query.category)) return null;
      out.category = query.category;
    } else if (key === "kind") {
      if (typeof query.kind !== "string" || !(LISTING_KINDS as readonly string[]).includes(query.kind)) {
        return null;
      }
      out.kind = query.kind as ListingKind;
    } else if (key === "market") {
      if (typeof query.market !== "string" || query.market.length < 1 || query.market.length > 64) {
        return null;
      }
      out.market = query.market;
    } else {
      return null;
    }
  }
  return out;
}

/** AMD-MKT-05: {reasonCode: 1..64 chars} only. */
export function parseModerationRemoveBody(body: unknown): { reasonCode: string } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || typeof body.reasonCode !== "string"
      || body.reasonCode.length < 1 || body.reasonCode.length > 64) {
    return null;
  }
  return { reasonCode: body.reasonCode };
}

/** AMD-MKT-03: {decision: 'refund' | 'release'} only. */
export function parseOrderResolution(body: unknown): { decision: "refund" | "release" } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || (body.decision !== "refund" && body.decision !== "release")) {
    return null;
  }
  return { decision: body.decision };
}

/** Empty-body guard for the action posts (list/remove/confirm/dispute). */
export function parseEmptyObject(body: unknown): Record<string, never> | null {
  if (!isRecord(body)) return null;
  if (Object.keys(body).length !== 0) return null;
  return {};
}

export { UUID_RE as MARKETPLACE_UUID_RE };
