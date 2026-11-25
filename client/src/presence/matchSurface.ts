/**
 * FR-76: the match surface — convergence, not identity.
 *
 * A match MUST be presented as the convergence of the two interest
 * paths on their shared node or nodes — showing what the users have in
 * common rather than who they are — rendered entirely from the reason
 * payload. The "rendered entirely from the reason payload" half is the
 * TR-35 contract in matchDiagram.ts: this module consumes ONLY the
 * MatchDiagram that buildMatchDiagram derived from one scan result, so
 * no data beyond the reason payload can reach the surface by
 * construction.
 *
 * The "commonality rather than identity" half is enforced two ways:
 *
 *   1. The descriptor is built with a fixed field set — headline and
 *      paths — that carries taxonomy labels only. There is no field a
 *      photo, name, or handle could occupy.
 *   2. {@link matchSurfaceViolations} scans the descriptor for the
 *      FR-87 registry (which bans a photo at the point of match) and
 *      for identity-shaped field keys, so the guarantee is asserted,
 *      not assumed.
 *
 * The descriptor's only affordance is "hold-to-wave": the FR-82
 * sustained-press gesture contract that ships with the interaction
 * batch. Dismissal is implicit (leaving the surface), so it needs no
 * affordance entry.
 *
 * Imports are pinned by tests/test_batch39.py: matchDiagram.js (the
 * diagram contract) and surfaceIntegrity.js (the prohibition registry).
 * No network, no platform APIs.
 */

import {
  type DiagramReasonKind,
  type MatchDiagram,
} from "./matchDiagram.js";
import {
  descriptorViolations,
  type SurfaceDescriptor,
} from "./surfaceIntegrity.js";

/**
 * FR-76/FR-87: identity-shaped field keys that MUST NOT appear on the
 * match surface. The descriptor never carries them by construction;
 * this list is what the guard scans for.
 *
 * SRS Addendum 001 (AMD-AVT-02): "avatar" is no longer on this list —
 * a curated registry symbol is not identity (never a photo, name, or
 * handle; AMD-AVT-01) and MAY serve as the pre-OPEN recognition anchor.
 * It still cannot ride inside this descriptor: the anchor reaches the
 * screen through buildMatchScreen's avatarLabel, supplied from the
 * pair_avatar contract — never from the reason payload.
 */
export const FORBIDDEN_MATCH_IDENTITY_FIELDS = [
  "photo",
  "photoUrl",
  "displayName",
  "handle",
  "fullName",
] as const;

/** The only affordance at the point of match (gesture contract: FR-82). */
export const MATCH_SURFACE_AFFORDANCES = ["hold-to-wave"] as const;

/** One converging path: how each side's declaration reached the shared node. */
export interface ConvergingPath {
  /** Shared taxonomy node id — the convergence point. */
  nodeId: string;
  /** Shared node label. */
  nodeLabel: string;
  /** Edge semantics: how the declarations reached the node. */
  via: DiagramReasonKind;
  /** The requester's declaring label (or the node label as fallback). */
  yoursLabel: string;
  /** The candidate's declaring label (or the node label as fallback). */
  theirsLabel: string;
}

/**
 * The match-surface presentation contract: a headline plus one
 * converging path per shared node. Field set is fixed — see the module
 * header for why that is the identity guarantee.
 */
export interface MatchSurface {
  kind: "match";
  /** Commonality headline — shared node labels only, never identity. */
  headline: string;
  /** One entry per shared node: the two paths converging on it. */
  paths: readonly ConvergingPath[];
  affordances: readonly ["hold-to-wave"];
}

/** FR-76: the headline names what the two users have in common. */
export function matchHeadline(sharedNodeLabels: readonly string[]): string {
  if (sharedNodeLabels.length === 0) return "Your paths cross here.";
  return `${sharedNodeLabels.join(" · ")} — what you have in common.`;
}

/**
 * Build the match surface from the TR-35 diagram — and only from the
 * diagram. The diagram itself is built from one scan result, so the
 * surface is rendered entirely from the reason payload, two steps
 * removed from the wire and zero steps from any other data source.
 */
export function buildMatchSurface(diagram: MatchDiagram): MatchSurface {
  const paths: ConvergingPath[] = diagram.nodes.map((node) => {
    const yours = diagram.edges.find(
      (edge) => edge.to === node.id && edge.role === "yours",
    );
    const theirs = diagram.edges.find(
      (edge) => edge.from === node.id && edge.role === "theirs",
    );
    return {
      nodeId: node.id,
      nodeLabel: node.label,
      via: node.kind,
      yoursLabel: yours !== undefined ? yours.label : node.label,
      theirsLabel: theirs !== undefined ? theirs.label : node.label,
    };
  });
  return {
    kind: "match",
    headline: matchHeadline(paths.map((path) => path.nodeLabel)),
    paths,
    affordances: MATCH_SURFACE_AFFORDANCES,
  };
}

/** The generic descriptor view of a match surface, for the FR-87 audit. */
export function matchSurfaceDescriptor(surface: MatchSurface): SurfaceDescriptor {
  return {
    kind: surface.kind,
    affordances: surface.affordances,
    fields: { headline: surface.headline, paths: surface.paths },
  };
}

/**
 * Audit a match surface: FR-87 registry violations plus any
 * identity-shaped field key. An empty result means the surface shows
 * what the users have in common — and nothing about who they are.
 */
export function matchSurfaceViolations(surface: MatchSurface): string[] {
  const violations = descriptorViolations(matchSurfaceDescriptor(surface));
  for (const key of Object.keys(matchSurfaceDescriptor(surface).fields)) {
    if ((FORBIDDEN_MATCH_IDENTITY_FIELDS as readonly string[]).includes(key)) {
      violations.push(key);
    }
  }
  return violations;
}

/**
 * The guard the surface asserts before rendering: commonality, not
 * identity — no registry violation and no identity field.
 */
export function showsCommonalityNotIdentity(surface: MatchSurface): boolean {
  return matchSurfaceViolations(surface).length === 0;
}
