/**
 * AMD-INN-07: on-device match preview. Before the user spends a scan or
 * opens an offer window, the client can answer "is this pair worth a
 * closer look?" locally — from the wire candidate the server already sent
 * plus the user's own declared interests. No new request, no new server
 * signal, nothing leaves the device.
 *
 * The preview is an estimate, clearly labelled as such: the server score
 * stays canonical. The bonus mirrors the engine's EXACT_OVERLAP_BONUS
 * (0.05 — TR-04 contract, services/match/src/engine.ts) and the possible
 * floor mirrors the FR-21 SUGGEST_THRESHOLD (0.12); tests cross-pin both.
 */

import { WireCandidate } from "./matchDiagram.js";

/** Mirror of the engine's exact-overlap bonus (TR-04). */
export const PREVIEW_SHARED_BONUS = 0.05;
/** Mirror of the FR-21 suggestion floor. */
export const PREVIEW_POSSIBLE_MIN = 0.12;
/** A preview at three times the floor reads as strong. */
export const PREVIEW_STRONG_MIN = 0.36;
/** The estimate never claims more than full certainty. */
export const PREVIEW_SCORE_CAP = 1.0;

export type PreviewVerdict = "strong" | "possible" | "weak";

export interface MatchPreview {
  /** Server score plus the local shared-interest bonus, capped. */
  estimate: number;
  verdict: PreviewVerdict;
  /** Own interests that appear among the candidate's scored reasons. */
  shared: string[];
}

export function previewVerdict(estimate: number): PreviewVerdict {
  if (estimate >= PREVIEW_STRONG_MIN) return "strong";
  if (estimate >= PREVIEW_POSSIBLE_MIN) return "possible";
  return "weak";
}

/**
 * Estimate the pair locally. ownInterests are the caller's declared
 * taxonomy node ids (already on the device for the pickers); a candidate
 * reason node the user ALSO declared earns one exact-overlap bonus each.
 */
export function previewScore(
  candidate: WireCandidate,
  ownInterests: readonly string[],
): MatchPreview {
  const own = new Set(ownInterests);
  const shared: string[] = [];
  for (const reason of candidate.reasons) {
    if (own.has(reason.node) && !shared.includes(reason.node)) {
      shared.push(reason.node);
    }
  }
  const estimate = Math.min(
    candidate.score + shared.length * PREVIEW_SHARED_BONUS,
    PREVIEW_SCORE_CAP,
  );
  return { estimate, verdict: previewVerdict(estimate), shared };
}
