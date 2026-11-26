/**
 * AMD-VERT-01..05: vertical feature flags — client onboarding contract.
 *
 * The SQL catalogue (db/migrations/0034_vertical_flags.sql) is the source
 * of truth; services/edge/src/verticals.ts is the edge mirror; this module
 * is the client mirror. The batch-59 tests pin all three (plus the Go and
 * Rust parity helpers) to the same nine keys, the same order, the same
 * locked core and the same gates.
 *
 * What lives here (framework-free, like every presence contract module):
 *
 *   1. The catalogue mirror — VERTICAL_CATALOGUE carries the same rows the
 *      seed insert carries, so the onboarding screen can render first-run
 *      copy before the account exists (the GET endpoint is authoritative
 *      once the session starts; the mirror is the offline/default render).
 *   2. The read-model parser — parseVerticalsResponse validates the GET
 *      /v1/account/verticals payload strictly and fails closed: a
 *      malformed payload renders nothing rather than a half-truth.
 *   3. The toggle model — verticalToggleItems turns read-model rows into
 *      render items: the locked core renders as always-on with no toggle,
 *      an ineligible vertical renders with its toggle disabled and the
 *      reason copy, everything else renders a live on/off toggle.
 *   4. The patch builder — buildVerticalsPatch validates exactly as the
 *      edge parser and the definer will: known keys only, booleans only,
 *      the locked core is never narrowed, an empty patch refuses. A bad
 *      toggle set never becomes a request.
 */

/** AMD-VERT-01: the nine vertical keys, in catalogue sort order. */
export const VERTICALS = [
  "discovery",
  "venues",
  "groups",
  "dating",
  "marketplace",
  "payments",
  "trust",
  "introductions",
  "serendipity",
] as const;

export type Vertical = (typeof VERTICALS)[number];

/** The locked core: present in every client, never toggleable. */
export const LOCKED_VERTICAL: Vertical = "discovery";

/** Where a flag change was made — mirrors the SQL CHECK constraint. */
export const VERTICAL_FLAG_SOURCES = ["onboarding", "settings", "ops"] as const;
export type VerticalFlagSource = (typeof VERTICAL_FLAG_SOURCES)[number];

/** Sources a client may send on PUT /v1/account/verticals. */
export const VERTICAL_WRITE_SOURCES = ["onboarding", "settings"] as const;

export interface VerticalCatalogueEntry {
  vertical: Vertical;
  locked: boolean;
  requiresKyc: boolean;
  requiresAdult: boolean;
  defaultEnabled: boolean;
  sortOrder: number;
  /** Copy keys into the NFR-27 registry. */
  labelKey: string;
  summaryKey: string;
}

/**
 * AMD-VERT-01: mirror of the seeded vertical_catalogue rows. Labels and
 * summaries resolve through the copy registry; every other field mirrors
 * the seed insert exactly (the batch-59 test pins it).
 */
export const VERTICAL_CATALOGUE: readonly VerticalCatalogueEntry[] = [
  {
    vertical: "discovery",
    locked: true,
    requiresKyc: false,
    requiresAdult: false,
    defaultEnabled: true,
    sortOrder: 0,
    labelKey: "ui.vertical.discovery.label",
    summaryKey: "ui.vertical.discovery.summary",
  },
  {
    vertical: "venues",
    locked: false,
    requiresKyc: false,
    requiresAdult: false,
    defaultEnabled: true,
    sortOrder: 10,
    labelKey: "ui.vertical.venues.label",
    summaryKey: "ui.vertical.venues.summary",
  },
  {
    vertical: "groups",
    locked: false,
    requiresKyc: true,
    requiresAdult: false,
    defaultEnabled: true,
    sortOrder: 20,
    labelKey: "ui.vertical.groups.label",
    summaryKey: "ui.vertical.groups.summary",
  },
  {
    vertical: "dating",
    locked: false,
    requiresKyc: true,
    requiresAdult: true,
    defaultEnabled: true,
    sortOrder: 30,
    labelKey: "ui.vertical.dating.label",
    summaryKey: "ui.vertical.dating.summary",
  },
  {
    vertical: "marketplace",
    locked: false,
    requiresKyc: true,
    requiresAdult: false,
    defaultEnabled: true,
    sortOrder: 40,
    labelKey: "ui.vertical.marketplace.label",
    summaryKey: "ui.vertical.marketplace.summary",
  },
  {
    vertical: "payments",
    locked: false,
    requiresKyc: true,
    requiresAdult: false,
    defaultEnabled: true,
    sortOrder: 50,
    labelKey: "ui.vertical.payments.label",
    summaryKey: "ui.vertical.payments.summary",
  },
  {
    vertical: "trust",
    locked: false,
    requiresKyc: true,
    requiresAdult: false,
    defaultEnabled: true,
    sortOrder: 60,
    labelKey: "ui.vertical.trust.label",
    summaryKey: "ui.vertical.trust.summary",
  },
  {
    vertical: "introductions",
    locked: false,
    requiresKyc: true,
    requiresAdult: false,
    defaultEnabled: true,
    sortOrder: 70,
    labelKey: "ui.vertical.introductions.label",
    summaryKey: "ui.vertical.introductions.summary",
  },
  {
    vertical: "serendipity",
    locked: false,
    requiresKyc: false,
    requiresAdult: false,
    defaultEnabled: true,
    sortOrder: 80,
    labelKey: "ui.vertical.serendipity.label",
    summaryKey: "ui.vertical.serendipity.summary",
  },
];

/** AMD-VERT-04: one row of the GET /v1/account/verticals read model. */
export interface VerticalFlagState {
  vertical: Vertical;
  locked: boolean;
  eligible: boolean;
  reason: "kyc_required" | "underage" | null;
  enabled: boolean;
  explicitChoice: boolean;
  source: VerticalFlagSource | null;
}

/**
 * Strict parser for the GET payload. Returns null on any deviation —
 * unknown vertical, wrong type, missing field — so a malformed payload
 * renders nothing rather than a half-truth (the catalogue mirror remains
 * the offline render).
 */
export function parseVerticalsResponse(body: unknown): VerticalFlagState[] | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.verticals)) return null;
  const out: VerticalFlagState[] = [];
  for (const raw of b.verticals) {
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.vertical !== "string" ||
        !(VERTICALS as readonly string[]).includes(r.vertical)) return null;
    if (typeof r.locked !== "boolean" ||
        typeof r.eligible !== "boolean" ||
        typeof r.enabled !== "boolean" ||
        typeof r.explicitChoice !== "boolean") return null;
    if (r.reason !== undefined &&
        r.reason !== "kyc_required" && r.reason !== "underage") return null;
    if (r.source !== undefined &&
        !(VERTICAL_FLAG_SOURCES as readonly string[]).includes(r.source as string)) {
      return null;
    }
    out.push({
      vertical: r.vertical as Vertical,
      locked: r.locked,
      eligible: r.eligible,
      reason: (r.reason ?? null) as VerticalFlagState["reason"],
      enabled: r.enabled,
      explicitChoice: r.explicitChoice,
      source: (r.source ?? null) as VerticalFlagState["source"],
    });
  }
  return out;
}

/** AMD-VERT-04: one render item of the onboarding/settings toggle list. */
export interface VerticalToggleItem {
  vertical: Vertical;
  labelKey: string;
  summaryKey: string;
  /** True when the on/off control is interactive. */
  toggleable: boolean;
  /** Current effective state — what the toggle shows. */
  on: boolean;
  /** Why the control is not interactive: "locked" | the reason code. */
  disabledReason: "locked" | "kyc_required" | "underage" | null;
  /** Copy key for the disabled explanation, when there is one. */
  disabledCopyKey: string | null;
}

/**
 * Turn read-model rows into the toggle list, in catalogue order. The
 * locked core renders first, always on, with no control; ineligible
 * verticals render disabled with their reason; the rest are live toggles.
 */
export function verticalToggleItems(states: readonly VerticalFlagState[]): VerticalToggleItem[] {
  const byVertical = new Map(states.map((s) => [s.vertical, s]));
  return VERTICAL_CATALOGUE.map((entry) => {
    const state = byVertical.get(entry.vertical);
    if (entry.locked) {
      return {
        vertical: entry.vertical,
        labelKey: entry.labelKey,
        summaryKey: entry.summaryKey,
        toggleable: false,
        on: true,
        disabledReason: "locked",
        disabledCopyKey: "ui.verticals.locked",
      };
    }
    const eligible = state?.eligible ?? true;
    const reason = state?.reason ?? null;
    return {
      vertical: entry.vertical,
      labelKey: entry.labelKey,
      summaryKey: entry.summaryKey,
      toggleable: eligible,
      on: state?.enabled ?? entry.defaultEnabled,
      disabledReason: eligible ? null : (reason ?? "kyc_required"),
      disabledCopyKey: eligible ? null : `ui.verticals.ineligible.${reason ?? "kyc_required"}`,
    };
  });
}

export type VerticalsPatchError =
  | "empty_patch"
  | "unknown_vertical"
  | "non_boolean"
  | "locked_narrowed"
  | "source_unknown";

/**
 * AMD-VERT-05 (client half): validate a toggle set exactly as the edge
 * parser and the definer will. Returns the wire patch on success, or every
 * problem found. The locked core is never part of a patch — affirming it
 * is a no-op the client simply omits; narrowing it is refused.
 */
export function buildVerticalsPatch(
  toggles: Readonly<Record<string, unknown>>,
  source: string,
): { ok: true; patch: Partial<Record<Vertical, boolean>>; source: "onboarding" | "settings" }
 | { ok: false; errors: VerticalsPatchError[] } {
  const errors: VerticalsPatchError[] = [];
  if (!(VERTICAL_WRITE_SOURCES as readonly string[]).includes(source)) {
    errors.push("source_unknown");
  }
  const entries = Object.entries(toggles);
  if (entries.length === 0) errors.push("empty_patch");
  const patch: Partial<Record<Vertical, boolean>> = {};
  for (const [key, value] of entries) {
    if (!(VERTICALS as readonly string[]).includes(key)) {
      errors.push("unknown_vertical");
      continue;
    }
    if (typeof value !== "boolean") {
      errors.push("non_boolean");
      continue;
    }
    if (key === LOCKED_VERTICAL) {
      if (value === false) errors.push("locked_narrowed");
      continue; // affirming the core is a no-op — never sent on the wire
    }
    patch[key as Vertical] = value;
  }
  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(patch).length === 0) return { ok: false, errors: ["empty_patch"] };
  return { ok: true, patch, source: source as "onboarding" | "settings" };
}
