/**
 * SRS Addendum 001 — P2P transfer validators (AMD-PAY-03..08).
 * Pure functions, unit-tested; the routes in routes/transfers.ts do the I/O.
 *
 *   AMD-PAY-04 — TRANSFER_TRANSITIONS is the legal-transition table the
 *     record_transfer_event definer enforces in the database; this mirror
 *     lets the route refuse garbage before touching the wire. The client
 *     carries a third copy, and tests/test_batch49.py cross-pins all three.
 *   AMD-PAY-05 — the caps and the fee are pinned constants, mirrored
 *     byte-for-byte by the client contract; the database computes the fee
 *     at proposal and this module's computeFeeMinor must agree.
 *   AMD-PAY-06 — TRANSFER_ACCEPT_WINDOW_MS mirrors the one-hour
 *     acceptance window the migration writes into expires_at.
 *   AMD-PAY-03 — a transfer is amount, currency, fee and state. The
 *     dispute vocabulary is a closed set; there is no free text anywhere.
 */

/** AMD-PAY-04: the eight states a transfer can occupy. */
export const TRANSFER_STATES = [
  "proposed",
  "accepted",
  "declined",
  "cancelled",
  "expired",
  "settled",
  "disputed",
  "resolved",
] as const;

export type TransferState = (typeof TRANSFER_STATES)[number];

export type TransferEvent = Exclude<TransferState, "proposed">;

/**
 * AMD-PAY-04: every legal transition — the recipient answers (accepted,
 * declined), the sender cancels, the clock expires, the rail alone
 * settles (AMD-PAY-08), either party disputes, moderation alone resolves.
 * Byte-identical to client/src/presence/transferCard.ts and cross-pinned
 * against the definer in migration 0025.
 */
export const TRANSFER_TRANSITIONS: ReadonlyArray<readonly [TransferState, TransferEvent]> = [
  ["proposed", "accepted"],
  ["proposed", "declined"],
  ["proposed", "cancelled"],
  ["proposed", "expired"],
  ["accepted", "settled"],
  ["accepted", "disputed"],
  ["settled", "disputed"],
  ["disputed", "resolved"],
];

export function isTransferState(raw: unknown): raw is TransferState {
  return typeof raw === "string" && (TRANSFER_STATES as readonly string[]).includes(raw);
}

/** Legal per AMD-PAY-04; unknown states or illegal pairs fail closed. */
export function isLegalTransferTransition(from: unknown, to: unknown): boolean {
  if (!isTransferState(from) || !isTransferState(to)) return false;
  return TRANSFER_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** AMD-PAY-01: the launch currency — one currency, stated once. */
export const TRANSFER_CURRENCY = "NGN";

/** AMD-PAY-05: per-transfer cap — NGN 50,000.00 in kobo. */
export const MAX_TRANSFER_MINOR = 5_000_000;

/** AMD-PAY-05: rolling 24 h sender cap — NGN 150,000.00 in kobo. */
export const DAILY_TRANSFER_CAP_MINOR = 15_000_000;

/** AMD-PAY-05: the fee — 100 basis points, floored, computed identically in the database. */
export const TRANSFER_FEE_BPS = 100;

/** AMD-PAY-06: a proposal lives for one hour unaccepted. */
export const TRANSFER_ACCEPT_WINDOW_MS = 3_600_000;

/** AMD-PAY-05: floor(amount × bps / 10 000) — mirrors migration 0025. */
export function computeFeeMinor(amountMinor: number): number | null {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return null;
  return Math.floor((amountMinor * TRANSFER_FEE_BPS) / 10_000);
}

/**
 * AMD-PAY-03/07: the dispute vocabulary is closed — a dispute is a
 * category, never free text. Mirrored byte-for-byte by the client.
 */
export const DISPUTE_REASONS = ["not-received", "wrong-amount", "unauthorised"] as const;

export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export function isDisputeReason(raw: unknown): raw is DisputeReason {
  return typeof raw === "string" && (DISPUTE_REASONS as readonly string[]).includes(raw);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** TR-23: strict body — {recipient, amountMinor} only, unknown fields refuse. */
export function parseTransferProposal(
  raw: unknown,
): { recipient: string; amountMinor: number } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes("recipient") || !keys.includes("amountMinor")) {
    return null;
  }
  const { recipient, amountMinor } = raw as { recipient: unknown; amountMinor: unknown };
  if (typeof recipient !== "string" || !UUID_RE.test(recipient)) return null;
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    return null;
  }
  return { recipient, amountMinor };
}

/** AMD-PAY-03: strict dispute body — {reason} only, from the closed set. */
export function parseTransferDispute(raw: unknown): { reason: DisputeReason } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "reason") return null;
  const { reason } = raw as { reason: unknown };
  if (!isDisputeReason(reason)) return null;
  return { reason };
}

/** AMD-PAY-04: strict resolution body — {outcome} only, upheld or rejected. */
export function parseDisputeOutcome(raw: unknown): { outcome: "upheld" | "rejected" } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "outcome") return null;
  const { outcome } = raw as { outcome: unknown };
  if (outcome !== "upheld" && outcome !== "rejected") return null;
  return { outcome };
}
