/**
 * FR-08 profile write validation and FR-64 structured prompt validation.
 * Pure functions, unit-tested; the routes in routes/profile.ts do the I/O.
 */

// FR-08: a discoverable profile declares between three and twenty interests.
export const INTEREST_MIN = 3;
export const INTEREST_MAX = 20;

export interface InterestInput {
  nodeId: string;
  weight: number;
}

/**
 * Validate a raw PUT body into a deduped interest set, or null when the
 * shape is wrong. Taxonomy existence and sensitivity are checked by the
 * route against taxonomy_nodes (TR-22: sensitive nodes are rejected at
 * write time, never stored).
 */
export function parseInterests(raw: unknown): InterestInput[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < INTEREST_MIN || raw.length > INTEREST_MAX) return null;
  const seen = new Set<string>();
  const out: InterestInput[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return null;
    const { nodeId, weight } = item as { nodeId?: unknown; weight?: unknown };
    if (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 200) return null;
    const w = weight === undefined ? 1.0 : weight;
    if (typeof w !== "number" || !(w > 0) || w > 1) return null;
    if (seen.has(nodeId)) return null;
    seen.add(nodeId);
    out.push({ nodeId, weight: w });
  }
  return out;
}

// FR-64: at most three structured prompts, each at most 120 characters.
export const PROMPT_MAX_COUNT = 3;
export const PROMPT_MAX_LEN = 120;

export interface PromptInput {
  slot: number;
  body: string;
}

/** Validate a raw prompts array, or null when the shape is wrong. */
export function parsePrompts(raw: unknown): PromptInput[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > PROMPT_MAX_COUNT) return null;
  const seen = new Set<number>();
  const out: PromptInput[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return null;
    const { slot, body } = item as { slot?: unknown; body?: unknown };
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > PROMPT_MAX_COUNT) {
      return null;
    }
    if (typeof body !== "string" || body.length === 0 || body.length > PROMPT_MAX_LEN) return null;
    if (seen.has(slot)) return null;
    seen.add(slot);
    out.push({ slot, body });
  }
  return out;
}
