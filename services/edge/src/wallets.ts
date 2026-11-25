/**
 * SRS Addendum 001 — wallet validators (AMD-PAY-10..20).
 * Pure functions, unit-tested; the routes in routes/wallets.ts and
 * routes/walletRail.ts do the I/O.
 *
 *   AMD-PAY-10 — one wallet per user per currency; NGN at launch; the
 *     platform fee wallet is a pinned constant so the rail, the tests and
 *     the ops runbooks name the same account.
 *   AMD-PAY-11/12 — the entry kinds and hold states are closed sets,
 *     mirrored byte-for-byte by the client contract and cross-pinned
 *     against migration 0027 by tests/test_batch53.py.
 *   AMD-PAY-15 — the rail is live: the value-moving wires set
 *     app.transfer_settlement through the withSettlement /
 *     withRailCallback helpers (the ONLY writers of the GUC), behind the
 *     WALLET_RAIL operational kill switch. The definers keep their
 *     database gate as defence in depth.
 *   AMD-PAY-16/17 — funding and payout callbacks authenticate with an
 *     HMAC-SHA256 signature over the canonical field string; withdrawals
 *     carry the pinned caps and the closed state lifecycle.
 */

/** AMD-PAY-10: the launch currency — one currency, stated once. */
export const WALLET_CURRENCY = "NGN";

/** AMD-PAY-10: the three states a wallet can occupy. */
export const WALLET_STATUSES = ["active", "frozen", "closed"] as const;

export type WalletStatus = (typeof WALLET_STATUSES)[number];

export function isWalletStatus(raw: unknown): raw is WalletStatus {
  return typeof raw === "string" && (WALLET_STATUSES as readonly string[]).includes(raw);
}

/**
 * AMD-PAY-11: the six ledger kinds, signed by kind — fund, transfer_in
 * and fee_revenue credit; withdrawal, transfer_out and fee_charge debit.
 * Byte-identical to client/src/presence/walletView.ts and cross-pinned
 * against migration 0027.
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

/** AMD-PAY-12: the hold lifecycle — pending → posted | voided. */
export const WALLET_HOLD_STATES = ["pending", "posted", "voided"] as const;

export type WalletHoldState = (typeof WALLET_HOLD_STATES)[number];

export function isWalletHoldState(raw: unknown): raw is WalletHoldState {
  return typeof raw === "string" && (WALLET_HOLD_STATES as readonly string[]).includes(raw);
}

/** AMD-PAY-13: the platform fee wallet — fixed in migration 0027. */
export const PLATFORM_WALLET_ID = "00000000-0000-0000-0000-00000000fee1";

/**
 * AMD-PAY-10: wallet creation takes no fields — the currency is the
 * launch currency, the owner is the caller. A strict empty body; any
 * field at all refuses.
 */
export function parseWalletCreation(raw: unknown): Record<string, never> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Object.keys(raw as Record<string, unknown>).length !== 0) return null;
  return {};
}

/** AMD-PAY-17: the withdrawal lifecycle — requested → processing → paid | failed; requested → failed | cancelled. */
export const WITHDRAWAL_STATES = ["requested", "processing", "paid", "failed", "cancelled"] as const;

export type WithdrawalState = (typeof WITHDRAWAL_STATES)[number];

export function isWithdrawalState(raw: unknown): raw is WithdrawalState {
  return typeof raw === "string" && (WITHDRAWAL_STATES as readonly string[]).includes(raw);
}

/** AMD-PAY-17: per-withdrawal cap — NGN 50,000.00 in kobo, mirroring AMD-PAY-05. */
export const MAX_WITHDRAWAL_MINOR = 5_000_000;

/** AMD-PAY-17: rolling 24 h withdrawal cap — NGN 150,000.00 in kobo, mirroring AMD-PAY-05. */
export const DAILY_WITHDRAWAL_CAP_MINOR = 15_000_000;

/** AMD-PAY-16: per-event funding cap — NGN 150,000.00 in kobo. */
export const MAX_FUNDING_MINOR = 15_000_000;

const RAIL_REF_RE = /^.{8,128}$/;

/**
 * AMD-PAY-17: strict withdrawal body — {amountMinor, destinationRef} only.
 * The destination is an opaque provider-side payout reference, never raw
 * bank details.
 */
export function parseWithdrawalRequest(
  raw: unknown,
): { amountMinor: number; destinationRef: string } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes("amountMinor") || !keys.includes("destinationRef")) {
    return null;
  }
  const { amountMinor, destinationRef } = raw as { amountMinor: unknown; destinationRef: unknown };
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    return null;
  }
  if (typeof destinationRef !== "string" || !RAIL_REF_RE.test(destinationRef)) return null;
  return { amountMinor, destinationRef };
}

/** AMD-PAY-16: strict funding callback body — {walletId, amountMinor, reference} only. */
export function parseFundingCallback(
  raw: unknown,
): { walletId: string; amountMinor: number; reference: string } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (
    keys.length !== 3 ||
    !keys.includes("walletId") ||
    !keys.includes("amountMinor") ||
    !keys.includes("reference")
  ) {
    return null;
  }
  const { walletId, amountMinor, reference } = raw as {
    walletId: unknown;
    amountMinor: unknown;
    reference: unknown;
  };
  if (
    typeof walletId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(walletId)
  ) {
    return null;
  }
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    return null;
  }
  if (typeof reference !== "string" || !RAIL_REF_RE.test(reference)) return null;
  return { walletId, amountMinor, reference };
}

/** AMD-PAY-17: strict payout callback body — {requestId, outcome, reference} only. */
export function parsePayoutCallback(
  raw: unknown,
): { requestId: string; outcome: "completed" | "failed"; reference: string } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (
    keys.length !== 3 ||
    !keys.includes("requestId") ||
    !keys.includes("outcome") ||
    !keys.includes("reference")
  ) {
    return null;
  }
  const { requestId, outcome, reference } = raw as {
    requestId: unknown;
    outcome: unknown;
    reference: unknown;
  };
  if (
    typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)
  ) {
    return null;
  }
  if (outcome !== "completed" && outcome !== "failed") return null;
  if (typeof reference !== "string" || !RAIL_REF_RE.test(reference)) return null;
  return { requestId, outcome, reference };
}

/** AMD-PAY-17: strict moderation decision body — {decision} only, approve or reject. */
export function parseWithdrawalDecision(raw: unknown): { decision: "approve" | "reject" } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "decision") return null;
  const { decision } = raw as { decision: unknown };
  if (decision !== "approve" && decision !== "reject") return null;
  return { decision };
}

/**
 * AMD-PAY-22: maximum clock skew between the provider and the platform for
 * a webhook to still be considered fresh — five minutes.
 */
export const RAIL_SIGNATURE_SKEW_S = 300;

/**
 * AMD-PAY-16/17/22: the canonical string a provider signs — pinned field
 * order, colon-joined, timestamp first, so the platform and the provider
 * can never disagree about what was signed, and a replayed signature ages
 * out with its timestamp.
 */
export function fundingSignaturePayload(at: string, walletId: string, amountMinor: number, reference: string): string {
  return `${at}:${walletId}:${amountMinor}:${reference}`;
}

export function payoutSignaturePayload(at: string, requestId: string, outcome: string, reference: string): string {
  return `${at}:${requestId}:${outcome}:${reference}`;
}

/** AMD-PAY-22: the timestamp header is a unix epoch in seconds. */
export function parseRailTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  if (!/^[0-9]{1,12}$/.test(raw)) return null;
  const at = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(at)) return null;
  return at;
}

/** AMD-PAY-21: closed vocabularies mirroring 0029_rail_hardening.sql. */
export const RAIL_RISK_SIGNAL_KEYS = [
  "fund_velocity_1h",
  "fund_daily_volume",
  "withdrawal_velocity_1h",
] as const;
export type RailRiskSignalKey = (typeof RAIL_RISK_SIGNAL_KEYS)[number];

export const RAIL_SIGNAL_STATES = ["open", "acknowledged", "dismissed"] as const;
export type RailSignalState = (typeof RAIL_SIGNAL_STATES)[number];

/** AMD-PAY-23: manual credits above this threshold require a second moderator. */
export const FOUR_EYES_CREDIT_THRESHOLD_MINOR = 5_000_000;

export const CREDIT_APPROVAL_STATES = ["pending", "approved", "rejected"] as const;

/** AMD-PAY-21: strict ack body — {decision} only, acknowledge or dismiss. */
export function parseSignalDecision(raw: unknown): { decision: "acknowledge" | "dismiss" } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "decision") return null;
  const { decision } = raw as { decision: unknown };
  if (decision !== "acknowledge" && decision !== "dismiss") return null;
  return { decision };
}

/** AMD-PAY-23: value-moving routes take NO body — strict empty object only. */
export function parseEmptyBody(raw: unknown): true | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return Object.keys(raw as Record<string, unknown>).length === 0 ? true : null;
}
