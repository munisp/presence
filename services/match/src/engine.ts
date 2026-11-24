/**
 * The matching engine (PRS-SRS-001 §6.2) — TypeScript port of the verified
 * Python reference (presence/matching.py). The two implementations are pinned
 * to each other by test/golden.json (120 pairs, agreement to 1e-9), and the
 * Python side reproduces the ACC-10 answer key 653/653.
 *
 * Score contract:
 *
 *   sim(A,B) = sum_n idf(n) * wA(n) * wB(n) / (||vA|| * ||vB||)
 *
 * with an exact-overlap bonus of 5% per node declared by both profiles,
 * capped at 1.0.
 *
 *   TR-04  closure weights decay 0.55 per hop, max four hops; multiple
 *          declarations reaching one ancestor combine by max
 *   TR-05  document frequency over the live population, link-free closures
 *   TR-06  idf(n) = sqrt(ln(1 + N / (1 + df(n)))) — sqrt-compressed,
 *          log-smoothed, so one rare shared interest cannot dominate
 *   TR-07  semantic links contribute one hop at the authored weight and are
 *          excluded from document frequency
 *   TR-08  ordered reason list with node ids, labels and contributions
 *   TR-09  reason text is deterministic; no LLM
 *   TR-10  scoring is deterministic for identical inputs and corpus state
 */

export const DECAY = 0.55; // TR-04
export const EXPANSION_DEPTH = 4; // TR-04
export const MAX_DEPTH = 5; // TR-17
export const EXACT_OVERLAP_BONUS = 0.05;
export const SUGGEST_THRESHOLD = 0.12; // FR-21 floor

export interface GraphNode {
  nid: string;
  label: string;
  parent: string | null;
  kind: string;
  sensitive: boolean;
}

export interface GraphLink {
  a: string;
  b: string;
  kind: string; // rivalry | neighbour | co_occurs
  weight: number;
}

export type Profile = Record<string, number>;

export class InterestGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly links = new Map<string, Array<[string, GraphLink]>>();
  private readonly depthCache = new Map<string, number>();

  constructor(nodes: GraphNode[], links: GraphLink[] = []) {
    for (const n of nodes) this.nodes.set(n.nid, n);
    for (const link of links) {
      for (const nid of [link.a, link.b]) {
        if (!this.nodes.has(nid)) throw new Error(`link references unknown node ${nid}`);
      }
      this.pushLink(link.a, [link.b, link]);
      this.pushLink(link.b, [link.a, link]);
    }
    this.validate();
  }

  private pushLink(from: string, entry: [string, GraphLink]): void {
    const list = this.links.get(from) ?? [];
    list.push(entry);
    this.links.set(from, list);
  }

  private validate(): void {
    for (const [nid, node] of this.nodes) {
      if (node.parent !== null && !this.nodes.has(node.parent)) {
        throw new Error(`${nid} has unknown parent ${node.parent}`);
      }
    }
    for (const nid of this.nodes.keys()) {
      const seen = new Set<string>();
      let depth = 0;
      let cur = nid;
      while (this.nodes.get(cur)!.parent !== null) {
        if (seen.has(cur)) throw new Error(`cycle through ${nid}`);
        seen.add(cur);
        depth += 1;
        cur = this.nodes.get(cur)!.parent!;
      }
      if (depth > MAX_DEPTH) throw new Error(`${nid} exceeds hierarchy depth ${MAX_DEPTH}`);
    }
  }

  get(nid: string): GraphNode {
    const n = this.nodes.get(nid);
    if (!n) throw new Error(`unknown node ${nid}`);
    return n;
  }

  has(nid: string): boolean {
    return this.nodes.has(nid);
  }

  allNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  /** (ancestorNid, hops) walking up the hierarchy, self excluded. */
  ancestors(nid: string, maxDepth: number = EXPANSION_DEPTH): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    let cur = nid;
    let hops = 0;
    while (this.nodes.get(cur)!.parent !== null && hops < maxDepth) {
      cur = this.nodes.get(cur)!.parent!;
      hops += 1;
      out.push([cur, hops]);
    }
    return out;
  }

  depth(nid: string): number {
    const cached = this.depthCache.get(nid);
    if (cached !== undefined) return cached;
    let d = 0;
    let cur = nid;
    while (this.nodes.get(cur)!.parent !== null) {
      cur = this.nodes.get(cur)!.parent!;
      d += 1;
    }
    this.depthCache.set(nid, d);
    return d;
  }

  linksFrom(nid: string): Array<[string, GraphLink]> {
    return this.links.get(nid) ?? [];
  }

  /**
   * The link-free taxonomy closure of one declared interest: the node itself
   * at `weight`, each ancestor at weight * DECAY^hops (TR-04). This is the
   * shape the production closure table materialises (TR-18) and the only
   * shape document frequency may be computed over (TR-05).
   */
  closure(nid: string, weight = 1.0): Map<string, number> {
    const out = new Map<string, number>([[nid, weight]]);
    for (const [anc, hops] of this.ancestors(nid)) {
      out.set(anc, weight * Math.pow(DECAY, hops));
    }
    return out;
  }
}

/** Document frequency over link-free closures (TR-05), with idf (TR-06). */
export class Corpus {
  private priorDf: Map<string, number> | null = null;
  private priorSize = 0;

  constructor(
    public readonly size: number,
    public readonly df: Map<string, number>,
  ) {}

  static fromVectors(vectors: Array<Map<string, number>>): Corpus {
    const df = new Map<string, number>();
    for (const v of vectors) {
      for (const nid of v.keys()) df.set(nid, (df.get(nid) ?? 0) + 1);
    }
    return new Corpus(vectors.length, df);
  }

  /**
   * TR-36: optional global prior computed over ALL profiles (not just live
   * presence). While the live corpus is small the prior gently stabilises
   * idf; its influence fades linearly with the live population and reaches
   * exactly zero at N = PRIOR_FADE_N, so a live corpus of 30+ scores
   * bit-identically to the legacy formula (well under the 2% shift bound).
   */
  setPrior(priorDf: Map<string, number>, priorSize: number): void {
    this.priorDf = priorDf;
    this.priorSize = priorSize;
  }

  clearPrior(): void {
    this.priorDf = null;
    this.priorSize = 0;
  }

  /** Square-root-compressed, log-smoothed idf (TR-06; TR-36 prior blended). */
  idf(nid: string): number {
    const n = this.df.get(nid) ?? 0;
    if (this.priorDf === null || this.priorSize <= 0) {
      return Math.sqrt(Math.log(1.0 + this.size / (1.0 + n)));
    }
    const w = Math.max(0, (PRIOR_FADE_N - this.size) / PRIOR_FADE_N);
    if (w === 0) {
      return Math.sqrt(Math.log(1.0 + this.size / (1.0 + n)));
    }
    // Pseudo-count blend: the live df is extended with w*PRIOR_FADE_N
    // pseudo-documents distributed as the global prior. At N = 0 the result
    // is exactly the prior's own idf at size PRIOR_FADE_N.
    const s = w * PRIOR_FADE_N;
    const p0 = (this.priorDf.get(nid) ?? 0) / this.priorSize;
    return Math.sqrt(Math.log(1.0 + (this.size + s) / (1.0 + n + s * p0)));
  }
}

/** TR-36: the prior's influence is gone once the live corpus reaches this size. */
export const PRIOR_FADE_N = 30;

export type ReasonKind = "same" | "related" | "sibling" | "ancestor";

export interface Reason {
  kind: ReasonKind;
  node: string;
  label: string;
  contribution: number;
  yours: string | null;
  theirs: string | null;
  yoursLabel: string;
  theirsLabel: string;
}

export interface MatchResult {
  score: number;
  reasons: Reason[];
}

export class Matcher {
  constructor(private readonly graph: InterestGraph) {}

  /**
   * Expand a profile into its weighted closure vector (TR-04, max-combine).
   * Semantic links add the linked node at its authored weight (TR-07). Pass
   * withLinks=false for anything feeding document frequency (TR-05).
   */
  vector(profile: Profile, withLinks = true): Map<string, number> {
    const out = new Map<string, number>();
    for (const [nid, w] of Object.entries(profile)) {
      if (this.graph.get(nid).sensitive) continue; // TR-22 / FR-10
      for (const [cNid, cW] of this.graph.closure(nid, w)) {
        out.set(cNid, Math.max(out.get(cNid) ?? 0.0, cW));
      }
    }
    if (withLinks) {
      for (const [nid, w] of Object.entries(profile)) {
        if (this.graph.get(nid).sensitive) continue;
        for (const [other, link] of this.graph.linksFrom(nid)) {
          out.set(other, Math.max(out.get(other) ?? 0.0, link.weight * w));
        }
      }
    }
    return out;
  }

  /** Score a pair. Deterministic for identical inputs and corpus (TR-10). */
  score(a: Profile, b: Profile, corpus: Corpus): MatchResult {
    const va = this.vector(a);
    const vb = this.vector(b);
    if (va.size === 0 || vb.size === 0) return { score: 0.0, reasons: [] };
    let num = 0.0;
    for (const [nid, wa] of va) {
      const wb = vb.get(nid);
      if (wb !== undefined) num += corpus.idf(nid) * wa * wb;
    }
    const normA = Math.sqrt([...va].reduce((s, [n, w]) => s + corpus.idf(n) * w * w, 0.0));
    const normB = Math.sqrt([...vb].reduce((s, [n, w]) => s + corpus.idf(n) * w * w, 0.0));
    if (!normA || !normB) return { score: 0.0, reasons: [] };
    const shared = declared(a, this.graph).filter((n) =>
      declared(b, this.graph).includes(n),
    ).length;
    const score = (num / (normA * normB)) * (1.0 + EXACT_OVERLAP_BONUS * shared);
    return { score: Math.min(1.0, score), reasons: this.reasons(a, b, corpus) };
  }

  /**
   * Ordered reason list (TR-08), deterministic (TR-09, TR-10). One candidate
   * per node shared by the two link-expanded closure vectors of the reduced
   * profiles; contribution is that node's share of the score numerator.
   * Ordered by (-contribution, node).
   */
  private reasons(a: Profile, b: Profile, corpus: Corpus): Reason[] {
    const va = this.vector(this.reduced(a));
    const vb = this.vector(this.reduced(b));
    const candidates: Reason[] = [];
    for (const [n, wa] of va) {
      const wb = vb.get(n);
      if (wb === undefined) continue;
      candidates.push(this.makeReason(n, a, b, corpus.idf(n) * wa * wb));
    }
    candidates.sort((r1, r2) => r2.contribution - r1.contribution || (r1.node < r2.node ? -1 : r1.node > r2.node ? 1 : 0));
    return candidates;
  }

  /**
   * The profile with subsumed declarations removed for reasoning: a declared
   * node is dropped when another declared node in the same profile has it as
   * an ancestor. Sensitive nodes are dropped too (FR-10). Scoring vectors
   * are unaffected; this shapes only the reason list.
   */
  private reduced(profile: Profile): Profile {
    const g = this.graph;
    const declaredNids = Object.keys(profile).filter((n) => !g.get(n).sensitive);
    const covered = new Set<string>();
    for (const n of declaredNids) {
      for (const [anc] of g.ancestors(n)) {
        if (anc !== n && anc in profile) covered.add(anc);
      }
    }
    const out: Profile = {};
    for (const [n, w] of Object.entries(profile)) {
      if (declaredNids.includes(n) && !covered.has(n)) out[n] = w;
    }
    return out;
  }

  /**
   * The most specific declared node that reaches `node`, via taxonomy closure
   * or one semantic link (TR-07). Ties between equally specific declarers
   * break by profile order, so rendering is deterministic (TR-09).
   */
  private explains(node: string, declaredProfile: Profile): string | null {
    const g = this.graph;
    let best: string | null = null;
    let bestDepth = -1;
    for (const d of Object.keys(declaredProfile)) {
      let reaches: boolean;
      if (d === node) reaches = true;
      else if (g.ancestors(d).some(([a]) => a === node)) reaches = true;
      else reaches = g.linksFrom(d).some(([o]) => o === node);
      if (!reaches) continue;
      const depth = g.depth(d);
      if (depth > bestDepth) {
        best = d;
        bestDepth = depth;
      }
    }
    return best;
  }

  private makeReason(node: string, a: Profile, b: Profile, contribution: number): Reason {
    const g = this.graph;
    const da = this.explains(node, a)!;
    const db = this.explains(node, b)!;
    const la = g.get(da).label;
    const lb = g.get(db).label;
    const linked = g.linksFrom(da).some(([o]) => o === db);
    const base = { node, label: g.get(node).label, contribution, yours: da, theirs: db, yoursLabel: la, theirsLabel: lb };
    if (da === db) return { kind: "same", ...base };
    if (linked) return { kind: "related", ...base };
    if (g.get(da).parent !== null && g.get(da).parent === g.get(db).parent) return { kind: "sibling", ...base };
    return { kind: "ancestor", ...base };
  }
}

/** The non-sensitive declared nodes of a profile (FR-10). */
export function declared(profile: Profile, graph: InterestGraph): string[] {
  return Object.keys(profile).filter((n) => !graph.get(n).sensitive);
}

/**
 * The count behind the FR-11 discoverability floor (fewer than two
 * non-sensitive interests → not discoverable). Unlike declared(), a node
 * the taxonomy no longer knows is skipped rather than throwing — a stale
 * node cannot vouch for discoverability and must not crash the scan path.
 */
export function nonSensitiveCount(profile: Profile, graph: InterestGraph): number {
  let n = 0;
  for (const nid of Object.keys(profile)) {
    if (graph.has(nid) && !graph.get(nid).sensitive) n += 1;
  }
  return n;
}

/**
 * Render the top reason deterministically from its path (TR-09, FR-27).
 * No LLM, no randomness.
 */
export function icebreaker(match: MatchResult): string {
  if (match.reasons.length === 0) return "";
  const r = match.reasons[0];
  switch (r.kind) {
    case "same":
      return `Both into ${r.label}`;
    case "related":
      return `${r.yoursLabel} and ${r.theirsLabel} are neighbours`;
    case "sibling":
      return `Both follow ${r.label}: ${r.yoursLabel} vs ${r.theirsLabel}`;
    default:
      return `Both into ${r.label}: ${r.yoursLabel} and ${r.theirsLabel}`;
  }
}
