/**
 * FR-59/TR-20: taxonomy release operations — parsing, validation, and the
 * in-memory apply that publish runs inside its transaction.
 *
 * A release is an ordered list of governed operations. The set is
 * deliberately small and safe:
 *
 *   add_node      extend an existing path by one segment (TR-17 by
 *                 construction: parents must exist, re-parenting is not an
 *                 operation, so cycles are impossible)
 *   edit_label    re-label a node (embeddings re-sync on publish)
 *   set_sensitive flip the TR-22 flag (true also drops the embedding)
 *   deprecate     point a node at a live redirect target (no chains)
 *   add_link      authored semantic edge (TR-07 kinds)
 *   remove_link   drop one
 *
 * Node deletion is deliberately NOT an operation: history is deprecated,
 * never destroyed. Rollback restores snapshots instead.
 *
 * The pure functions here operate on a TaxonomyState map so publish can
 * validate and compute the whole delta before a single write, and so the
 * rules are unit-testable without a database.
 */

/** TR-17: the governed node kinds for CMS-created nodes. */
export const CMS_NODE_KINDS = ["domain", "category", "topic", "leaf"] as const;
export type CmsNodeKind = (typeof CMS_NODE_KINDS)[number];

/** TR-07: authored link kinds. */
export const LINK_KINDS = ["rivalry", "neighbour", "co_occurs"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const TAXONOMY_DEPTH_MAX = 5;
export const RELEASE_MESSAGE_MAX_LEN = 500;
export const RELEASE_OPS_MAX = 200;
export const NODE_LABEL_MAX_LEN = 80;

/** Lowercase dotted path; each segment is a slug. */
export const NODE_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;

export interface TaxonomyNode {
  nodeId: string;
  label: string;
  parentId: string | null;
  kind: string;
  sensitive: boolean;
  redirectTo: string | null;
  depth: number;
}

export interface TaxonomyLink {
  aId: string;
  bId: string;
  kind: LinkKind;
  weight: number;
}

export interface TaxonomyState {
  nodes: Map<string, TaxonomyNode>;
  links: Map<string, TaxonomyLink>; // key: `${aId}${bId}${kind}`
}

export function linkKey(l: Pick<TaxonomyLink, "aId" | "bId" | "kind">): string {
  return `${l.aId} ${l.bId} ${l.kind}`;
}

export type TaxonomyOp =
  | { type: "add_node"; nodeId: string; label: string; parentId: string; kind: CmsNodeKind; sensitive: boolean }
  | { type: "edit_label"; nodeId: string; label: string }
  | { type: "set_sensitive"; nodeId: string; sensitive: boolean }
  | { type: "deprecate"; nodeId: string; redirectTo: string }
  | { type: "add_link"; aId: string; bId: string; kind: LinkKind; weight: number }
  | { type: "remove_link"; aId: string; bId: string; kind: LinkKind };

export type OpParse = { ok: true; ops: TaxonomyOp[] } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function parseNodeId(v: unknown): string | null {
  return typeof v === "string" && NODE_ID_RE.test(v) && v.length <= 200 ? v : null;
}

function parseLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= NODE_LABEL_MAX_LEN ? t : null;
}

function parseOp(raw: unknown): TaxonomyOp | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "add_node": {
      const nodeId = parseNodeId(raw.nodeId);
      const label = parseLabel(raw.label);
      const parentId = parseNodeId(raw.parentId);
      const kind = raw.kind;
      const sensitive = raw.sensitive;
      if (!nodeId || !label || !parentId) return null;
      if (!(CMS_NODE_KINDS as readonly string[]).includes(kind as string)) return null;
      if (typeof sensitive !== "boolean") return null;
      // TR-17 by construction: the id must extend the parent's path.
      if (!nodeId.startsWith(`${parentId}.`)) return null;
      if (nodeId.slice(parentId.length + 1).includes(".")) return null; // exactly one segment deeper
      return { type: "add_node", nodeId, label, parentId, kind: kind as CmsNodeKind, sensitive };
    }
    case "edit_label": {
      const nodeId = parseNodeId(raw.nodeId);
      const label = parseLabel(raw.label);
      return nodeId && label ? { type: "edit_label", nodeId, label } : null;
    }
    case "set_sensitive": {
      const nodeId = parseNodeId(raw.nodeId);
      return nodeId && typeof raw.sensitive === "boolean"
        ? { type: "set_sensitive", nodeId, sensitive: raw.sensitive }
        : null;
    }
    case "deprecate": {
      const nodeId = parseNodeId(raw.nodeId);
      const redirectTo = parseNodeId(raw.redirectTo);
      if (!nodeId || !redirectTo || nodeId === redirectTo) return null;
      return { type: "deprecate", nodeId, redirectTo };
    }
    case "add_link": {
      const aId = parseNodeId(raw.aId);
      const bId = parseNodeId(raw.bId);
      const kind = raw.kind;
      const weight = raw.weight;
      if (!aId || !bId || aId === bId) return null;
      if (!(LINK_KINDS as readonly string[]).includes(kind as string)) return null;
      if (typeof weight !== "number" || !(weight > 0 && weight <= 1)) return null;
      return { type: "add_link", aId, bId, kind: kind as LinkKind, weight };
    }
    case "remove_link": {
      const aId = parseNodeId(raw.aId);
      const bId = parseNodeId(raw.bId);
      const kind = raw.kind;
      if (!aId || !bId || !(LINK_KINDS as readonly string[]).includes(kind as string)) return null;
      return { type: "remove_link", aId, bId, kind: kind as LinkKind };
    }
    default:
      return null;
  }
}

export function parseReleaseBody(body: unknown): { ok: true; message: string; ops: TaxonomyOp[] } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "body must be an object" };
  const message = body.message;
  if (typeof message !== "string" || message.trim().length === 0 || message.length > RELEASE_MESSAGE_MAX_LEN) {
    return { ok: false, error: `message must be 1-${RELEASE_MESSAGE_MAX_LEN} characters` };
  }
  if (!Array.isArray(body.ops) || body.ops.length === 0 || body.ops.length > RELEASE_OPS_MAX) {
    return { ok: false, error: `ops must be 1-${RELEASE_OPS_MAX} operations` };
  }
  const ops: TaxonomyOp[] = [];
  for (const raw of body.ops) {
    const op = parseOp(raw);
    if (op === null) return { ok: false, error: "invalid operation in ops" };
    ops.push(op);
  }
  return { ok: true, message: message.trim(), ops };
}

/** Apply ops against live state, validating every referential rule. Throws
 * Error with a user-safe message on the first violation. */
export function applyOps(state: TaxonomyState, ops: TaxonomyOp[]): void {
  for (const op of ops) {
    switch (op.type) {
      case "add_node": {
        if (state.nodes.has(op.nodeId)) throw new Error(`node already exists: ${op.nodeId}`);
        const parent = state.nodes.get(op.parentId);
        if (!parent) throw new Error(`parent not found: ${op.parentId}`);
        if (parent.redirectTo !== null) throw new Error(`parent is deprecated: ${op.parentId}`);
        const depth = parent.depth + 1;
        if (depth > TAXONOMY_DEPTH_MAX) throw new Error(`depth ${depth} exceeds ${TAXONOMY_DEPTH_MAX} (TR-17)`);
        state.nodes.set(op.nodeId, {
          nodeId: op.nodeId,
          label: op.label,
          parentId: op.parentId,
          kind: op.kind,
          sensitive: op.sensitive,
          redirectTo: null,
          depth,
        });
        break;
      }
      case "edit_label": {
        const node = state.nodes.get(op.nodeId);
        if (!node) throw new Error(`node not found: ${op.nodeId}`);
        node.label = op.label;
        break;
      }
      case "set_sensitive": {
        const node = state.nodes.get(op.nodeId);
        if (!node) throw new Error(`node not found: ${op.nodeId}`);
        node.sensitive = op.sensitive;
        break;
      }
      case "deprecate": {
        const node = state.nodes.get(op.nodeId);
        if (!node) throw new Error(`node not found: ${op.nodeId}`);
        const target = state.nodes.get(op.redirectTo);
        if (!target) throw new Error(`redirect target not found: ${op.redirectTo}`);
        if (target.redirectTo !== null) throw new Error("redirect chains are not allowed");
        node.redirectTo = op.redirectTo;
        break;
      }
      case "add_link": {
        if (!state.nodes.has(op.aId)) throw new Error(`node not found: ${op.aId}`);
        if (!state.nodes.has(op.bId)) throw new Error(`node not found: ${op.bId}`);
        const link: TaxonomyLink = { aId: op.aId, bId: op.bId, kind: op.kind, weight: op.weight };
        state.links.set(linkKey(link), link);
        break;
      }
      case "remove_link": {
        const key = linkKey(op);
        if (!state.links.has(key)) throw new Error(`link not found: ${op.aId} ${op.kind} ${op.bId}`);
        state.links.delete(key);
        break;
      }
    }
  }
}

/** TR-20: the diff summary recorded on the release at publish. */
export function diffSummary(ops: TaxonomyOp[]): Record<string, number> {
  const summary: Record<string, number> = {
    added: 0,
    relabelled: 0,
    sensitiveChanged: 0,
    deprecated: 0,
    linksAdded: 0,
    linksRemoved: 0,
    ops: ops.length,
  };
  for (const op of ops) {
    if (op.type === "add_node") summary.added++;
    else if (op.type === "edit_label") summary.relabelled++;
    else if (op.type === "set_sensitive") summary.sensitiveChanged++;
    else if (op.type === "deprecate") summary.deprecated++;
    else if (op.type === "add_link") summary.linksAdded++;
    else if (op.type === "remove_link") summary.linksRemoved++;
  }
  return summary;
}
