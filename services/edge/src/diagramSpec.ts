/**
 * TR-35: the versioned match-surface diagram spec — server half.
 *
 * The match surface must be renderable from the reason payload alone,
 * and the diagram specification must be VERSIONED WITH THE API so that
 * client and server agree on node and edge semantics. The version is
 * therefore stamped on every scan result (routes/scan.ts): a client
 * that does not know the stamped version refuses to guess and routes to
 * the TR-27 update prompt instead of rendering silently wrong semantics.
 *
 * Bump this constant only together with a client release that renders
 * the new semantics, and keep this comment as the normative definition.
 *
 * Spec version 1 (client/src/presence/matchDiagram.ts renders exactly
 * this):
 *   - Anchors: "you" (requester) and "them" (candidate).
 *   - Nodes: one per reason — the shared taxonomy node with its label,
 *     reason kind and contribution share.
 *   - Edges: two per reason — you→node labelled yoursLabel, node→them
 *     labelled theirsLabel; the reason kind carries the reach semantics
 *     (same | related | sibling | ancestor).
 */

/** The diagram spec this edge stamps on scan results. */
export const DIAGRAM_SPEC_VERSION = 1;
