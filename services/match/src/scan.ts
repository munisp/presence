/**
 * Scan ranking (PRS-SRS-001 §6.3): turns scored pairs into the at-most-three
 * candidate list a scan may return.
 *
 *   FR-20  a scan returns at most three candidates, each with reasons
 *   FR-21  adaptive threshold: the (1 - 5/n)-quantile of the cell's pair
 *          score distribution, floored at the venue base threshold (TR-11);
 *          with five or fewer pairs the base threshold applies on its own
 *   FR-22  MMR diversification so the three slots are not three copies of
 *          the same interest cluster
 *   FR-25  proximity is reported as bands, never metres
 */

import { createHash } from "node:crypto";

import { Corpus, Matcher, MatchResult, Profile, SUGGEST_THRESHOLD } from "./engine.js";

export const MIN_CELL_POPULATION = 8; // FR-26: below this a scan returns the empty state
export const MAX_SCAN_RESULTS = 3;    // FR-20
export const MMR_LAMBDA = 0.7;        // relevance vs diversity trade-off (FR-22)

export type Band = "immediate" | "nearby" | "venue";

export interface ScanCandidate {
  userId: string;
  profile: Profile;
  /** H3 grid distance from the requester's cell: 0 same cell, 1 k-ring. */
  cellDistance: number;
}

export interface RankedCandidate {
  userId: string;
  score: number;
  band: Band;
  reasons: MatchResult["reasons"];
  icebreaker: string;
}

export interface VenueConfig {
  baseThreshold?: number;  // TR-11; floored at SUGGEST_THRESHOLD regardless
  maxResults?: number;     // FR-20, clamped to [1, 3]
}

/** FR-25: bands, not metres. Derived from H3 cell topology only. */
export function bandFor(cellDistance: number): Band {
  if (cellDistance <= 0) return "immediate";
  if (cellDistance === 1) return "nearby";
  return "venue";
}

/** Linear-interpolated quantile (numpy/default definition). */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * FR-21: threshold = max(venueBase, (1 - 5/n)-quantile of the pair score
 * distribution). n <= 5 pairs cannot support the quantile; base applies.
 */
export function adaptiveThreshold(scores: number[], base: number): number {
  const floor = Math.max(base, SUGGEST_THRESHOLD);
  const n = scores.length;
  if (n <= 5) return floor;
  const sorted = [...scores].sort((x, y) => x - y);
  return Math.max(floor, quantile(sorted, 1 - 5 / n));
}

/** Jaccard over the two matches' reason node sets — MMR diversity term. */
function reasonOverlap(a: MatchResult, b: MatchResult): number {
  const na = new Set(a.reasons.map((r) => r.node));
  const nb = new Set(b.reasons.map((r) => r.node));
  if (na.size === 0 && nb.size === 0) return 0;
  let inter = 0;
  for (const n of na) if (nb.has(n)) inter += 1;
  return inter / (na.size + nb.size - inter);
}

/**
 * FR-91/SEC-22 tie-break. Equal scores must not resolve to a stable ordering
 * (a deterministic order is grindable). With a per-scan seed the ordering
 * among ties is sha256(`${seed}:${userId}`) — deterministic inside one scan,
 * rotating across scans. Without a seed the legacy userId order applies
 * (tooling and tests stay reproducible).
 */
function tieCompare(a: string, b: string, seed?: number): number {
  if (seed === undefined) return a < b ? -1 : a > b ? 1 : 0;
  const ha = createHash("sha256").update(`${seed}:${a}`).digest("hex");
  const hb = createHash("sha256").update(`${seed}:${b}`).digest("hex");
  return ha < hb ? -1 : ha > hb ? 1 : 0;
}

/**
 * Rank a scan's candidate pool down to the final list (FR-20/21/22).
 * Candidates already filtered for consent state, suppression (FR-23) and
 * profile completeness (FR-11) arrive ready to score.
 */
export function rankScan(
  requester: Profile,
  candidates: ScanCandidate[],
  matcher: Matcher,
  corpus: Corpus,
  venue: VenueConfig = {},
  tieBreakSeed?: number,
): RankedCandidate[] {
  const scored = candidates.map((c) => ({
    candidate: c,
    match: matcher.score(requester, c.profile, corpus),
  }));
  const threshold = adaptiveThreshold(
    scored.map((s) => s.match.score),
    venue.baseThreshold ?? SUGGEST_THRESHOLD,
  );
  const eligible = scored
    .filter((s) => s.match.score >= threshold)
    .sort((x, y) =>
      y.match.score - x.match.score || tieCompare(x.candidate.userId, y.candidate.userId, tieBreakSeed));

  const maxResults = Math.min(Math.max(venue.maxResults ?? MAX_SCAN_RESULTS, 1), MAX_SCAN_RESULTS);

  // FR-22: maximal marginal relevance — pick the best remaining score net of
  // similarity to what is already in the list — with the spec's hard
  // guarantee on top: no two returned candidates share the same primary
  // reason (the top-contributing reason node). MMR stays the ordering; a
  // pick whose primary is already taken is skipped, and when the pool can no
  // longer offer a distinct primary the list ends short — FR-20's "at most
  // three" permits fewer, duplication does not.
  const chosen: typeof eligible = [];
  const pool = [...eligible];
  const usedPrimaries = new Set<string>();
  while (chosen.length < maxResults && pool.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const primary = pool[i].match.reasons[0]?.node;
      if (primary !== undefined && usedPrimaries.has(primary)) continue;
      const redundancy = chosen.length === 0
        ? 0
        : Math.max(...chosen.map((c) => reasonOverlap(c.match, pool[i].match)));
      const mmr = MMR_LAMBDA * pool[i].match.score - (1 - MMR_LAMBDA) * redundancy;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // no distinct primary left in the pool
    const pick = pool.splice(bestIdx, 1)[0];
    const primary = pick.match.reasons[0]?.node;
    if (primary !== undefined) usedPrimaries.add(primary);
    chosen.push(pick);
  }

  return chosen.map(({ candidate, match }) => ({
    userId: candidate.userId,
    score: match.score,
    band: bandFor(candidate.cellDistance),
    reasons: match.reasons.slice(0, 3),
    icebreaker: match.reasons.length ? renderTop(match) : "",
  }));
}

function renderTop(match: MatchResult): string {
  const r = match.reasons[0];
  switch (r.kind) {
    case "same": return `Both into ${r.label}`;
    case "related": return `${r.yoursLabel} and ${r.theirsLabel} are neighbours`;
    case "sibling": return `Both follow ${r.label}: ${r.yoursLabel} vs ${r.theirsLabel}`;
    default: return `Both into ${r.label}: ${r.yoursLabel} and ${r.theirsLabel}`;
  }
}
