/**
 * SRS Addendum 001 — wallet validators (AMD-PAY-10..14).
 * Pure functions, unit-tested; the routes in routes/wallets.ts do the I/O.
 *
 *   AMD-PAY-10 — one wallet per user per currency; NGN at launch; the
 *     platform fee wallet is a pinned constant so the rail, the tests and
 *     the ops runbooks name the same account.
 *   AMD-PAY-11/12 — the entry kinds and hold states are closed sets,
 *     mirrored byte-for-byte by the client contract and cross-pinned
 *     against migration 0027 by tests/test_batch53.py.
 *   AMD-PAY-13 — there is deliberately no validator here that reaches a
 *     value-moving definer: wallet_move, place_wallet_hold,
 *     void_wallet_hold and settle_transfer_funds are rail-only, gated in
 *     the database by the transaction-local app.transfer_settlement
 *     setting no P0 component sets (AMD-PAY-08 extended). The routes
 *     expose creation, reads and moderation — never movement.
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
