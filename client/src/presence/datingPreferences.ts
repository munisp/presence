/**
 * AMD-DATE-01..05: dating preferences — client contract.
 *
 * The dating profile is a structured, enumerated attribute set: gender,
 * seeking, goal and an age range. There is no photo (FR-87 unchanged)
 * and no free text (FR-96/SEC-37 unchanged) — the wire shape has no field
 * that could carry either.
 *
 * The vocabularies and bounds mirror services/edge/src/dating.ts, which
 * mirrors the database-seeded tables in db/migrations/0031_dating.sql; the
 * client test cross-pins all three. Validation runs on-device before the
 * wire: a bad preference set never becomes a request.
 */

/** Mirror of the governed dating_genders vocabulary (AMD-DATE-02). */
export const DATING_GENDERS = ["female", "male", "nonbinary"] as const;
export type DatingGender = (typeof DATING_GENDERS)[number];
/** Mirror of the governed dating_goals vocabulary (AMD-DATE-02). */
export const DATING_GOALS = ["long_term", "short_term", "friendship", "exploring"] as const;
export type DatingGoal = (typeof DATING_GOALS)[number];
/** Adults only, by construction (SEC-17/BR-03). */
export const DATING_AGE_MIN = 18;
export const DATING_AGE_MAX = 99;
/** Seeking names one to three genders. */
export const DATING_MAX_SEEKING = 3;

export interface DatingPreferencesInput {
  gender: string;
  seeking: readonly string[];
  goal: string;
  ageMin: number;
  ageMax: number;
}

export type DatingPreferenceError =
  | "gender_unknown"
  | "seeking_empty"
  | "seeking_too_many"
  | "seeking_duplicate"
  | "seeking_unknown"
  | "goal_unknown"
  | "age_bounds"
  | "age_inverted";

/**
 * Validate a preference set exactly as the edge parser and the definer
 * will. Returns every problem, so the form can mark all of them at once;
 * an empty list means the set is wire-ready.
 */
export function validateDatingPreferences(
  input: DatingPreferencesInput,
): DatingPreferenceError[] {
  const errors: DatingPreferenceError[] = [];
  if (!(DATING_GENDERS as readonly string[]).includes(input.gender)) {
    errors.push("gender_unknown");
  }
  if (input.seeking.length < 1) {
    errors.push("seeking_empty");
  } else {
    if (input.seeking.length > DATING_MAX_SEEKING) errors.push("seeking_too_many");
    if (new Set(input.seeking).size !== input.seeking.length) {
      errors.push("seeking_duplicate");
    }
    if (input.seeking.some((s) => !(DATING_GENDERS as readonly string[]).includes(s))) {
      errors.push("seeking_unknown");
    }
  }
  if (!(DATING_GOALS as readonly string[]).includes(input.goal)) {
    errors.push("goal_unknown");
  }
  const ageInBounds = (a: number) =>
    Number.isInteger(a) && a >= DATING_AGE_MIN && a <= DATING_AGE_MAX;
  if (!ageInBounds(input.ageMin) || !ageInBounds(input.ageMax)) {
    errors.push("age_bounds");
  } else if (input.ageMax < input.ageMin) {
    errors.push("age_inverted");
  }
  return errors;
}

/** Build the POST /v1/dating/preferences body from a validated set. */
export function datingPreferencesToWire(input: DatingPreferencesInput): {
  gender: string;
  seeking: string[];
  goal: string;
  ageMin: number;
  ageMax: number;
} {
  return {
    gender: input.gender,
    seeking: [...input.seeking],
    goal: input.goal,
    ageMin: input.ageMin,
    ageMax: input.ageMax,
  };
}
