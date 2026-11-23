/**
 * FR-09/TECH-09: free-text entity linking against the taxonomy — the
 * query-time half of the ngram-hash-384.v1 contract.
 *
 * One embedder, two implementations: this module (query text) and
 * scripts/taxonomy_embedder.py (seed generation). Both must produce
 * bit-identical vectors; the equivalence is pinned from both sides against
 * test/golden_embeddings.json. The algorithm contract lives in the Python
 * module's docstring — change both sides or neither.
 *
 * Boundary (TECH-09): this exists for free-text linking only. Nothing in
 * the match path — scan, scoring, the match service — may import it; that
 * separation is test-pinned.
 *
 * Per-node confirmation (FR-09): linking only ever *proposes* candidates.
 * The route performs no writes; the user confirms each node individually
 * and the client adds the confirmed set through the governed interests
 * endpoint (FR-08), which re-validates everything.
 */

import { createHash } from "node:crypto";

/** Embedder identity — versioned per row in taxonomy_node_embeddings so a
 * future model swap is a re-seed, not a schema change. */
export const EMBEDDER_ID = "ngram-hash-384.v1";
export const EMBEDDING_DIMS = 384;

/** FR-09: linking input stays small; it is a phrase, not a document. */
export const LINK_TEXT_MAX_LEN = 500;
/** FR-09: at most five proposals — the user confirms each one. */
export const LINK_MAX_CANDIDATES = 5;
/** Below this cosine the proposal is noise, not a suggestion. */
export const LINK_MIN_SIMILARITY = 0.15;

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function features(token: string): string[] {
  const out = [token];
  for (const n of [2, 3]) {
    for (let i = 0; i + n <= token.length; i++) out.push(token.slice(i, i + n));
  }
  return out;
}

export function embed(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIMS).fill(0);
  for (const token of tokens(text)) {
    for (const feature of features(token)) {
      const digest = createHash("sha256").update(feature, "utf8").digest();
      const idx = digest.readUInt32LE(0) % EMBEDDING_DIMS;
      vec[idx] += (digest[4] & 1) === 1 ? 1 : -1;
    }
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

/** pgvector literal for parameterised queries. */
export function toVectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(",")}]`;
}

/** Seed-side input, mirroring scripts/taxonomy_embedder.py node_text: the
 * label plus the dotted path as words, so a node inherits its ancestors'
 * context. Used by the taxonomy CMS (FR-59) when re-syncing embeddings. */
export function nodeText(nodeId: string, label: string): string {
  return `${label} ${nodeId.replaceAll(".", " ")}`;
}

export type LinkBodyParse = { ok: true; text: string } | { ok: false; error: string };

export function parseLinkBody(
  body: unknown,
  screen: (text: string) => readonly unknown[],
): LinkBodyParse {
  if (body === null || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const text = (body as Record<string, unknown>).text;
  if (typeof text !== "string") return { ok: false, error: "text is required" };
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > LINK_TEXT_MAX_LEN) {
    return { ok: false, error: `text must be 1-${LINK_TEXT_MAX_LEN} characters` };
  }
  if (screen(trimmed).length > 0) {
    return { ok: false, error: "text contains content the community rules prohibit" };
  }
  return { ok: true, text: trimmed };
}
