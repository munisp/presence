/**
 * AMD-KYC-06..10: OpenKYC verification — client contract.
 *
 * The SQL migration (db/migrations/0038_openkyc.sql) is the source of
 * truth; services/edge/src/kycVerification.ts is the edge mirror;
 * services/openkyc/openkyc is the pipeline mirror; this module is the
 * client mirror. The batch-63 tests pin all four to the same actions,
 * the same windows, the same thresholds and the same session states.
 *
 * What lives here (framework-free, like every presence contract module):
 *
 *   1. The vocabulary mirrors — challenge actions, session states,
 *      verdict outcomes, credential kinds — so screens never free-type
 *      a wire word.
 *   2. The capture plan — capturePlan turns the issued challenge into
 *      the ordered on-device capture journey with per-action windows.
 *   3. The read-model parsers — parseSessionIssue, parseSessionStatus
 *      and parseReviewQueue validate strictly and fail closed.
 *   4. The state gates — sessionAction maps each session state to what
 *      the member may do next.
 *
 * Minimisation (AMD-KYC-02/10): the client uploads captures to the
 * OpenKYC service directly; the platform API only ever carries the
 * challenge, the token and the derived verdict.
 */

/** AMD-KYC-07: the five liveness actions — 3 are picked per session. */
export const CHALLENGE_ACTIONS = ["blink", "turn_left", "turn_right", "smile", "nod"] as const;
export type ChallengeAction = (typeof CHALLENGE_ACTIONS)[number];
export const CHALLENGE_COUNT = 3;
export const ACTION_WINDOW_MS = 4000;
export const SESSION_TTL_SECONDS = 600;

/** AMD-KYC-08: the session state machine. */
export const SESSION_STATES = ["issued", "review", "verified", "rejected", "expired"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** AMD-KYC-09: the pipeline verdicts. */
export const VERDICT_OUTCOMES = ["verified", "rejected", "review"] as const;

/** AMD-KYC-08: the neutral credential vocabulary. */
export const CREDENTIAL_KINDS = ["id_card", "driving_permit", "travel_document"] as const;

/** Pinned fusion thresholds — mirror the pipeline and the edge module. */
export const ACCEPT_MIN = 0.8;
export const REVIEW_FLOOR = 0.5;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ChallengeStep {
  action: ChallengeAction;
  windowMs: number;
}

export interface SessionIssue {
  sessionId: string;
  challenge: ChallengeStep[];
  challengeToken: string;
  expiresAt: number;
  uploadUrl: string;
}

export interface SessionStatus {
  sessionId: string;
  state: SessionState;
  issuedAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

function isChallengeStep(value: unknown): value is ChallengeStep {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.action === "string" &&
    (CHALLENGE_ACTIONS as readonly string[]).includes(step.action) &&
    typeof step.windowMs === "number" &&
    Number.isInteger(step.windowMs) &&
    step.windowMs >= 500 &&
    step.windowMs <= ACTION_WINDOW_MS
  );
}

/** Fail-closed: the issue response carries the full challenge set. */
export function parseSessionIssue(body: unknown): SessionIssue | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.sessionId !== "string" || !UUID_RE.test(b.sessionId)) return null;
  if (!Array.isArray(b.challenge) || b.challenge.length !== CHALLENGE_COUNT) return null;
  if (!b.challenge.every(isChallengeStep)) return null;
  const actions = (b.challenge as ChallengeStep[]).map((s) => s.action);
  if (new Set(actions).size !== CHALLENGE_COUNT) return null;
  if (typeof b.challengeToken !== "string" || !HEX64.test(b.challengeToken)) return null;
  if (typeof b.expiresAt !== "number" || !Number.isInteger(b.expiresAt)) return null;
  if (typeof b.uploadUrl !== "string" || b.uploadUrl.length < 1 || b.uploadUrl.length > 200) {
    return null;
  }
  return {
    sessionId: b.sessionId,
    challenge: b.challenge as ChallengeStep[],
    challengeToken: b.challengeToken,
    expiresAt: b.expiresAt,
    uploadUrl: b.uploadUrl,
  };
}

/** Fail-closed: the status read model — state and timestamps only. */
export function parseSessionStatus(body: unknown): SessionStatus | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const s = b.session;
  if (typeof s !== "object" || s === null || Array.isArray(s)) return null;
  const row = s as Record<string, unknown>;
  if (typeof row.sessionId !== "string" || !UUID_RE.test(row.sessionId)) return null;
  if (typeof row.state !== "string" || !(SESSION_STATES as readonly string[]).includes(row.state)) {
    return null;
  }
  if (typeof row.issuedAt !== "string" || typeof row.expiresAt !== "string") return null;
  if (row.decidedAt !== null && typeof row.decidedAt !== "string") return null;
  return {
    sessionId: row.sessionId,
    state: row.state as SessionState,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
  };
}

export interface CaptureStep {
  action: ChallengeAction;
  windowMs: number;
  copyKey: string;
}

/**
 * The ordered capture journey: one step per challenge action, each with
 * its window and its copy key. The member performs them in order; the
 * performed sequence — never a rearranged one — is what gets uploaded.
 */
export function capturePlan(challenge: ChallengeStep[]): CaptureStep[] {
  return challenge.map((step) => ({
    action: step.action,
    windowMs: step.windowMs,
    copyKey: `ui.kycCapture.action.${step.action}`,
  }));
}

export type SessionAction = "start-capture" | "wait" | "under-review" | "retry" | "none";

/** What the member may do next, per session state — the UI gate. */
export function sessionAction(state: SessionState): SessionAction {
  switch (state) {
    case "issued":
      return "start-capture";
    case "review":
      return "under-review";
    case "verified":
      return "none";
    case "rejected":
    case "expired":
      return "retry";
    default:
      return "wait";
  }
}
