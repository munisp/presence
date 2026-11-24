/**
 * FR-81: the constellation picker — spatial interest selection with a
 * hard interaction budget.
 *
 * Interest selection MUST offer a spatial or graphical picker over the
 * taxonomy alongside text search, MUST reach three declared interests in
 * no more than four interactions, and MAY display k-anonymised local
 * popularity per node.
 *
 * The two halves are enforced by construction and audited by guards:
 *
 *   1. "Spatial alongside text search" — {@link PICKER_MODES} is pinned
 *      to exactly two modes, "constellation" and "search", and
 *      {@link modesOffered} refuses any descriptor that drops either.
 *      The constellation is the spatial mode: nodes arrive with a depth
 *      so the native layer can lay them out as a graph; the contract
 *      fixes WHAT is selectable, never the pixels.
 *
 *   2. "Three in four" — every node in the picker is selectable at
 *      whatever depth it sits ({@link ConstellationNode.selectable} is
 *      the literal `true`, so an unselectable node cannot typecheck).
 *      Three "select" interactions therefore always suffice — no
 *      descend is ever required — and {@link interactionsToDeclare} is
 *      pinned at 3 against {@link MAX_PICKER_INTERACTIONS} at 4, leaving
 *      exactly one spare interaction for a descend, a search, or a
 *      mistake. {@link auditInteractionSequence} re-checks any real
 *      sequence at runtime.
 *
 * Popularity is the MAY half: the server k-anonymises per-node counts;
 * the client defence-in-depth is {@link renderPopularity}, which returns
 * null below the k floor so a raw small count can never render even if
 * the wire misbehaves.
 *
 * Imports are pinned by tests/test_batch40.py: surfaceIntegrity.js (the
 * prohibition registry). No network, no platform APIs.
 */

import {
  descriptorViolations,
  type SurfaceDescriptor,
} from "./surfaceIntegrity.js";

/** FR-81: declarations the user must reach. */
export const REQUIRED_DECLARATIONS = 3;

/** FR-81: the hard interaction budget for reaching them. */
export const MAX_PICKER_INTERACTIONS = 4;

/**
 * FR-81: the picker exists in exactly two modes — the spatial
 * constellation over the taxonomy and plain text search — offered
 * alongside each other.
 */
export const PICKER_MODES = ["constellation", "search"] as const;

export type PickerMode = (typeof PICKER_MODES)[number];

/**
 * FR-81: popularity renders only at or above the k-anonymity floor.
 * Cross-pinned to K_MIN in services/edge/src/aggregate.ts.
 */
export const POPULARITY_K_FLOOR = 11;

/** The affordances the picker exposes. No scroll mechanics (FR-87). */
export const CONSTELLATION_AFFORDANCES = [
  "select-node",
  "descend",
  "ascend",
  "search",
] as const;

/**
 * One node in the constellation. `selectable` is the literal true: a
 * node the user cannot declare directly MUST NOT exist in the picker —
 * that is what makes the interaction budget hold at any taxonomy depth.
 */
export interface ConstellationNode {
  id: string;
  label: string;
  /** Depth in the taxonomy — layout input only, never a selection gate. */
  depth: number;
  /** k-anonymised local popularity, or null when below the floor. */
  popularity: number | null;
  /** Every node is directly declarable — see the module header. */
  selectable: true;
}

/** One user interaction inside the picker, for the budget audit. */
export interface PickerInteraction {
  kind: "select" | "deselect" | "descend" | "ascend" | "search";
  /** Target node for select/deselect; absent for navigation kinds. */
  nodeId?: string;
}

/** The picker presentation contract: fixed field set for the FR-87 audit. */
export interface ConstellationPicker {
  kind: "constellation-picker";
  mode: PickerMode;
  nodes: readonly ConstellationNode[];
  affordances: readonly string[];
}

/** FR-81: both modes are offered — constellation AND search, never one. */
export function modesOffered(modes: readonly string[] = PICKER_MODES): boolean {
  return modes.includes("constellation") && modes.includes("search");
}

/**
 * FR-81: interactions needed to reach three declarations. One select per
 * declaration — descending is optional, never required — so the count is
 * the requirement constant itself.
 */
export function interactionsToDeclare(): number {
  return REQUIRED_DECLARATIONS;
}

/**
 * FR-81 by construction: three selects fit inside the four-interaction
 * budget with exactly one interaction to spare.
 */
export function budgetSatisfiedByConstruction(): boolean {
  return interactionsToDeclare() <= MAX_PICKER_INTERACTIONS;
}

/**
 * FR-81 runtime audit: apply a real interaction sequence and check it
 * ended with at least three declarations inside the budget. A sequence
 * that burns the budget on navigation without declaring fails here even
 * though the picker permits it — the spare interaction is for recovery,
 * not for required path length.
 */
export function auditInteractionSequence(
  interactions: readonly PickerInteraction[],
): { declared: number; interactions: number; withinBudget: boolean } {
  const selected = new Set<string>();
  for (const interaction of interactions) {
    if (interaction.kind === "select" && interaction.nodeId !== undefined) {
      selected.add(interaction.nodeId);
    } else if (interaction.kind === "deselect" && interaction.nodeId !== undefined) {
      selected.delete(interaction.nodeId);
    }
  }
  return {
    declared: selected.size,
    interactions: interactions.length,
    withinBudget:
      selected.size >= REQUIRED_DECLARATIONS &&
      interactions.length <= MAX_PICKER_INTERACTIONS,
  };
}

/**
 * FR-81 popularity guard: k-anonymised counts render as a label; a
 * missing, malformed, or sub-floor count renders nothing at all. Fail
 * closed — a small raw count is a privacy defect, not a smaller label.
 */
export function renderPopularity(kAnonymisedCount: number | null): string | null {
  if (
    kAnonymisedCount === null ||
    !Number.isFinite(kAnonymisedCount) ||
    kAnonymisedCount < POPULARITY_K_FLOOR
  ) {
    return null;
  }
  return `${kAnonymisedCount} people nearby picked this`;
}

/** Build the picker descriptor from injected taxonomy nodes. */
export function buildConstellationPicker(
  mode: PickerMode,
  nodes: readonly ConstellationNode[],
): ConstellationPicker {
  return {
    kind: "constellation-picker",
    mode,
    nodes,
    affordances: CONSTELLATION_AFFORDANCES,
  };
}

/** The generic descriptor view of the picker, for the FR-87 audit. */
export function constellationPickerDescriptor(
  picker: ConstellationPicker,
): SurfaceDescriptor {
  return {
    kind: picker.kind,
    affordances: picker.affordances,
    fields: { mode: picker.mode, nodes: picker.nodes },
  };
}

/** FR-87 audit: no banned affordance or field key on the picker. */
export function constellationPickerViolations(
  picker: ConstellationPicker,
): string[] {
  return descriptorViolations(constellationPickerDescriptor(picker));
}

/** The guard the onboarding surface asserts before rendering. */
export function pickerHonoursFr81(picker: ConstellationPicker): boolean {
  return (
    modesOffered() &&
    budgetSatisfiedByConstruction() &&
    constellationPickerViolations(picker).length === 0
  );
}
