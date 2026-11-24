/**
 * FR-83: haptic and non-visual feedback for consent transitions.
 *
 * Each consent transition MUST produce a distinct haptic signature, and
 * every state change MUST remain perceivable without haptics or sight of
 * the screen, using at least one non-visual channel.
 *
 * The transition set is the FR-29 state machine — DETECTED → NUDGED →
 * EXPRESSED → MUTUAL → OPEN, ported 1:1 in services/consent-go and
 * pinned here so a transition can never exist without feedback:
 *
 *   - {@link HAPTIC_SIGNATURES} assigns one vibration pattern to every
 *     legal transition. {@link hapticsAreDistinct} proves the patterns
 *     are pairwise different — a shared pattern would make two
 *     transitions indistinguishable by touch, which is precisely what
 *     the requirement forbids.
 *   - "Without haptics or sight" is the audio channel:
 *     {@link TRANSITION_ANNOUNCEMENTS} gives every transition a named
 *     audio cue AND a spoken label (screen-reader / voice announcement
 *     text), so a state change survives haptics-off, pocket, and
 *     eyes-free use. {@link audibleWithoutHaptics} refuses any
 *     transition missing either half.
 *
 * {@link transitionFeedback} is the single lookup the native layer
 * uses: unknown transitions return null (fail closed — no feedback is
 * better than wrong feedback for a consent event).
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test. No network, no platform APIs.
 */

/** FR-29: the consent states, mirrored from services/consent-go. */
export const CONSENT_STATES = [
  "DETECTED",
  "NUDGED",
  "EXPRESSED",
  "MUTUAL",
  "OPEN",
] as const;

export type ConsentState = (typeof CONSENT_STATES)[number];

/** One legal transition of the FR-29 machine. */
export interface ConsentTransition {
  from: ConsentState;
  to: ConsentState;
}

/**
 * FR-29: every legal transition — and only these. Cross-pinned to
 * ConsentTransitionOK in services/consent-go/statemachine.go; a sixth
 * transition cannot exist anywhere in the system.
 */
export const CONSENT_TRANSITIONS = [
  { from: "DETECTED", to: "NUDGED" },
  { from: "DETECTED", to: "EXPRESSED" },
  { from: "NUDGED", to: "EXPRESSED" },
  { from: "EXPRESSED", to: "MUTUAL" },
  { from: "MUTUAL", to: "OPEN" },
] as const satisfies readonly ConsentTransition[];

/** The key form of a transition, for lookups. */
export function transitionKey(transition: ConsentTransition): string {
  return `${transition.from}->${transition.to}`;
}

/**
 * A haptic signature: alternating on/off durations in milliseconds,
 * plus a stable label for logs and settings.
 */
export interface HapticSignature {
  label: string;
  pattern: readonly number[];
}

/**
 * FR-83: one distinct signature per consent transition. Patterns are
 * pairwise different by inspection and proven pairwise different by
 * {@link hapticsAreDistinct}; the invariant tests pin every entry.
 */
export const HAPTIC_SIGNATURES: Readonly<Record<string, HapticSignature>> = {
  "DETECTED->NUDGED": { label: "nudge", pattern: [30] },
  "DETECTED->EXPRESSED": { label: "wave-sent", pattern: [20, 40, 20] },
  "NUDGED->EXPRESSED": { label: "wave-back", pattern: [20, 40, 60] },
  "EXPRESSED->MUTUAL": { label: "mutual", pattern: [40, 60, 40, 60, 40] },
  "MUTUAL->OPEN": { label: "open", pattern: [80, 40, 160] },
} as const;

/**
 * The non-visual channel for one transition: a named audio cue (short
 * earcon) and the spoken announcement text. Both are mandatory — a
 * transition without either fails {@link audibleWithoutHaptics}.
 */
export interface TransitionAnnouncement {
  audioCue: string;
  spoken: string;
}

/**
 * FR-83: every transition announces itself in sound and words, so the
 * state change is perceivable with haptics off and the screen unseen.
 */
export const TRANSITION_ANNOUNCEMENTS: Readonly<
  Record<string, TransitionAnnouncement>
> = {
  "DETECTED->NUDGED": {
    audioCue: "nudge-plink",
    spoken: "Someone nearby shares one of your interests.",
  },
  "DETECTED->EXPRESSED": {
    audioCue: "wave-send",
    spoken: "Wave sent.",
  },
  "NUDGED->EXPRESSED": {
    audioCue: "wave-return",
    spoken: "Wave sent back.",
  },
  "EXPRESSED->MUTUAL": {
    audioCue: "mutual-chime",
    spoken: "It's mutual.",
  },
  "MUTUAL->OPEN": {
    audioCue: "open-bloom",
    spoken: "You're connected.",
  },
} as const;

/** The complete feedback bundle for one transition. */
export interface TransitionFeedback {
  haptic: HapticSignature;
  announcement: TransitionAnnouncement;
}

/**
 * Look up the feedback for a transition. Unknown or illegal transitions
 * return null — fail closed, never guess feedback for a consent event.
 */
export function transitionFeedback(
  transition: ConsentTransition,
): TransitionFeedback | null {
  const key = transitionKey(transition);
  const haptic = HAPTIC_SIGNATURES[key];
  const announcement = TRANSITION_ANNOUNCEMENTS[key];
  if (haptic === undefined || announcement === undefined) return null;
  return { haptic, announcement };
}

/**
 * FR-83 distinctness proof: every pair of haptic patterns differs in at
 * least one position or in length. Touch must never conflate two
 * consent transitions.
 */
export function hapticsAreDistinct(): boolean {
  const keys = CONSENT_TRANSITIONS.map(transitionKey);
  for (let a = 0; a < keys.length; a += 1) {
    for (let b = a + 1; b < keys.length; b += 1) {
      const first = HAPTIC_SIGNATURES[keys[a]].pattern;
      const second = HAPTIC_SIGNATURES[keys[b]].pattern;
      const sameLength = first.length === second.length;
      const sameEntries = first.every((value, index) => value === second[index]);
      if (sameLength && sameEntries) return false;
    }
  }
  return true;
}

/**
 * FR-83: the non-visual channel is present — every legal transition has
 * a named audio cue and non-empty spoken text.
 */
export function audibleWithoutHaptics(): boolean {
  return CONSENT_TRANSITIONS.every((transition) => {
    const announcement = TRANSITION_ANNOUNCEMENTS[transitionKey(transition)];
    return (
      announcement !== undefined &&
      announcement.audioCue.length > 0 &&
      announcement.spoken.length > 0
    );
  });
}

/**
 * FR-83 coverage proof: every legal transition resolves to a complete
 * feedback bundle — a distinct haptic AND the audio/spoken channel.
 */
export function everyTransitionHasFeedback(): boolean {
  return (
    CONSENT_TRANSITIONS.every(
      (transition) => transitionFeedback(transition) !== null,
    ) &&
    hapticsAreDistinct() &&
    audibleWithoutHaptics()
  );
}
