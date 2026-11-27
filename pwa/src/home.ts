/**
 * AMD-PWA-03 (the member home): the lite client's home document is a
 * fan-out across the member's own read models — identity, KYC status,
 * consent pairs, wallets — with the console's AMD-CON-03 tolerance
 * discipline adapted for member semantics:
 *
 *   - 401 PROPAGATES — the session is dead; the only remedy is sign-in;
 *   - 403/404 DEGRADE PER SECTION — a member without an identity row yet
 *     (404 on /v1/profile/identity is a normal state) or without KYC
 *     still gets the rest of their home, never a blank screen;
 *   - network/5xx marks the section UNAVAILABLE and the render half
 *     falls back to the AMD-PWA-04 read cache, marked stale.
 *
 * The consent-pair state vocabulary is mirrored verbatim from the edge
 * (services/edge/src/routes/consent.ts): DETECTED | NUDGED | EXPRESSED |
 * MUTUAL | OPEN. The attention model orders what needs the member first,
 * and its count drives the app badge.
 */

import {
  MemberApi,
  MemberApiError,
  MemberForbiddenError,
  MemberNotFoundError,
} from "./memberApi.js";

/** The pair state machine, mirrored verbatim from the edge. */
export const PAIR_STATES = ["DETECTED", "NUDGED", "EXPRESSED", "MUTUAL", "OPEN"] as const;
export type PairState = (typeof PAIR_STATES)[number];

export interface IdentitySummary {
  handle: string;
  displayName: string;
  photoUrl: string | null;
}

export interface PairSummary {
  pairId: string;
  state: PairState;
  /** Only present once OPEN — pre-OPEN the counterpart is pseudonymous. */
  counterpart: string | null;
  offerExpiresAt: string | null;
}

export interface WalletSummary {
  walletId: string;
  currency: string;
  status: string;
  balanceMinor: number;
  heldMinor: number;
  availableMinor: number;
}

/** One section's read: the document, or why it is missing. */
export type SectionRead<T> =
  | { kind: "ok"; document: T }
  | { kind: "absent" } // 404 — a normal member state
  | { kind: "refused" } // 403 — the edge said no
  | { kind: "unavailable" }; // network/5xx — the render half uses the cache

export interface HomeDocument {
  identity: SectionRead<IdentitySummary>;
  kycStatus: SectionRead<string>;
  pairs: SectionRead<PairSummary[]>;
  wallets: SectionRead<WalletSummary[]>;
}

interface IdentityWire {
  handle?: unknown;
  displayName?: unknown;
  photoUrl?: unknown;
}

interface ConsentWire {
  pairs?: unknown;
}

interface PairWire {
  pairId?: unknown;
  state?: unknown;
  counterpart?: unknown;
  offerExpiresAt?: unknown;
}

interface WalletsWire {
  wallets?: unknown;
}

interface WalletWire {
  walletId?: unknown;
  currency?: unknown;
  status?: unknown;
  balanceMinor?: unknown;
  heldMinor?: unknown;
  availableMinor?: unknown;
}

interface KycWire {
  status?: unknown;
}

function parseIdentity(wire: unknown): IdentitySummary {
  const w = wire as IdentityWire;
  return {
    handle: typeof w.handle === "string" ? w.handle : "member",
    displayName:
      typeof w.displayName === "string" ? w.displayName : typeof w.handle === "string" ? w.handle : "member",
    photoUrl: typeof w.photoUrl === "string" ? w.photoUrl : null,
  };
}

function parsePairs(wire: unknown): PairSummary[] {
  const raw = (wire as ConsentWire).pairs;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p): PairSummary | null => {
      const w = p as PairWire;
      if (typeof w.pairId !== "string") return null;
      const state = (PAIR_STATES as readonly string[]).includes(String(w.state))
        ? (w.state as PairState)
        : "DETECTED";
      return {
        pairId: w.pairId,
        state,
        counterpart: typeof w.counterpart === "string" ? w.counterpart : null,
        offerExpiresAt: typeof w.offerExpiresAt === "string" ? w.offerExpiresAt : null,
      };
    })
    .filter((p): p is PairSummary => p !== null);
}

function parseWallets(wire: unknown): WalletSummary[] {
  const raw = (wire as WalletsWire).wallets;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p): WalletSummary | null => {
      const w = p as WalletWire;
      if (typeof w.walletId !== "string" || typeof w.currency !== "string") return null;
      const minor = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      return {
        walletId: w.walletId,
        currency: w.currency,
        status: typeof w.status === "string" ? w.status : "unknown",
        balanceMinor: minor(w.balanceMinor),
        heldMinor: minor(w.heldMinor),
        availableMinor: minor(w.availableMinor),
      };
    })
    .filter((p): p is WalletSummary => p !== null);
}

/** Tolerant section read: 403/404 degrade, everything else is unavailable. */
async function section<T>(
  read: () => Promise<unknown>,
  parse: (wire: unknown) => T,
): Promise<SectionRead<T>> {
  try {
    return { kind: "ok", document: parse(await read()) };
  } catch (error) {
    if (error instanceof MemberNotFoundError) return { kind: "absent" };
    if (error instanceof MemberForbiddenError) return { kind: "refused" };
    if (error instanceof MemberApiError && error.status === 401) throw error; // session dead — propagate
    return { kind: "unavailable" };
  }
}

/** The fan-out. A dead session (401) aborts the whole home — sign in again. */
export async function fetchHome(api: MemberApi): Promise<HomeDocument> {
  const [identity, kycStatus, pairs, wallets] = await Promise.all([
    section(() => api.get("/v1/profile/identity"), parseIdentity),
    section(
      () => api.get("/v1/identity/status"),
      (wire) => {
        const w = wire as KycWire;
        return typeof w.status === "string" ? w.status : "unknown";
      },
    ),
    section(() => api.get("/v1/consent"), parsePairs),
    section(() => api.get("/v1/wallets"), parseWallets),
  ]);
  return { identity, kycStatus, pairs, wallets };
}

export interface AttentionItem {
  kind: "pair-awaiting-you" | "pair-ready-to-open" | "kyc-incomplete" | "wallet-on-hold";
  label: string;
  ref: string;
}

/**
 * What needs the member first, in order: a nudge awaiting their answer,
 * a mutual pair ready to open, incomplete verification, held funds.
 */
export function attentionItems(home: HomeDocument): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (home.pairs.kind === "ok") {
    for (const pair of home.pairs.document) {
      if (pair.state === "NUDGED") {
        items.push({
          kind: "pair-awaiting-you",
          label: "Someone nearby waved — answer the nudge",
          ref: pair.pairId,
        });
      } else if (pair.state === "MUTUAL") {
        items.push({
          kind: "pair-ready-to-open",
          label: "Mutual interest — open the conversation",
          ref: pair.pairId,
        });
      }
    }
  }
  if (home.kycStatus.kind === "ok" && home.kycStatus.document !== "verified") {
    items.push({
      kind: "kyc-incomplete",
      label: "Finish identity verification to unlock everything",
      ref: "kyc",
    });
  }
  if (home.wallets.kind === "ok") {
    for (const wallet of home.wallets.document) {
      if (wallet.heldMinor > 0) {
        items.push({
          kind: "wallet-on-hold",
          label: `${formatMinor(wallet.heldMinor, wallet.currency)} on hold`,
          ref: wallet.walletId,
        });
      }
    }
  }
  return items;
}

/** The app-badge count: pairs awaiting the member, nothing else. */
export function badgeCountFor(home: HomeDocument): number {
  if (home.pairs.kind !== "ok") return 0;
  return home.pairs.document.filter((p) => p.state === "NUDGED" || p.state === "MUTUAL").length;
}

/** ISO minor units → a member-readable amount ("₦1,250.00" / "NGN …"). */
export function formatMinor(minor: number, currency: string): string {
  const major = minor / 100;
  const formatted = major.toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "NGN" ? `₦${formatted}` : `${currency} ${formatted}`;
}
