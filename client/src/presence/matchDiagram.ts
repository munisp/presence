/**
 * TR-35: the versioned match-surface diagram spec.
 *
 * The match surface (PresenceHalo, FR-76) MUST be renderable from the
 * reason payload alone — no additional server round trip — and the
 * diagram specification MUST be versioned with the API so client and
 * server agree on node and edge semantics.
 *
 * This module is the client half of that contract:
 *
 *   - DIAGRAM_SPEC_VERSION mirrors services/edge/src/diagramSpec.ts (the
 *     equality is pinned by tests/test_batch36.py). The edge stamps the
 *     version on every scan result; a version this build does not know
 *     is an unsupported-version signal and routes to the TR-27 update
 *     prompt (see versioning.ts) rather than a guessed render.
 *   - buildMatchDiagram derives the ENTIRE diagram from one scan result:
 *     pairId/sessionId/score/band/reasons/icebreaker. Nothing else is
 *     fetched — this module contains no network code (import-free,
 *     pinned by tests/test_batch36.py).
 *
 * Diagram semantics, spec version 1:
 *   - Two anchors: "you" (the requester) and "them" (the candidate).
 *   - One node per reason: the shared taxonomy node, carrying its label,
 *     its reason kind, and its NORMALISED share of the total
 *     contribution (the halo's arc length — sums to 1 across nodes).
 *   - Two edges per reason: you→node labelled with yoursLabel, and
 *     node→them labelled with theirsLabel. The `via` field carries the
 *     reason kind so the renderer can style same/link/sibling/ancestor
 *     reaches differently without re-deriving them.
 *   - A reason with a null declarer (yours/theirs) still renders: its
 *     edge carries the fallback label of the shared node itself. Dropping
 *     the edge would silently change the picture the server scored.
 */

/** TR-35: this build renders spec version 1 (mirror of the edge). */
export const DIAGRAM_SPEC_VERSION = 1;

export type DiagramReasonKind = "same" | "related" | "sibling" | "ancestor";

/** The wire reason shape, mirror of services/match/src/engine.ts. */
export interface WireReason {
  kind: DiagramReasonKind;
  node: string;
  label: string;
  contribution: number;
  yours: string | null;
  theirs: string | null;
  yoursLabel: string;
  theirsLabel: string;
}

/** The scan-result wire shape the diagram is built from (TR-35). */
export interface WireCandidate {
  pairId: string;
  sessionId: string;
  score: number;
  band: string;
  reasons: WireReason[];
  icebreaker: string;
  /** Stamped by the edge; absence means a pre-TR-35 server (spec 0). */
  diagramSpec?: number;
}

export interface DiagramNode {
  /** Taxonomy node id — stable key for the renderer. */
  id: string;
  label: string;
  kind: DiagramReasonKind;
  /** contribution / Σ contributions; 0 when the reason list is empty. */
  share: number;
}

export interface DiagramEdge {
  from: "you" | string;
  to: string | "them";
  /** Whose declaration reached the shared node. */
  role: "yours" | "theirs";
  /** The declaring label (or the shared node's label as fallback). */
  label: string;
  /** Edge semantics: how the declaration reached the shared node. */
  via: DiagramReasonKind;
}

export interface MatchDiagram {
  specVersion: number;
  anchors: readonly ["you", "them"];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export type DiagramBuild =
  | { ok: true; diagram: MatchDiagram }
  | { ok: false; reason: "unsupported-spec"; specVersion: number }
  | { ok: false; reason: "incomplete-payload"; detail: string };

const REASON_KINDS: readonly DiagramReasonKind[] = ["same", "related", "sibling", "ancestor"];

function isWireReason(r: unknown): r is WireReason {
  if (r === null || typeof r !== "object") return false;
  const w = r as Record<string, unknown>;
  return (
    typeof w.kind === "string" &&
    (REASON_KINDS as readonly string[]).includes(w.kind) &&
    typeof w.node === "string" &&
    typeof w.label === "string" &&
    typeof w.contribution === "number" &&
    (w.yours === null || typeof w.yours === "string") &&
    (w.theirs === null || typeof w.theirs === "string") &&
    typeof w.yoursLabel === "string" &&
    typeof w.theirsLabel === "string"
  );
}

/**
 * Build the match-surface diagram from one scan result — and ONLY from
 * the scan result (TR-35's no-additional-round-trip clause).
 */
export function buildMatchDiagram(candidate: WireCandidate): DiagramBuild {
  const spec = typeof candidate.diagramSpec === "number" ? candidate.diagramSpec : 0;
  if (spec !== DIAGRAM_SPEC_VERSION) {
    return { ok: false, reason: "unsupported-spec", specVersion: spec };
  }
  if (!Array.isArray(candidate.reasons)) {
    return { ok: false, reason: "incomplete-payload", detail: "reasons is not an array" };
  }
  for (const r of candidate.reasons) {
    if (!isWireReason(r)) {
      return { ok: false, reason: "incomplete-payload", detail: "a reason is missing wire fields" };
    }
  }
  const total = candidate.reasons.reduce((s, r) => s + Math.max(0, r.contribution), 0);
  const nodes: DiagramNode[] = candidate.reasons.map((r) => ({
    id: r.node,
    label: r.label,
    kind: r.kind,
    share: total > 0 ? Math.max(0, r.contribution) / total : 0,
  }));
  const edges: DiagramEdge[] = [];
  for (const r of candidate.reasons) {
    edges.push({
      from: "you",
      to: r.node,
      role: "yours",
      label: r.yours !== null ? r.yoursLabel : r.label,
      via: r.kind,
    });
    edges.push({
      from: r.node,
      to: "them",
      role: "theirs",
      label: r.theirs !== null ? r.theirsLabel : r.label,
      via: r.kind,
    });
  }
  return {
    ok: true,
    diagram: { specVersion: spec, anchors: ["you", "them"], nodes, edges },
  };
}

/**
 * The TR-35 guard a surface asserts before rendering: the diagram is
 * derivable from the payload ALONE. True iff the build succeeds — the
 * module's import-free purity (pinned by test) is the no-round-trip half.
 */
export function renderableFromPayloadAlone(candidate: WireCandidate): boolean {
  return buildMatchDiagram(candidate).ok;
}
