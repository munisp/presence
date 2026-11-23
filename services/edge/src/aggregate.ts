/**
 * Aggregate-only venue metrics (PRS-SRS-001 §3.6, BR-12/BR-13).
 *
 * Every figure the venue dashboard serves passes through kSuppressed(): when
 * fewer than k individuals stand behind a number, the value is withheld
 * entirely — the venue sees "suppressed", never the small number. The
 * dashboard never serves user-level data at all (BR-28 principle).
 */

export const K_MIN = 11; // BR-13

/** BR-13: k-anonymity suppression for aggregate figures. */
export function kSuppressed(value: number, k = K_MIN): number | null {
  return value >= k ? value : null;
}
