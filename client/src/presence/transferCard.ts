/**
 * SRS Addendum 001 — the client half of the P2P transfer contract
 * (AMD-PAY-01..08).
 *
 * The owner's amendment premise: every user of the platform is KYC and
 * vetted, so money may move between two verified people who share an
 * open conversation — through a structured transfer card, never through
 * free text. What is enforceable without the wire lands here as pure
 * functions and pinned constants:
 *
 *   1. Structured card (AMD-PAY-03) — {@link buildTransferCard} accepts
 *      exactly four fields: amountMinor, feeMinor, currency, state. A
 *      smuggled extra field — a "note", a "memo", anything — refuses the
 *      card. The type carries no free-text field, so solicitation is
 *      unrepresentable, not merely screened (FR-96/SEC-37 unchanged).
 *   2. Dual consent (AMD-PAY-04) — {@link TRANSFER_TRANSITIONS} is the
 *      eight-move legal table, byte-identical to the edge copy and
 *      cross-pinned against the record_transfer_event definer by
 *      tests/test_batch49.py. The client never decides a transition; it
 *      mirrors the table so a card can explain its own state.
 *   3. Caps and fee (AMD-PAY-05) — the per-transfer cap, the rolling
 *      daily cap, the 100 bps fee and the launch currency are pinned
 *      constants, byte-identical to the edge copies.
 *   4. Eligibility mirror (AMD-PAY-06) — {@link planTransfer} mirrors
 *      the propose_transfer definer's refusals the client can know:
 *      amount, caps, both-sides-verified, open conversation. The
 *      suspension check is server-side only — the client never learns
 *      another user's suspension state (FR-30 discipline).
 *   5. Fee agreement — the card refuses a fee that does not equal
 *      {@link computeFeeMinor}(amount): the database computes the fee at
 *      proposal, and a disagreeing wire value is tampering, not data.
 *
 * Framework-free by design: no imports, so the unit tests run under
 * plain node --test.
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
 * Byte-identical to services/edge/src/transfers.ts.
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
 * category, never free text. Byte-identical to the edge copy.
 */
export const DISPUTE_REASONS = ["not-received", "wrong-amount", "unauthorised"] as const;

export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export function isDisputeReason(raw: unknown): raw is DisputeReason {
  return typeof raw === "string" && (DISPUTE_REASONS as readonly string[]).includes(raw);
}

/**
 * AMD-PAY-03: the whole card. Four fields, all structured. There is
 * deliberately no free-text field of any kind — a transfer card can
 * state an amount, a fee, a currency and a state, and nothing else.
 */
export interface TransferCard {
  amountMinor: number;
  feeMinor: number;
  currency: string;
  state: TransferState;
}

/** AMD-PAY-03: the pinned field set — a fifth field is a violation. */
export const TRANSFER_CARD_FIELDS = ["amountMinor", "feeMinor", "currency", "state"] as const;

/**
 * AMD-PAY-03/05: build a card from wire data, fail closed. The keys must
 * be exactly the pinned four (an extra field refuses — that is the
 * no-free-text guarantee enforced at the boundary), the amount a
 * positive integer within the per-transfer cap, the currency the launch
 * currency, the state a legal one, and the fee exactly what the
 * amendment formula computes for the amount.
 */
export function buildTransferCard(raw: unknown): TransferCard | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== TRANSFER_CARD_FIELDS.length) return null;
  for (const field of TRANSFER_CARD_FIELDS) {
    if (!keys.includes(field)) return null;
  }
  const { amountMinor, feeMinor, currency, state } = raw as {
    amountMinor: unknown;
    feeMinor: unknown;
    currency: unknown;
    state: unknown;
  };
  if (!Number.isInteger(amountMinor) || (amountMinor as number) <= 0) return null;
  if ((amountMinor as number) > MAX_TRANSFER_MINOR) return null;
  if (!Number.isInteger(feeMinor) || (feeMinor as number) < 0) return null;
  if (currency !== TRANSFER_CURRENCY) return null;
  if (!isTransferState(state)) return null;
  if (feeMinor !== computeFeeMinor(amountMinor as number)) return null;
  return {
    amountMinor: amountMinor as number,
    feeMinor: feeMinor as number,
    currency: TRANSFER_CURRENCY,
    state,
  };
}

/** What the client knows before proposing a transfer. */
export interface TransferPlan {
  amountMinor: number;
  /** The sender's money in motion over the rolling 24 h window. */
  dailySpentMinor: number;
  /** AMD-PAY-06: money moves only inside an OPEN conversation. */
  hasOpenConversation: boolean;
  selfKycVerified: boolean;
  counterpartKycVerified: boolean;
}

export type TransferDenial =
  | "invalid-input"
  | "over-transfer-cap"
  | "not-kyc-verified"
  | "no-open-conversation"
  | "over-daily-cap";

export type TransferVerdict = { allowed: true } | { allowed: false; reason: TransferDenial };

/**
 * AMD-PAY-05/06: decide a proposal before the wire, mirroring the
 * propose_transfer definer. The order of the refusals is pinned so the
 * UI can explain exactly one reason: garbage input, the per-transfer
 * cap, verification, the open conversation, then the daily cap. The
 * definer's suspension check has no client mirror — another user's
 * moderation state is not client knowledge (FR-30).
 */
export function planTransfer(plan: TransferPlan): TransferVerdict {
  if (
    plan === null ||
    typeof plan !== "object" ||
    !Number.isInteger(plan.amountMinor) ||
    plan.amountMinor <= 0 ||
    !Number.isFinite(plan.dailySpentMinor) ||
    plan.dailySpentMinor < 0 ||
    typeof plan.hasOpenConversation !== "boolean" ||
    typeof plan.selfKycVerified !== "boolean" ||
    typeof plan.counterpartKycVerified !== "boolean"
  ) {
    return { allowed: false, reason: "invalid-input" };
  }
  if (plan.amountMinor > MAX_TRANSFER_MINOR) {
    return { allowed: false, reason: "over-transfer-cap" };
  }
  if (!plan.selfKycVerified || !plan.counterpartKycVerified) {
    return { allowed: false, reason: "not-kyc-verified" };
  }
  if (!plan.hasOpenConversation) {
    return { allowed: false, reason: "no-open-conversation" };
  }
  if (plan.dailySpentMinor + plan.amountMinor > DAILY_TRANSFER_CAP_MINOR) {
    return { allowed: false, reason: "over-daily-cap" };
  }
  return { allowed: true };
}

/**
 * AMD-PAY-01: deterministic naira formatting — no Intl, so every client
 * renders the same string. Kobo group into thousands; the decimals are
 * always two. Unknown currencies fail closed to null.
 */
export function formatTransferAmount(amountMinor: unknown, currency: unknown): string | null {
  if (currency !== TRANSFER_CURRENCY) return null;
  if (!Number.isInteger(amountMinor) || (amountMinor as number) < 0) return null;
  const naira = Math.floor((amountMinor as number) / 100);
  const kobo = (amountMinor as number) % 100;
  const grouped = String(naira).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `₦${grouped}.${String(kobo).padStart(2, "0")}`;
}

/** The copy key a card state renders through (NFR-27 registry). */
export function copyKeyForTransferState(state: unknown): string | null {
  if (!isTransferState(state)) return null;
  return `ui.transfer.state.${state}`;
}

/**
 * The master guard the shell asserts: the transition table is exactly
 * the eight legal moves with known endpoints, the dispute vocabulary is
 * the closed three, the caps and fee are the amendment values, a card
 * builds only from the pinned four fields with the agreed fee, a garbage
 * or smuggled card refuses, the planner refuses with exactly one reason,
 * and the formatter is deterministic and currency-strict.
 */
export function transferHonoursAmendment(): boolean {
  if (TRANSFER_TRANSITIONS.length !== 8) return false;
  for (const [from, to] of TRANSFER_TRANSITIONS) {
    if (!isTransferState(from) || !isTransferState(to)) return false;
  }
  if (DISPUTE_REASONS.length !== 3) return false;
  if (
    MAX_TRANSFER_MINOR !== 5_000_000 ||
    DAILY_TRANSFER_CAP_MINOR !== 15_000_000 ||
    TRANSFER_FEE_BPS !== 100 ||
    TRANSFER_CURRENCY !== "NGN" ||
    TRANSFER_ACCEPT_WINDOW_MS !== 3_600_000
  ) {
    return false;
  }
  const valid = buildTransferCard({
    amountMinor: 1_250_000,
    feeMinor: 12_500,
    currency: "NGN",
    state: "proposed",
  });
  if (valid === null) return false;
  const keys = Object.keys(valid).sort();
  if (keys.join(",") !== ["amountMinor", "currency", "feeMinor", "state"].join(",")) {
    return false;
  }
  const basePlan: TransferPlan = {
    amountMinor: 1_250_000,
    dailySpentMinor: 0,
    hasOpenConversation: true,
    selfKycVerified: true,
    counterpartKycVerified: true,
  };
  return (
    buildTransferCard({
      amountMinor: 1_250_000,
      feeMinor: 12_500,
      currency: "NGN",
      state: "proposed",
      note: "pay me",
    }) === null &&
    buildTransferCard({ amountMinor: 1_250_000, feeMinor: 1, currency: "NGN", state: "proposed" }) ===
      null &&
    buildTransferCard({
      amountMinor: 5_000_001,
      feeMinor: 50_000,
      currency: "NGN",
      state: "proposed",
    }) === null &&
    isLegalTransferTransition("proposed", "accepted") === true &&
    isLegalTransferTransition("proposed", "settled") === false &&
    planTransfer(basePlan).allowed === true &&
    (() => {
      const denied = planTransfer({ ...basePlan, hasOpenConversation: false });
      return denied.allowed === false && denied.reason === "no-open-conversation";
    })() &&
    (() => {
      const denied = planTransfer({ ...basePlan, counterpartKycVerified: false });
      return denied.allowed === false && denied.reason === "not-kyc-verified";
    })() &&
    formatTransferAmount(1_250_000, "NGN") === "₦12,500.00" &&
    formatTransferAmount(1_250_000, "USD") === null &&
    copyKeyForTransferState("proposed") === "ui.transfer.state.proposed" &&
    copyKeyForTransferState("garbage") === null
  );
}
