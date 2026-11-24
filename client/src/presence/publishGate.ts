/**
 * FR-88: the platform location-accuracy grant is read before any publish.
 *
 * The SRS is absolute about this: "A presence published from a
 * reduced-accuracy fix is a defect, not a degraded experience." Where the
 * user has granted only approximate accuracy, the client MUST NOT publish
 * a cell, MUST state why in one sentence, and MUST offer venue check-in
 * as the alternative.
 *
 * Two accuracy gates guard a publish, and they live in two places:
 *  - the GRANT gate (this module): the platform authorization — iOS
 *    precise-vs-approximate, Android fine-vs-coarse. Unknown or
 *    unparseable grants fail CLOSED: when the device cannot prove the
 *    grant is precise, nothing publishes.
 *  - the FIX gate (cell.ts, TR-29): even with a precise grant, a single
 *    fix whose reported accuracy exceeds MAX_FIX_ACCURACY_M is refused
 *    by toPublishPayload returning null.
 *
 * The refusal affordance is pinned here so every surface renders the same
 * sentence and the same escape hatch — venue check-in (FR-99/FR-100
 * signed floor tokens, POST /v1/presence/checkin) needs no location grant
 * at all, which is exactly why the SRS names it as the alternative.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test without a React Native runtime.
 */

/** The platform's answer to "may this app see precise location?" */
export type LocationAccuracyGrant = "precise" | "approximate";

/**
 * The pinned one-sentence refusal (FR-88: "MUST state in one sentence
 * why"). Exactly one sentence — the unit tests count terminal punctuation
 * so a future edit cannot grow it into a paragraph.
 */
export const ACCURACY_REFUSAL_SENTENCE =
  "Presence needs precise location to place you with people nearby — turn on Precise Location, or check in with a venue code instead.";

/** FR-88: the alternative the refusal MUST offer. */
export const ACCURACY_REFUSAL_ALTERNATIVE = "venue-checkin" as const;

export type PublishGateDecision =
  | { readonly publish: true }
  | {
      readonly publish: false;
      readonly reason: "accuracy-grant";
      readonly sentence: typeof ACCURACY_REFUSAL_SENTENCE;
      readonly alternative: typeof ACCURACY_REFUSAL_ALTERNATIVE;
    };

/**
 * Evaluate the platform accuracy grant. Only an explicit "precise" grant
 * publishes; "approximate" and anything unparseable fail closed with the
 * pinned refusal. This function never throws — a platform that answers
 * garbage must not crash the journey, it must refuse the publish.
 */
export function evaluateAccuracyGrant(grant: unknown): PublishGateDecision {
  if (grant === "precise") return { publish: true };
  return {
    publish: false,
    reason: "accuracy-grant",
    sentence: ACCURACY_REFUSAL_SENTENCE,
    alternative: ACCURACY_REFUSAL_ALTERNATIVE,
  };
}

/**
 * Compile-time intent made runtime-explicit: the refusal carries exactly
 * one sentence and names venue check-in as the alternative. The unit
 * tests pin FR-88 through this guard.
 */
export function refusalHonoursFr88(decision: PublishGateDecision): boolean {
  if (decision.publish) return true;
  const sentences = decision.sentence.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  return sentences.length === 1 && decision.alternative === "venue-checkin";
}
