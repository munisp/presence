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
 *   4. Withdrawal surface (AMD-PAY-17) — {@link planWithdrawal} mirrors
 *      the request_withdrawal definer's refusals the client can know:
 *      the pinned caps (byte-identical to the edge), the available
 *      balance, the destination shape. WITHDRAWAL_STATES is the closed
 *      lifecycle, cross-pinned edge and migration.
 *   5. No raw movement on the client (AMD-PAY-15) — the client plans and
 *      renders; the wire moves value through the definer-gated routes,
 *      behind the WALLET_RAIL operational kill switch. The client never
 *      writes the ledger.
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

/** AMD-PAY-17: the withdrawal lifecycle. Byte-identical to the edge copy. */
export const WITHDRAWAL_STATES = ["requested", "processing", "paid", "failed", "cancelled"] as const;

export type WithdrawalState = (typeof WITHDRAWAL_STATES)[number];

export function isWithdrawalState(raw: unknown): raw is WithdrawalState {
  return typeof raw === "string" && (WITHDRAWAL_STATES as readonly string[]).includes(raw);
}

/** AMD-PAY-17: per-withdrawal cap — NGN 50,000.00 in kobo. Byte-identical to the edge copy. */
export const MAX_WITHDRAWAL_MINOR = 5_000_000;

/** AMD-PAY-17: rolling 24 h withdrawal cap — NGN 150,000.00 in kobo. Byte-identical to the edge copy. */
export const DAILY_WITHDRAWAL_CAP_MINOR = 15_000_000;

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

/** The copy key a withdrawal state renders through. */
export function copyKeyForWithdrawalState(state: unknown): string | null {
  if (!isWithdrawalState(state)) return null;
  return `ui.wallet.withdrawal.${state}`;
}

/** What the client knows before requesting a payout (AMD-PAY-17). */
export interface WithdrawalPlan {
  amountMinor: number;
  /** The wallet's available balance (balance − held), as last rendered. */
  availableMinor: number;
  /** Withdrawals already in motion or paid in the last 24 h. */
  dailyUsedMinor: number;
  /** Opaque provider-side payout reference, 8–128 characters. */
  destinationRef: string;
}

export type WithdrawalDenial =
  | "invalid-input"
  | "invalid-destination"
  | "over-withdrawal-cap"
  | "exceeds-available"
  | "over-daily-cap";

export type WithdrawalVerdict = { allowed: true } | { allowed: false; reason: WithdrawalDenial };

/**
 * AMD-PAY-17: decide a withdrawal before the wire, mirroring the
 * request_withdrawal definer. The order of the refusals is pinned so the
 * UI explains exactly one reason: garbage input, destination shape, the
 * per-withdrawal cap, the available balance, then the rolling daily cap.
 * The definer re-decides everything server-side under the wallet row
 * lock; this planner exists so the user hears the truth before the
 * request leaves the device.
 */
export function planWithdrawal(plan: WithdrawalPlan): WithdrawalVerdict {
  if (
    plan === null ||
    typeof plan !== "object" ||
    !Number.isInteger(plan.amountMinor) ||
    plan.amountMinor <= 0 ||
    !Number.isInteger(plan.availableMinor) ||
    plan.availableMinor < 0 ||
    !Number.isInteger(plan.dailyUsedMinor) ||
    plan.dailyUsedMinor < 0 ||
    typeof plan.destinationRef !== "string"
  ) {
    return { allowed: false, reason: "invalid-input" };
  }
  const destination = plan.destinationRef.trim();
  if (destination.length < 8 || destination.length > 128) {
    return { allowed: false, reason: "invalid-destination" };
  }
  if (plan.amountMinor > MAX_WITHDRAWAL_MINOR) {
    return { allowed: false, reason: "over-withdrawal-cap" };
  }
  if (plan.amountMinor > plan.availableMinor) {
    return { allowed: false, reason: "exceeds-available" };
  }
  if (plan.dailyUsedMinor + plan.amountMinor > DAILY_WITHDRAWAL_CAP_MINOR) {
    return { allowed: false, reason: "over-daily-cap" };
  }
  return { allowed: true };
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
    copyKeyForEntryKind("note") === null &&
    WITHDRAWAL_STATES.length === 5 &&
    MAX_WITHDRAWAL_MINOR === 5_000_000 &&
    DAILY_WITHDRAWAL_CAP_MINOR === 15_000_000 &&
    planWithdrawal({
      amountMinor: 1_000_000,
      availableMinor: 2_000_000,
      dailyUsedMinor: 0,
      destinationRef: "PSP_rcpt_01234567",
    }).allowed === true &&
    (() => {
      const denied = planWithdrawal({
        amountMinor: 3_000_000,
        availableMinor: 2_000_000,
        dailyUsedMinor: 0,
        destinationRef: "PSP_rcpt_01234567",
      });
      return denied.allowed === false && denied.reason === "exceeds-available";
    })() &&
    (() => {
      const denied = planWithdrawal({
        amountMinor: 6_000_000,
        availableMinor: 20_000_000,
        dailyUsedMinor: 0,
        destinationRef: "PSP_rcpt_01234567",
      });
      return denied.allowed === false && denied.reason === "over-withdrawal-cap";
    })() &&
    (() => {
      const denied = planWithdrawal({
        amountMinor: 4_000_000,
        availableMinor: 20_000_000,
        dailyUsedMinor: 14_000_000,
        destinationRef: "PSP_rcpt_01234567",
      });
      return denied.allowed === false && denied.reason === "over-daily-cap";
    })() &&
    copyKeyForWithdrawalState("processing") === "ui.wallet.withdrawal.processing" &&
    copyKeyForWithdrawalState("garbage") === null
  );
}
