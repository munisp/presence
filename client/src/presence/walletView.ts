/**
 * SRS Addendum 001 — the client half of the wallet contract
 * (AMD-PAY-10..14).
 *
 * A wallet is the user's ledger account: one per user per currency, NGN
 * at launch, opened self-serve once identity verification is complete.
 * What is enforceable without the wire lands here as pure functions and
 * pinned constants:
 *
 *   1. Structured summary (AMD-PAY-10/11) — {@link buildWalletSummary}
 *      accepts exactly six fields: walletId, currency, status,
 *      balanceMinor, heldMinor, availableMinor. A smuggled extra field
 *      refuses the summary, and the arithmetic must agree — available is
 *      balance minus held, never negative. A wire that disagrees is
 *      tampering, not data.
 *   2. Closed vocabularies (AMD-PAY-11/12) — the statuses, entry kinds
 *      and hold states are pinned constants, byte-identical to the edge
 *      copies and cross-pinned against migration 0027 by
 *      tests/test_batch53.py.
 *   3. Creation planner (AMD-PAY-10) — {@link planWalletCreation}
 *      mirrors the create_wallet definer's refusals the client can
 *      know: verified identity, no existing NGN wallet.
 *   4. No movement surface (AMD-PAY-13) — there is deliberately no
 *      client function that moves value. Fund, withdraw, hold and
 *      settle stay rail-only behind the app.transfer_settlement GUC
 *      that no P0 component sets (AMD-PAY-08 extended). The client
 *      renders a ledger; it does not write one.
 *
 * The single import is the transfer contract: naira formatting and the
 * launch currency are already pinned there, byte-identical to the edge.
 */

import { TRANSFER_CURRENCY, formatTransferAmount } from "./transferCard.js";

/** AMD-PAY-10: the launch currency — the transfer contract's copy. */
export const WALLET_CURRENCY = TRANSFER_CURRENCY;

/** AMD-PAY-10: the three states a wallet can occupy. Byte-identical to the edge copy. */
export const WALLET_STATUSES = ["active", "frozen", "closed"] as const;

export type WalletStatus = (typeof WALLET_STATUSES)[number];

export function isWalletStatus(raw: unknown): raw is WalletStatus {
  return typeof raw === "string" && (WALLET_STATUSES as readonly string[]).includes(raw);
}

/**
 * AMD-PAY-11: the six ledger kinds, signed by kind — fund, transfer_in
 * and fee_revenue credit; withdrawal, transfer_out and fee_charge debit.
 * Byte-identical to services/edge/src/wallets.ts.
 */
export const WALLET_ENTRY_KINDS = [
  "fund",
  "withdrawal",
  "transfer_out",
  "transfer_in",
  "fee_charge",
  "fee_revenue",
] as const;

export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

export function isWalletEntryKind(raw: unknown): raw is WalletEntryKind {
  return typeof raw === "string" && (WALLET_ENTRY_KINDS as readonly string[]).includes(raw);
}

/** AMD-PAY-12: the hold lifecycle — pending → posted | voided. Byte-identical to the edge copy. */
export const WALLET_HOLD_STATES = ["pending", "posted", "voided"] as const;

export type WalletHoldState = (typeof WALLET_HOLD_STATES)[number];

export function isWalletHoldState(raw: unknown): raw is WalletHoldState {
  return typeof raw === "string" && (WALLET_HOLD_STATES as readonly string[]).includes(raw);
}

/** AMD-PAY-13: the platform fee wallet — fixed in migration 0027, byte-identical to the edge copy. */
export const PLATFORM_WALLET_ID = "00000000-0000-0000-0000-00000000fee1";

/**
 * AMD-PAY-10/11: the whole summary. Six fields, all structured. There is
 * deliberately no free-text field of any kind — a wallet summary states
 * an id, a currency, a status and three amounts, and nothing else.
 */
export interface WalletSummary {
  walletId: string;
  currency: string;
  status: WalletStatus;
  balanceMinor: number;
  heldMinor: number;
  availableMinor: number;
}

/** AMD-PAY-11: the pinned field set — a seventh field is a violation. */
export const WALLET_SUMMARY_FIELDS = [
  "walletId",
  "currency",
  "status",
  "balanceMinor",
  "heldMinor",
  "availableMinor",
] as const;

const WALLET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * AMD-PAY-11: build a summary from wire data, fail closed. The keys must
 * be exactly the pinned six, the id well-formed, the currency the launch
 * currency, the status legal, the amounts non-negative integers, and the
 * arithmetic exact: available = balance − held.
 */
export function buildWalletSummary(raw: unknown): WalletSummary | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== WALLET_SUMMARY_FIELDS.length) return null;
  for (const field of WALLET_SUMMARY_FIELDS) {
    if (!keys.includes(field)) return null;
  }
  const { walletId, currency, status, balanceMinor, heldMinor, availableMinor } = raw as {
    walletId: unknown;
    currency: unknown;
    status: unknown;
    balanceMinor: unknown;
    heldMinor: unknown;
    availableMinor: unknown;
  };
  if (typeof walletId !== "string" || !WALLET_ID_RE.test(walletId)) return null;
  if (currency !== WALLET_CURRENCY) return null;
  if (!isWalletStatus(status)) return null;
  if (!Number.isInteger(balanceMinor) || (balanceMinor as number) < 0) return null;
  if (!Number.isInteger(heldMinor) || (heldMinor as number) < 0) return null;
  if (!Number.isInteger(availableMinor) || (availableMinor as number) < 0) return null;
  if ((balanceMinor as number) - (heldMinor as number) !== availableMinor) return null;
  return {
    walletId,
    currency: WALLET_CURRENCY,
    status,
    balanceMinor: balanceMinor as number,
    heldMinor: heldMinor as number,
    availableMinor: availableMinor as number,
  };
}

/** What the client knows before opening a wallet. */
export interface WalletPlan {
  selfKycVerified: boolean;
  /** Currencies the caller already holds wallets in. */
  existingCurrencies: readonly string[];
}

export type WalletDenial = "invalid-input" | "not-kyc-verified" | "wallet-exists";

export type WalletVerdict = { allowed: true } | { allowed: false; reason: WalletDenial };

/**
 * AMD-PAY-10: decide a creation before the wire, mirroring the
 * create_wallet definer. The order of the refusals is pinned so the UI
 * can explain exactly one reason: garbage input, verification, then the
 * existing wallet.
 */
export function planWalletCreation(plan: WalletPlan): WalletVerdict {
  if (
    plan === null ||
    typeof plan !== "object" ||
    typeof plan.selfKycVerified !== "boolean" ||
    !Array.isArray(plan.existingCurrencies) ||
    plan.existingCurrencies.some((c) => typeof c !== "string")
  ) {
    return { allowed: false, reason: "invalid-input" };
  }
  if (!plan.selfKycVerified) {
    return { allowed: false, reason: "not-kyc-verified" };
  }
  if (plan.existingCurrencies.includes(WALLET_CURRENCY)) {
    return { allowed: false, reason: "wallet-exists" };
  }
  return { allowed: true };
}

/**
 * AMD-PAY-10: deterministic naira rendering of any wallet amount —
 * delegated to the transfer contract's pinned formatter so the wallet
 * and the transfer card can never render the same amount differently.
 */
export function formatWalletAmount(amountMinor: unknown): string | null {
  return formatTransferAmount(amountMinor, WALLET_CURRENCY);
}

/** The copy key a wallet status renders through (NFR-27 registry). */
export function copyKeyForWalletStatus(status: unknown): string | null {
  if (!isWalletStatus(status)) return null;
  return `ui.wallet.status.${status}`;
}

/** The copy key a ledger entry kind renders through. */
export function copyKeyForEntryKind(kind: unknown): string | null {
  if (!isWalletEntryKind(kind)) return null;
  return `ui.wallet.entry.${kind}`;
}

/** The copy key a hold state renders through. */
export function copyKeyForHoldState(state: unknown): string | null {
  if (!isWalletHoldState(state)) return null;
  return `ui.wallet.hold.${state}`;
}

/**
 * The master guard the shell asserts: the vocabularies are exactly the
 * pinned sets, the platform wallet id is the migration value, a summary
 * builds only from the pinned six fields with exact arithmetic, a
 * smuggled or inconsistent summary refuses, the planner refuses with
 * exactly one reason, and the formatter agrees with the transfer card.
 */
export function walletHonoursAmendment(): boolean {
  if (
    WALLET_STATUSES.length !== 3 ||
    WALLET_ENTRY_KINDS.length !== 6 ||
    WALLET_HOLD_STATES.length !== 3
  ) {
    return false;
  }
  if (
    WALLET_CURRENCY !== "NGN" ||
    PLATFORM_WALLET_ID !== "00000000-0000-0000-0000-00000000fee1"
  ) {
    return false;
  }
  const valid = buildWalletSummary({
    walletId: "11111111-2222-4333-8444-555555555555",
    currency: "NGN",
    status: "active",
    balanceMinor: 1_250_000,
    heldMinor: 250_000,
    availableMinor: 1_000_000,
  });
  if (valid === null) return false;
  const keys = Object.keys(valid).sort();
  if (
    keys.join(",") !==
    ["availableMinor", "balanceMinor", "currency", "heldMinor", "status", "walletId"].join(",")
  ) {
    return false;
  }
  const base = {
    walletId: "11111111-2222-4333-8444-555555555555",
    currency: "NGN",
    status: "active",
    balanceMinor: 1_250_000,
    heldMinor: 250_000,
    availableMinor: 1_000_000,
  };
  return (
    buildWalletSummary({ ...base, note: "savings" }) === null &&
    buildWalletSummary({ ...base, availableMinor: 999_999 }) === null &&
    buildWalletSummary({ ...base, status: "garbage" }) === null &&
    buildWalletSummary({ ...base, currency: "USD" }) === null &&
    planWalletCreation({ selfKycVerified: true, existingCurrencies: [] }).allowed === true &&
    (() => {
      const denied = planWalletCreation({ selfKycVerified: false, existingCurrencies: [] });
      return denied.allowed === false && denied.reason === "not-kyc-verified";
    })() &&
    (() => {
      const denied = planWalletCreation({ selfKycVerified: true, existingCurrencies: ["NGN"] });
      return denied.allowed === false && denied.reason === "wallet-exists";
    })() &&
    formatWalletAmount(1_250_000) === "₦12,500.00" &&
    copyKeyForWalletStatus("frozen") === "ui.wallet.status.frozen" &&
    copyKeyForEntryKind("transfer_in") === "ui.wallet.entry.transfer_in" &&
    copyKeyForHoldState("posted") === "ui.wallet.hold.posted" &&
    copyKeyForWalletStatus("garbage") === null &&
    copyKeyForEntryKind("note") === null
  );
}
