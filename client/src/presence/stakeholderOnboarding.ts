/**
 * AMD-ONB-01..06: stakeholder onboarding — client contract.
 *
 * The SQL migration (db/migrations/0037_onboarding.sql) is the source of
 * truth; services/edge/src/onboarding.ts is the edge mirror; this module is
 * the client mirror. The batch-62 tests pin all three to the same kinds,
 * the same statuses, the same payload bounds and the same stepper shape.
 *
 * What lives here (framework-free, like every presence contract module):
 *
 *   1. The vocabulary mirrors — kinds, statuses, outcomes — so screens
 *      never free-type a wire word.
 *   2. The payload builders — buildVenuePartnerPayload and
 *      buildProviderPayload validate exactly as the edge module and the SQL
 *      validator do; an invalid payload never becomes a request.
 *   3. The read-model parsers — parseApplicationList and
 *      parseOnboardingStatus validate strictly and fail closed.
 *   4. The stepper — onboardingSteps turns the status document into the
 *      ordered first-run journey with per-step state and copy keys.
 */

/** AMD-ONB-01: the two non-consumer stakeholder kinds. */
export const APPLICATION_KINDS = ["venue_partner", "provider"] as const;
export type ApplicationKind = (typeof APPLICATION_KINDS)[number];

/** AMD-ONB-01: the application state machine. */
export const APPLICATION_STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Pinned payload bounds — mirror the SQL validator and the edge module. */
export const VENUE_NAME_MAX = 80;
export const POLYGON_MIN_POINTS = 4;
export const POLYGON_MAX_POINTS = 64;
export const STATEMENT_MIN = 10;
export const STATEMENT_MAX = 500;
export const TERMS_VERSION_PATTERN = /^v[0-9]+\.[0-9]+$/;

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface VenueScheduleEntry {
  day: (typeof DAYS)[number];
  open: string;
  close: string;
}

export interface VenueSchedule {
  timezone?: string;
  weekly?: VenueScheduleEntry[];
}

export interface VenuePartnerPayload {
  name: string;
  polygon: Array<[number, number]>;
  schedule?: VenueSchedule;
  statement: string;
}

export interface ProviderPayload {
  termsVersion: string;
  statement: string;
}

function scheduleValid(s: VenueSchedule | undefined): boolean {
  if (s === undefined) return true;
  if (typeof s !== "object" || s === null || Array.isArray(s)) return false;
  if (s.timezone !== undefined && typeof s.timezone !== "string") return false;
  if (s.weekly === undefined) return true;
  if (!Array.isArray(s.weekly) || s.weekly.length > 21) return false;
  return s.weekly.every(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      (DAYS as readonly string[]).includes(e.day) &&
      TIME_PATTERN.test(e.open) &&
      TIME_PATTERN.test(e.close),
  );
}

/**
 * AMD-ONB-01: build a venue partner payload, or null when any field is out
 * of contract. The polygon is 4..64 [lon, lat] pairs inside valid ranges;
 * the ring may be open (the definer closes it).
 */
export function buildVenuePartnerPayload(input: {
  name: unknown;
  polygon: unknown;
  schedule?: VenueSchedule;
  statement: unknown;
}): VenuePartnerPayload | null {
  if (typeof input.name !== "string") return null;
  const name = input.name.trim();
  if (name.length < 2 || name.length > VENUE_NAME_MAX) return null;
  if (!Array.isArray(input.polygon)) return null;
  if (
    input.polygon.length < POLYGON_MIN_POINTS ||
    input.polygon.length > POLYGON_MAX_POINTS
  ) {
    return null;
  }
  const polygon: Array<[number, number]> = [];
  for (const pt of input.polygon) {
    if (!Array.isArray(pt) || pt.length !== 2) return null;
    const [lon, lat] = pt as unknown[];
    if (typeof lon !== "number" || typeof lat !== "number") return null;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    polygon.push([lon, lat]);
  }
  if (!scheduleValid(input.schedule)) return null;
  if (typeof input.statement !== "string") return null;
  const statement = input.statement.trim();
  if (statement.length < STATEMENT_MIN || statement.length > STATEMENT_MAX) return null;
  const out: VenuePartnerPayload = { name, polygon, statement };
  if (input.schedule !== undefined) out.schedule = input.schedule;
  return out;
}

/** AMD-ONB-01: build a provider payload, or null when out of contract. */
export function buildProviderPayload(input: {
  termsVersion: unknown;
  statement: unknown;
}): ProviderPayload | null {
  if (typeof input.termsVersion !== "string") return null;
  if (!TERMS_VERSION_PATTERN.test(input.termsVersion)) return null;
  if (typeof input.statement !== "string") return null;
  const statement = input.statement.trim();
  if (statement.length < STATEMENT_MIN || statement.length > STATEMENT_MAX) return null;
  return { termsVersion: input.termsVersion, statement };
}

// ----------------------------------------------------------- read models ---

export interface ApplicationRow {
  applicationId: string;
  kind: ApplicationKind;
  status: ApplicationStatus;
  requestedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Fail-closed parser for GET /v1/onboarding/applications/mine: a malformed
 * payload renders nothing rather than a half-truth.
 */
export function parseApplicationList(doc: unknown): ApplicationRow[] | null {
  if (!isRecord(doc) || !Array.isArray(doc.applications)) return null;
  const rows: ApplicationRow[] = [];
  for (const raw of doc.applications) {
    if (!isRecord(raw)) return null;
    if (typeof raw.applicationId !== "string" || !UUID_PATTERN.test(raw.applicationId)) {
      return null;
    }
    if (
      typeof raw.kind !== "string" ||
      !(APPLICATION_KINDS as readonly string[]).includes(raw.kind)
    ) {
      return null;
    }
    if (
      typeof raw.status !== "string" ||
      !(APPLICATION_STATUSES as readonly string[]).includes(raw.status)
    ) {
      return null;
    }
    if (typeof raw.requestedAt !== "string") return null;
    if (raw.decidedAt !== null && typeof raw.decidedAt !== "string") return null;
    if (raw.decisionReason !== null && typeof raw.decisionReason !== "string") return null;
    rows.push({
      applicationId: raw.applicationId,
      kind: raw.kind as ApplicationKind,
      status: raw.status as ApplicationStatus,
      requestedAt: raw.requestedAt,
      decidedAt: raw.decidedAt,
      decisionReason: raw.decisionReason,
    });
  }
  return rows;
}

export type KycState = "pending" | "verified" | "rejected" | "suspended";
const KYC_STATES: readonly KycState[] = ["pending", "verified", "rejected", "suspended"];

export interface OnboardingStatus {
  ageDeclared: boolean;
  kycState: KycState;
  kycReviewRequested: boolean;
  avatarSet: boolean;
  verticalsChosen: boolean;
  complete: boolean;
}

/** Fail-closed parser for GET /v1/account/onboarding. */
export function parseOnboardingStatus(doc: unknown): OnboardingStatus | null {
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
  if (typeof doc.kycState !== "string" || !KYC_STATES.includes(doc.kycState as KycState)) {
    return null;
  }
  return doc as unknown as OnboardingStatus;
}

// -------------------------------------------------------------- stepper ----

export type OnboardingStepId = "age" | "kyc" | "avatar" | "verticals";

export interface OnboardingStep {
  id: OnboardingStepId;
  /** done: the step is complete; ready: the next actionable step. */
  state: "done" | "ready" | "waiting" | "blocked";
  labelKey: string;
  /** Present when the step needs a note (e.g. KYC under review). */
  noteKey?: string;
}

/**
 * AMD-ONB-06: the ordered first-run journey. Exactly one step is `ready`
 * (the first incomplete step); steps after it are `waiting`. A rejected
 * KYC renders the step `blocked` with the re-request note; a requested
 * review renders it `ready` with the under-review note.
 */
export function onboardingSteps(status: OnboardingStatus): OnboardingStep[] {
  const steps: OnboardingStep[] = [
    { id: "age", state: status.ageDeclared ? "done" : "ready", labelKey: "ui.onboarding.step.age" },
    {
      id: "kyc",
      state: status.kycState === "verified" ? "done" : "waiting",
      labelKey: "ui.onboarding.step.kyc",
    },
    { id: "avatar", state: status.avatarSet ? "done" : "waiting", labelKey: "ui.onboarding.step.avatar" },
    {
      id: "verticals",
      state: status.verticalsChosen ? "done" : "waiting",
      labelKey: "ui.onboarding.step.verticals",
    },
  ];
  const kyc = steps[1];
  if (kyc.state !== "done") {
    if (status.kycState === "rejected") {
      kyc.state = "blocked";
      kyc.noteKey = "ui.onboarding.kyc.rejected";
    } else if (status.kycState === "suspended") {
      kyc.state = "blocked";
      kyc.noteKey = "ui.onboarding.kyc.suspended";
    } else if (status.kycReviewRequested) {
      kyc.noteKey = "ui.onboarding.kyc.under-review";
    }
  }
  const next = steps.find((s) => s.state !== "done");
  if (next && next.state === "waiting") next.state = "ready";
  return steps;
}
