/**
 * FR-80: one discovery skeleton for pairs, rooms, and tables.
 *
 * The three discovery modes MUST share one screen skeleton, differing
 * only in the content of the result region. A change of mode MUST be
 * explained in one sentence, once per user, and MUST NOT interrupt an
 * open conversation.
 *
 * This module is the skeleton contract:
 *
 *   - {@link skeletonFor} returns the same region list for every mode;
 *     only `resultContent` varies. {@link skeletonSharedAcrossModes} is
 *     the guard a renderer asserts when diffing two modes.
 *   - {@link MODE_EXPLANATIONS} holds the pinned one-sentence
 *     explanation per mode (the unit tests count terminal punctuation).
 *     The seen-set is persisted under the allowlisted
 *     `presence.ui.seenExplanations` key, so an explanation shows once
 *     per user per install; the TR-30 logout wipe clears it, failing
 *     toward explaining again rather than never explaining.
 *   - {@link planModeChange} refuses to switch while a conversation is
 *     open: the change is deferred, the conversation untouched.
 *
 * The result region renders one bounded scan payload — there is no
 * load-more affordance. The descriptor's affordance list is pinned and
 * audited against the FR-87 registry, which bans infinite and
 * auto-loading scroll.
 *
 * Imports are pinned by tests/test_batch39.py: localState.js (the
 * allowlisted seen-set key) and surfaceIntegrity.js (the prohibition
 * registry). No network, no platform APIs.
 */

import { type LocalStateKey } from "./localState.js";
import {
  honoursSurfaceProhibitions,
  type SurfaceDescriptor,
} from "./surfaceIntegrity.js";

/** The three discovery modes. */
export const DISCOVERY_MODES = ["pairs", "rooms", "tables"] as const;

export type DiscoveryMode = (typeof DISCOVERY_MODES)[number];

/**
 * FR-80: the one skeleton. Every mode renders exactly these regions in
 * this order; the modes differ only in what the result region shows.
 */
export const SKELETON_REGIONS = [
  "header",
  "modeSelector",
  "resultRegion",
  "statusTray",
] as const;

export type SkeletonRegion = (typeof SKELETON_REGIONS)[number];

/**
 * The skeleton for one mode. `regions` is always the full pinned list;
 * `resultContent` is the ONLY mode-dependent member.
 */
export interface ScreenSkeleton {
  regions: readonly SkeletonRegion[];
  resultContent: DiscoveryMode;
}

export function skeletonFor(mode: DiscoveryMode): ScreenSkeleton {
  return { regions: SKELETON_REGIONS, resultContent: mode };
}

/**
 * The FR-80 guard: two mode skeletons are the same screen iff their
 * region lists are identical — only the result content may differ.
 */
export function skeletonSharedAcrossModes(
  a: ScreenSkeleton,
  b: ScreenSkeleton,
): boolean {
  return a.regions.join("|") === b.regions.join("|");
}

/** FR-80: the pinned one-sentence explanation per mode. */
export const MODE_EXPLANATIONS: Record<DiscoveryMode, string> = {
  pairs: "Pairs shows one person nearby whose interests converge with yours, without telling you who they are yet.",
  rooms: "Rooms opens an opt-in board for everyone at this venue gathered around a shared topic.",
  tables: "Tables turns a planned meet-up here into a small scheduled gathering you can join.",
};

/** Exactly one sentence: one run of terminal punctuation, at the end. */
export function explanationIsOneSentence(text: string): boolean {
  const matches = text.match(/[.!?]+/g);
  return (
    matches !== null &&
    matches.length === 1 &&
    text.trimEnd().endsWith(matches[0])
  );
}

/** The allowlisted key the seen-set persists under (TR-30). */
export const SEEN_EXPLANATIONS_KEY: LocalStateKey =
  "presence.ui.seenExplanations";

/**
 * Parse the persisted seen-set. Anything malformed fails closed to
 * empty — fail toward explaining again, never toward never explaining.
 */
export function parseSeenExplanations(
  stored: string | null,
): DiscoveryMode[] {
  if (stored === null) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is DiscoveryMode =>
      (DISCOVERY_MODES as readonly string[]).includes(entry as string),
    );
  } catch {
    return [];
  }
}

/** Serialise the seen-set for the allowlisted key. */
export function formatSeenExplanations(seen: readonly DiscoveryMode[]): string {
  return JSON.stringify(seen);
}

/** FR-80: an explanation is due only for a mode the user has not seen. */
export function explanationDue(
  mode: DiscoveryMode,
  seen: readonly DiscoveryMode[],
): boolean {
  return !seen.includes(mode);
}

/** The outcome of a requested mode change. */
export type ModeChangePlan =
  | { action: "switch"; to: DiscoveryMode; explanation: string | null }
  | { action: "defer"; reason: "conversation-open" };

/**
 * Plan a mode change. While a conversation is open, switching to a
 * different mode is deferred — the explanation and the switch must not
 * interrupt the conversation. Re-selecting the current mode is a no-op
 * switch (no explanation re-shown unless still due).
 */
export function planModeChange(
  requested: DiscoveryMode,
  current: DiscoveryMode,
  conversationOpen: boolean,
  seen: readonly DiscoveryMode[],
): ModeChangePlan {
  if (conversationOpen && requested !== current) {
    return { action: "defer", reason: "conversation-open" };
  }
  return {
    action: "switch",
    to: requested,
    explanation: explanationDue(requested, seen)
      ? MODE_EXPLANATIONS[requested]
      : null,
  };
}

/**
 * The skeleton's affordances, pinned: switch mode, refresh the bounded
 * result set. There is deliberately no load-more affordance — the
 * result region renders one bounded scan payload, and the FR-87
 * registry bans infinite and auto-loading scroll.
 */
export const SKELETON_AFFORDANCES = ["mode-switch", "refresh"] as const;

/** The generic descriptor view of the skeleton, for the FR-87 audit. */
export function skeletonDescriptor(
  skeleton: ScreenSkeleton,
): SurfaceDescriptor {
  return {
    kind: "discovery-skeleton",
    affordances: SKELETON_AFFORDANCES,
    fields: {
      regions: skeleton.regions,
      resultContent: skeleton.resultContent,
    },
  };
}

/** The guard a renderer asserts: the skeleton carries no FR-87 violation. */
export function skeletonHonoursFr87(skeleton: ScreenSkeleton): boolean {
  return honoursSurfaceProhibitions(skeletonDescriptor(skeleton));
}
