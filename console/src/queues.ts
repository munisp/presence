/**
 * AMD-CON-04 (unified worklist + actions): every pending workforce
 * decision — reports, appeals, KYC sessions and review requests,
 * onboarding applications, elevation requests — normalized into one
 * ordered model, with the action layer that drives the existing moderated
 * endpoints.
 *
 * The governed vocabulary (reason codes, outcomes, decisions) is mirrored
 * from services/edge/src/moderation.ts — the server remains the source of
 * truth and re-validates everything; the client-side guards exist so an
 * operator gets the refusal BEFORE the round trip, not after.
 */

import type { ConsoleApi } from "./consoleApi.js";

/** Mirrors MODERATION_REASON_CODES in services/edge/src/moderation.ts. */
export const REASON_CODES = [
  "spam",
  "harassment",
  "scam",
  "underage",
  "impersonation",
  "sexual_content",
  "hate",
  "other_policy",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Mirrors REPORT_OUTCOMES. */
export const REPORT_OUTCOMES = ["actioned", "dismissed"] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

/** Mirrors APPEAL_DECISIONS. */
export const APPEAL_DECISIONS = ["upheld", "overturned"] as const;
export type AppealDecision = (typeof APPEAL_DECISIONS)[number];

/** Mirrors SUSPENSION_DIMENSIONS. */
export const SUSPENSION_DIMENSIONS = ["attestation_key", "handle", "payment_instrument"] as const;
export type SuspensionDimension = (typeof SUSPENSION_DIMENSIONS)[number];

export type WorklistKind =
  | "report"
  | "appeal"
  | "kyc-session"
  | "kyc-review"
  | "onboarding"
  | "elevation";

export interface WorklistItem {
  kind: WorklistKind;
  id: string;
  /** Who the decision is about (reported user, applicant, requester). */
  subject: string;
  /** One-line why: report reason, credential kind, application kind… */
  summary: string;
  createdAtMs: number | null;
}

/**
 * Queue urgency: an appeal means a suspended member is waiting; reports
 * are live trust-and-safety; KYC and onboarding gate revenue-bearing
 * activation; elevation is internal hygiene.
 */
const KIND_PRIORITY: Record<WorklistKind, number> = {
  appeal: 0,
  report: 1,
  "kyc-review": 2,
  "kyc-session": 3,
  onboarding: 4,
  elevation: 5,
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function createdMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function list(json: unknown, key: string): Record<string, unknown>[] {
  const value = (json as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

export function normalizeReports(json: unknown): WorklistItem[] {
  return list(json, "queue").map((r) => ({
    kind: "report",
    id: text(r.reportId),
    subject: text(r.reported),
    summary: text(r.reason),
    createdAtMs: createdMs(r.createdAt),
  }));
}

export function normalizeAppeals(json: unknown): WorklistItem[] {
  return list(json, "appeals").map((a) => ({
    kind: "appeal",
    id: text(a.appealId),
    subject: text(a.userId),
    summary: text(a.body).slice(0, 120),
    createdAtMs: createdMs(a.createdAt),
  }));
}

export function normalizeKycSessions(json: unknown): WorklistItem[] {
  return list(json, "sessions").map((s) => ({
    kind: "kyc-session",
    id: text(s.sessionId),
    subject: text(s.applicant),
    summary: text(s.credentialKind),
    createdAtMs: createdMs(s.issuedAt),
  }));
}

export function normalizeKycReviews(json: unknown): WorklistItem[] {
  return list(json, "requests").map((r) => ({
    kind: "kyc-review",
    id: text(r.requestId ?? r.requestId ?? r.id),
    subject: text(r.applicant ?? r.userId),
    summary: text(r.status),
    createdAtMs: createdMs(r.requestedAt ?? r.createdAt),
  }));
}

export function normalizeOnboarding(json: unknown): WorklistItem[] {
  return list(json, "applications").map((a) => ({
    kind: "onboarding",
    id: text(a.applicationId),
    subject: text(a.applicant),
    summary: text(a.kind),
    createdAtMs: createdMs(a.submittedAt ?? a.createdAt),
  }));
}

export function normalizeElevation(json: unknown): WorklistItem[] {
  return list(json, "requests").map((r) => ({
    kind: "elevation",
    id: text(r.requestId),
    subject: text(r.subject),
    summary: text(r.justification).slice(0, 120),
    createdAtMs: createdMs(r.createdAt),
  }));
}

/**
 * Merge every queue into one worklist: kind priority first, then oldest
 * first within a kind (FIFO is the fair order for people in a queue),
 * undated items last.
 */
export function mergeWorklist(
  lists: Partial<Record<WorklistKind, WorklistItem[]>>,
): WorklistItem[] {
  const all = Object.values(lists).flatMap((items) => items ?? []);
  return all.sort((a, b) => {
    const byKind = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    if (byKind !== 0) return byKind;
    if (a.createdAtMs === null && b.createdAtMs === null) return 0;
    if (a.createdAtMs === null) return 1;
    if (b.createdAtMs === null) return -1;
    return a.createdAtMs - b.createdAtMs;
  });
}

// ------------------------------------------------------------- actions ----

function requireReasonCode(reasonCode: string): ReasonCode {
  if (!(REASON_CODES as readonly string[]).includes(reasonCode)) {
    throw new Error("a governed reason code is required");
  }
  return reasonCode as ReasonCode;
}

function requireNonEmpty(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${what} is required`);
  return trimmed;
}

export interface ResolveReportInput {
  outcome: ReportOutcome;
  reasonCode: string;
  suspension?: { dimension: SuspensionDimension };
  investigationRemove?: boolean;
}

/** POST /v1/moderation/reports/:reportId/resolve */
export async function resolveReport(
  api: ConsoleApi,
  reportId: string,
  input: ResolveReportInput,
): Promise<unknown> {
  if (!(REPORT_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw new Error("outcome must be actioned or dismissed");
  }
  return api.post(`/v1/moderation/reports/${reportId}/resolve`, {
    outcome: input.outcome,
    reasonCode: requireReasonCode(input.reasonCode),
    ...(input.suspension ? { suspension: input.suspension } : {}),
    ...(input.investigationRemove ? { investigationRemove: true } : {}),
  });
}

/** POST /v1/moderation/appeals/:appealId/resolve */
export async function resolveAppeal(
  api: ConsoleApi,
  appealId: string,
  decision: AppealDecision,
  reasonCode: string,
  note?: string,
): Promise<unknown> {
  if (!(APPEAL_DECISIONS as readonly string[]).includes(decision)) {
    throw new Error("decision must be upheld or overturned");
  }
  return api.post(`/v1/moderation/appeals/${appealId}/resolve`, {
    decision,
    reasonCode: requireReasonCode(reasonCode),
    ...(note !== undefined ? { note: requireNonEmpty(note, "note") } : {}),
  });
}

/** POST /v1/moderation/onboarding/:applicationId/approve */
export async function approveOnboarding(api: ConsoleApi, applicationId: string): Promise<unknown> {
  return api.post(`/v1/moderation/onboarding/${applicationId}/approve`, {});
}

/** POST /v1/moderation/onboarding/:applicationId/reject — reason mandatory. */
export async function rejectOnboarding(
  api: ConsoleApi,
  applicationId: string,
  reason: string,
): Promise<unknown> {
  return api.post(`/v1/moderation/onboarding/${applicationId}/reject`, {
    reason: requireNonEmpty(reason, "rejection reason"),
  });
}

/** POST /v1/moderation/elevation/:requestId/approve */
export async function approveElevation(api: ConsoleApi, requestId: string): Promise<unknown> {
  return api.post(`/v1/moderation/elevation/${requestId}/approve`, {});
}

/** POST /v1/moderation/elevation/:requestId/reject */
export async function rejectElevation(api: ConsoleApi, requestId: string): Promise<unknown> {
  return api.post(`/v1/moderation/elevation/${requestId}/reject`, {});
}

/** POST /v1/moderation/elevation/:requestId/revoke */
export async function revokeElevation(api: ConsoleApi, requestId: string): Promise<unknown> {
  return api.post(`/v1/moderation/elevation/${requestId}/revoke`, {});
}
