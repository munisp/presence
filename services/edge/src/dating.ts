/**
 * Dating mode (SRS Addendum 001 — AMD-DATE-01..05).
 *
 * Pinned constants cross-checked against db/migrations/0031_dating.sql by
 * tests/test_batch57.py — a change here without a matching migration
 * change fails the suite.
 *
 * The dating profile is a structured, enumerated attribute set and nothing
 * else: no photo (FR-87 unchanged), no free text (FR-96/SEC-37 unchanged).
 * The vocabularies mirror the database-seeded tables; the edge validates
 * before the definer is even called, and the definer re-validates.
 */

/** AMD-DATE-02: the pinned gender vocabulary (mirror of dating_genders). */
export const DATING_GENDERS = ["female", "male", "nonbinary"] as const;
export type DatingGender = (typeof DATING_GENDERS)[number];
/** AMD-DATE-02: the pinned goal vocabulary (mirror of dating_goals). */
export const DATING_GOALS = ["long_term", "short_term", "friendship", "exploring"] as const;
export type DatingGoal = (typeof DATING_GOALS)[number];
/** AMD-DATE-01: age-range bounds — adults only, by construction. */
export const DATING_AGE_MIN = 18;
export const DATING_AGE_MAX = 99;
/** AMD-DATE-01: seeking names one to three genders. */
export const DATING_MAX_SEEKING = 3;
/** AMD-DATE-05: the profile pauses and resumes; nothing else. */
export const DATING_STATES = ["active", "paused"] as const;
export type DatingState = (typeof DATING_STATES)[number];

export interface DatingPreferences {
  gender: DatingGender;
  seeking: DatingGender[];
  goal: DatingGoal;
  ageMin: number;
  ageMax: number;
}

// ------------------------------------------------------- strict parsers ---

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

/** AMD-DATE-01: {gender, seeking, goal, ageMin, ageMax} only. */
export function parseDatingPreferencesBody(body: unknown): DatingPreferences | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 5) return null;
  const { gender, seeking, goal, ageMin, ageMax } = body;
  if (typeof gender !== "string" || !(DATING_GENDERS as readonly string[]).includes(gender)) {
    return null;
  }
  if (typeof goal !== "string" || !(DATING_GOALS as readonly string[]).includes(goal)) {
    return null;
  }
  if (!Array.isArray(seeking) || seeking.length < 1 || seeking.length > DATING_MAX_SEEKING) {
    return null;
  }
  if (seeking.some((s) => typeof s !== "string" || !(DATING_GENDERS as readonly string[]).includes(s))) {
    return null;
  }
  if (new Set(seeking).size !== seeking.length) return null;
  if (typeof ageMin !== "number" || !Number.isInteger(ageMin)
      || ageMin < DATING_AGE_MIN || ageMin > DATING_AGE_MAX) {
    return null;
  }
  if (typeof ageMax !== "number" || !Number.isInteger(ageMax)
      || ageMax < DATING_AGE_MIN || ageMax > DATING_AGE_MAX) {
    return null;
  }
  if (ageMax < ageMin) return null;
  return {
    gender: gender as DatingGender,
    seeking: seeking as DatingGender[],
    goal: goal as DatingGoal,
    ageMin,
    ageMax,
  };
}

/** AMD-DATE-05: {state: 'active' | 'paused'} only. */
export function parseDatingStateBody(body: unknown): { state: DatingState } | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1) return null;
  if (body.state !== "active" && body.state !== "paused") return null;
  return { state: body.state };
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** AMD-DATE-03/04: the peer query parameter — a uuid and nothing else. */
export function parseDatingPeerQuery(query: unknown): { peer: string } | null {
  if (!isRecord(query)) return null;
  const keys = Object.keys(query);
  if (keys.length !== 1 || typeof query.peer !== "string" || !UUID_RE.test(query.peer)) {
    return null;
  }
  return { peer: query.peer };
}
