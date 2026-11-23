/**
 * FR-52/53/54/55/57: moderation vocabulary, caps, and parsers.
 *
 * The reason-code vocabulary lives here (not as a DB CHECK) so the edge and
 * the console share one source of truth and new codes do not need a
 * migration. The DB still constrains structural invariants — one active
 * suspension per (user, dimension), one open appeal per user — with partial
 * unique indexes.
 */

export const MODERATION_REASON_CODES = [
  "spam",
  "harassment",
  "scam",
  "underage",
  "impersonation",
  "sexual_content",
  "hate",
  "other_policy",
] as const;
export type ModerationReasonCode = (typeof MODERATION_REASON_CODES)[number];

export const SUSPENSION_DIMENSIONS = ["attestation_key", "handle", "payment_instrument"] as const;
export type SuspensionDimension = (typeof SUSPENSION_DIMENSIONS)[number];

export const REPORT_OUTCOMES = ["actioned", "dismissed"] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

export const APPEAL_DECISIONS = ["upheld", "overturned"] as const;
export type AppealDecision = (typeof APPEAL_DECISIONS)[number];

/** FR-57: a user may send at most this many nudges per rolling UTC day. */
export const NUDGE_DAILY_MAX = 3;

/** FR-53: appeal body bounds (screened like any other free text, SEC-26). */
export const APPEAL_BODY_MIN_LEN = 10;
export const APPEAL_BODY_MAX_LEN = 2000;

export function parseReasonCode(value: unknown): ModerationReasonCode | null {
  return typeof value === "string" && (MODERATION_REASON_CODES as readonly string[]).includes(value)
    ? (value as ModerationReasonCode)
    : null;
}

export function parseSuspensionDimension(value: unknown): SuspensionDimension | null {
  return typeof value === "string" && (SUSPENSION_DIMENSIONS as readonly string[]).includes(value)
    ? (value as SuspensionDimension)
    : null;
}

export function parseReportOutcome(value: unknown): ReportOutcome | null {
  return typeof value === "string" && (REPORT_OUTCOMES as readonly string[]).includes(value)
    ? (value as ReportOutcome)
    : null;
}

export function parseAppealDecision(value: unknown): AppealDecision | null {
  return typeof value === "string" && (APPEAL_DECISIONS as readonly string[]).includes(value)
    ? (value as AppealDecision)
    : null;
}

export interface ResolveReportBody {
  outcome: ReportOutcome;
  reasonCode: ModerationReasonCode;
  suspension?: { dimension: SuspensionDimension };
  investigationRemove?: boolean;
}

/**
 * Body for POST /v1/moderation/reports/:reportId/resolve. `suspension` is
 * optional; when present the report closes as actioned and the suspension is
 * created atomically (unique-index conflict → 409, one active per dimension).
 */
export function parseResolveReportBody(body: unknown): { ok: true; value: ResolveReportBody } | { ok: false } {
  if (body === null || typeof body !== "object") return { ok: false };
  const b = body as Record<string, unknown>;
  const outcome = parseReportOutcome(b.outcome);
  const reasonCode = parseReasonCode(b.reasonCode);
  if (!outcome || !reasonCode) return { ok: false };
  const value: ResolveReportBody = { outcome, reasonCode };
  if (b.suspension !== undefined) {
    if (b.suspension === null || typeof b.suspension !== "object") return { ok: false };
    const dimension = parseSuspensionDimension((b.suspension as Record<string, unknown>).dimension);
    if (!dimension) return { ok: false };
    value.suspension = { dimension };
  }
  if (b.investigationRemove !== undefined) {
    if (typeof b.investigationRemove !== "boolean") return { ok: false };
    value.investigationRemove = b.investigationRemove;
  }
  return { ok: true, value };
}

export function parseAppealBody(body: unknown): { ok: true; value: { body: string; suspensionId?: string } } | { ok: false } {
  if (body === null || typeof body !== "object") return { ok: false };
  const b = body as Record<string, unknown>;
  if (typeof b.body !== "string") return { ok: false };
  const trimmed = b.body.trim();
  if (trimmed.length < APPEAL_BODY_MIN_LEN || trimmed.length > APPEAL_BODY_MAX_LEN) return { ok: false };
  const value: { body: string; suspensionId?: string } = { body: trimmed };
  if (b.suspensionId !== undefined) {
    if (typeof b.suspensionId !== "string") return { ok: false };
    value.suspensionId = b.suspensionId;
  }
  return { ok: true, value };
}

export interface ResolveAppealBody {
  decision: AppealDecision;
  reasonCode: ModerationReasonCode;
  note?: string;
}

export function parseResolveAppealBody(body: unknown): { ok: true; value: ResolveAppealBody } | { ok: false } {
  if (body === null || typeof body !== "object") return { ok: false };
  const b = body as Record<string, unknown>;
  const decision = parseAppealDecision(b.decision);
  const reasonCode = parseReasonCode(b.reasonCode);
  if (!decision || !reasonCode) return { ok: false };
  const value: ResolveAppealBody = { decision, reasonCode };
  if (b.note !== undefined) {
    if (typeof b.note !== "string" || b.note.length > APPEAL_BODY_MAX_LEN) return { ok: false };
    value.note = b.note;
  }
  return { ok: true, value };
}
