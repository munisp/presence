/**
 * TECH-16: the dependency budget — maintenance, licence and size.
 *
 * TECH-16: client dependencies carry a maintenance, licence and size
 * budget, and the bundle MUST stay within 45 MB.
 *
 * This module is the client-side contract half of the requirement; the
 * enforcement halves already exist in CI — the SEC-18 sdk-allowlist
 * gate (docs/security/sdk-allowlist.json) decides WHICH packages may
 * enter the tree at all, and the SEC-25 license-checker job scans what
 * is installed. This module pins the numbers those gates defend and
 * the admission arithmetic the review checklist runs:
 *
 *   - the 45 MB bundle ceiling and the per-dependency size allocations
 *     (budget ceilings, not measurements — the audit fails loudly if
 *     the plan itself cannot fit);
 *   - the licence allowlist, mirroring the SEC-25 CI allowlist, with a
 *     prohibited-marker screen in front of it (any *GPL family marker
 *     refuses outright — the same discipline TECH-08 applies to
 *     libsignal's AGPL-3.0);
 *   - the maintenance criteria: deprecated packages are refused, and
 *     every runtime dependency must be on the SEC-18 allowlist.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

/** TECH-16: the bundle ceiling — 45 MB. */
export const BUNDLE_CAP_BYTES = 45 * 1024 * 1024;

/**
 * The licence allowlist, mirroring the SEC-25 CI gate (MIT/ISC/
 * Apache-2.0/BSD/0BSD/CC0). Exact-match only — an unknown identifier
 * is refused, never probed for similarity.
 */
export const ALLOWED_LICENSES = [
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "CC0-1.0",
] as const;

/**
 * Prohibited licence markers screened BEFORE the allowlist: any marker
 * anywhere in the identifier refuses the package outright, so a
 * lookalike like "MIT-or-AGPL-3.0" cannot smuggle copyleft past an
 * exact-match table. The *GPL family and SSPL/Commons Clause are
 * banned from the closed client outright (TECH-08 bans libsignal's
 * AGPL-3.0 on the same ground).
 */
export const PROHIBITED_LICENSE_MARKERS = [
  "GPL",
  "AGPL",
  "LGPL",
  "SSPL",
  "COMMONS CLAUSE",
] as const;

/**
 * Licence admission, fail closed: a prohibited marker refuses; anything
 * not exactly on the allowlist refuses. Upper-cased for the marker
 * screen only; the allowlist match stays exact.
 */
export function licenceAllowed(spdx: string): boolean {
  const upper = spdx.toUpperCase();
  if ((PROHIBITED_LICENSE_MARKERS as readonly string[]).some((marker) => upper.includes(marker))) {
    return false;
  }
  return (ALLOWED_LICENSES as readonly string[]).includes(spdx);
}

export interface DependencySize {
  readonly name: string;
  readonly bytes: number;
}

/**
 * The size ledger: one budget allocation per RUNTIME dependency (the
 * eight entries of client/package.json "dependencies", cross-pinned by
 * tests/test_batch42.py — the SEC-18 allowlist's three extra entries
 * are devDependencies, which never ship in the bundle). Allocations
 * sum to 39 MB against the 45 MB cap, leaving 6 MB of headroom that a
 * future dependency must argue for at review. Batch 66 admitted
 * centrifuge (AMD-CRT-04) with an 8 MB allocation covering its
 * protobufjs/events subtree (~7.6 MB measured).
 */
export const BUNDLE_SIZE_LEDGER: readonly DependencySize[] = [
  { name: "react-native", bytes: 18 * 1024 * 1024 },
  { name: "expo", bytes: 8 * 1024 * 1024 },
  { name: "centrifuge", bytes: 8 * 1024 * 1024 },
  { name: "expo-dev-client", bytes: 2 * 1024 * 1024 },
  { name: "expo-secure-store", bytes: 1 * 1024 * 1024 },
  { name: "expo-status-bar", bytes: 512 * 1024 },
  { name: "h3-js", bytes: 1 * 1024 * 1024 },
  { name: "react", bytes: 512 * 1024 },
] as const;

/** Every runtime dependency must be on the SEC-18 allowlist. */
export const RUNTIME_DEPENDENCY_COUNT = 8;

/**
 * Size audit, fail closed: every allocation finite and positive, no
 * duplicate names, and the total inside the 45 MB cap.
 */
export function bundleSizeFits(entries: readonly DependencySize[]): boolean {
  let total = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!Number.isFinite(entry.bytes) || entry.bytes <= 0) return false;
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    total += entry.bytes;
  }
  return total <= BUNDLE_CAP_BYTES;
}

/** The maintenance criteria, pinned so review applies them uniformly. */
export const MAINTENANCE_RULES = [
  "no-deprecated-packages",
  "sec-18-allowlist-membership",
  "licence-allowlist-exact-match",
  "size-within-allocation",
] as const;

export interface DependencyAdmission {
  readonly name: string;
  readonly licence: string;
  readonly sizeBytes: number;
  readonly deprecated: boolean;
  readonly onSec18Allowlist: boolean;
}

/**
 * The admission gate a new dependency must pass, in order. First
 * refusal wins, and the reasons are pinned so a refusal is legible.
 */
export function dependencyAdmission(
  candidate: DependencyAdmission,
): { readonly admit: true } | { readonly admit: false; readonly reason: string } {
  if (!Number.isFinite(candidate.sizeBytes) || candidate.sizeBytes <= 0) {
    return { admit: false, reason: "size-not-positive" };
  }
  if (!candidate.onSec18Allowlist) {
    return { admit: false, reason: "not-on-sec-18-allowlist" };
  }
  if (candidate.deprecated) {
    return { admit: false, reason: "deprecated" };
  }
  if (!licenceAllowed(candidate.licence)) {
    return { admit: false, reason: "licence-refused" };
  }
  const projected = [
    ...BUNDLE_SIZE_LEDGER,
    { name: candidate.name, bytes: candidate.sizeBytes },
  ] as const;
  if (!bundleSizeFits(projected)) {
    return { admit: false, reason: "bundle-over-cap" };
  }
  return { admit: true };
}

/** The guard CI asserts: the pinned ledger itself fits the cap. */
export function dependencyBudgetHonoursTech16(): boolean {
  return BUNDLE_SIZE_LEDGER.length === RUNTIME_DEPENDENCY_COUNT && bundleSizeFits(BUNDLE_SIZE_LEDGER);
}
