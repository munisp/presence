/**
 * AMD-ONB-01..06: stakeholder onboarding — edge module.
 *
 * The SQL catalogue (db/migrations/0037_onboarding.sql) is the source of
 * truth; this module mirrors the vocabulary and the payload contracts so
 * the routes validate early and fail with the definer's own words.
 *
 *   APPLICATION_KINDS       the two non-consumer stakeholder kinds
 *   APPLICATION_STATUSES    the application state machine
 *   ONBOARDING_OUTCOMES     the definer outcome vocabulary
 *   parseApplicationBody    strict per-kind payload validation, mirroring
 *                           onboarding_payload_valid exactly
 *   parseStatusDoc          fail-closed parser for onboarding_status()
 */

/** AMD-ONB-01: the two non-consumer stakeholder kinds. */
export const APPLICATION_KINDS = ["venue_partner", "provider"] as const;
export type ApplicationKind = (typeof APPLICATION_KINDS)[number];

/** AMD-ONB-01: the application state machine. */
export const APPLICATION_STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** The definer outcome vocabulary the routes map onto status codes. */
export const SUBMIT_OUTCOMES = [
  "submitted",
  "already_open",
  "invalid_payload",
  "unknown_kind",
  "kyc_required",
  "forbidden",
] as const;

export const DECIDE_OUTCOMES = [
  "approved",
  "rejected",
  "illegal_decision",
  "unknown_application",
  "not_pending",
  "four_eyes",
  "reason_required",
  "forbidden",
] as const;

export const KYC_REQUEST_OUTCOMES = [
  "recorded",
  "already_requested",
  "not_requestable",
  "unknown_user",
  "forbidden",
] as const;

/** Pinned bounds — mirror the SQL validator exactly. */
export const VENUE_NAME_MAX = 80;
export const POLYGON_MIN_POINTS = 4;
export const POLYGON_MAX_POINTS = 64;
export const STATEMENT_MIN = 10;
export const STATEMENT_MAX = 500;
export const TERMS_VERSION_PATTERN = /^v[0-9]+\.[0-9]+$/;

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function keysWithin(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function scheduleValid(s: unknown): boolean {
  if (s === null || s === undefined) return true;
  if (!isRecord(s)) return false;
  if ("timezone" in s && typeof s.timezone !== "string") return false;
  if (s.weekly === undefined) return true;
  if (!Array.isArray(s.weekly)) return false;
  return s.weekly.every((e) => {
    if (!isRecord(e)) return false;
    return (
      typeof e.day === "string" &&
      (DAYS as readonly string[]).includes(e.day) &&
      typeof e.open === "string" &&
      TIME_PATTERN.test(e.open) &&
      typeof e.close === "string" &&
      TIME_PATTERN.test(e.close)
    );
  });
}

function polygonValid(p: unknown): boolean {
  if (!Array.isArray(p)) return false;
  if (p.length < POLYGON_MIN_POINTS || p.length > POLYGON_MAX_POINTS) return false;
  return p.every(
    (pt) =>
      Array.isArray(pt) &&
      pt.length === 2 &&
      typeof pt[0] === "number" &&
      typeof pt[1] === "number" &&
      pt[0] >= -180 &&
      pt[0] <= 180 &&
      pt[1] >= -90 &&
      pt[1] <= 90,
  );
}

export interface VenuePartnerPayload {
  name: string;
  polygon: Array<[number, number]>;
  schedule?: unknown;
  statement: string;
}

export interface ProviderPayload {
  termsVersion: string;
  statement: string;
}

export interface ApplicationBody {
  kind: ApplicationKind;
  payload: VenuePartnerPayload | ProviderPayload;
}

/**
 * Strict per-kind payload validation — mirrors onboarding_payload_valid in
 * the migration, so a body the route accepts is a body the definer accepts.
 * Returns null on any deviation (the route answers 422).
 */
export function parseApplicationBody(body: unknown): ApplicationBody | null {
  if (!isRecord(body)) return null;
  if (!keysWithin(body, ["kind", "payload"])) return null;
  const kind = body.kind;
  if (typeof kind !== "string" || !(APPLICATION_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  const appKind = kind as ApplicationKind;
  const payload = body.payload;
  if (!isRecord(payload)) return null;
  if (appKind === "venue_partner") {
    if (!keysWithin(payload, ["name", "polygon", "schedule", "statement"])) return null;
    if (typeof payload.name !== "string") return null;
    if (payload.name.length < 2 || payload.name.length > VENUE_NAME_MAX) return null;
    if (!polygonValid(payload.polygon)) return null;
    if (!scheduleValid(payload.schedule)) return null;
    if (typeof payload.statement !== "string") return null;
    if (payload.statement.length < STATEMENT_MIN || payload.statement.length > STATEMENT_MAX) {
      return null;
    }
    const out: VenuePartnerPayload = {
      name: payload.name,
      polygon: payload.polygon as Array<[number, number]>,
      statement: payload.statement,
    };
    if (payload.schedule !== undefined) out.schedule = payload.schedule;
    return { kind: appKind, payload: out };
  }
  // provider
  if (!keysWithin(payload, ["termsVersion", "statement"])) return null;
  if (typeof payload.termsVersion !== "string" || !TERMS_VERSION_PATTERN.test(payload.termsVersion)) {
    return null;
  }
  if (typeof payload.statement !== "string") return null;
  if (payload.statement.length < STATEMENT_MIN || payload.statement.length > STATEMENT_MAX) {
    return null;
  }
  const out: ProviderPayload = { termsVersion: payload.termsVersion, statement: payload.statement };
  return { kind: appKind, payload: out };
}

export interface OnboardingStatusDoc {
  ageDeclared: boolean;
  kycState: "pending" | "verified" | "rejected" | "suspended";
  kycReviewRequested: boolean;
  avatarSet: boolean;
  verticalsChosen: boolean;
  complete: boolean;
}

const KYC_STATES = ["pending", "verified", "rejected", "suspended"] as const;

/** Fail-closed parser for the onboarding_status() document. */
export function parseStatusDoc(doc: unknown): OnboardingStatusDoc | null {
  if (!isRecord(doc)) return null;
  if (
    typeof doc.ageDeclared !== "boolean" ||
    typeof doc.kycReviewRequested !== "boolean" ||
    typeof doc.avatarSet !== "boolean" ||
    typeof doc.verticalsChosen !== "boolean" ||
    typeof doc.complete !== "boolean"
  ) {
    return null;
  }
  if (typeof doc.kycState !== "string" || !(KYC_STATES as readonly string[]).includes(doc.kycState)) {
    return null;
  }
  return doc as unknown as OnboardingStatusDoc;
}
