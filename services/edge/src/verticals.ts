/**
 * Vertical feature flags (SRS Addendum 001 — AMD-VERT-01..05).
 *
 * The SQL catalogue (0034_vertical_flags.sql) is the source of truth; this
 * module is the edge mirror: the same ten keys, the same locked core, and
 * the route-template map the preHandler gate enforces. The client
 * (client/src/presence/verticalOnboarding.ts), the Go parity helper
 * (services/presence-go/verticals.go) and the Rust parity helper
 * (services/match-core/src/verticals.rs) carry the same catalogue — the
 * batch-59/61 tests pin all five together.
 *
 * Gate semantics:
 *   - unmapped route templates are never gated (account, consent, profile,
 *     moderation, taxonomy, telemetry, ops and safety surfaces stay open);
 *   - a mapped template is refused with 403 { error: "vertical_disabled",
 *     vertical } when the caller narrowed that vertical off;
 *   - the locked core (`discovery`) has no gated routes by construction —
 *     presence publish, scan and consent can never be switched off;
 *   - eligibility (KYC/adult) is NOT re-checked here: the route definers
 *     already prove it at use. The gate enforces the user's own choice.
 */

import { FastifyReply, FastifyRequest } from "fastify";
import { withRls } from "./auth.js";
import { EdgeContext } from "./context.js";

/** AMD-VERT-01: the ten verticals, in catalogue sort order. */
export const VERTICALS = [
  "discovery",
  "venues",
  "groups",
  "dating",
  "marketplace",
  "services",
  "payments",
  "trust",
  "introductions",
  "serendipity",
] as const;

export type Vertical = (typeof VERTICALS)[number];

/** The locked core: present in every client, never gateable. */
export const LOCKED_VERTICAL: Vertical = "discovery";

/**
 * AMD-VERT-03 (edge half): route template → vertical. Matched against
 * req.routeOptions.url (the Fastify template, e.g. "/v1/groups/:tableId/
 * stake"), so path parameters never confuse the match. Rules are evaluated
 * in order; the first hit wins. `/v1/moderation/*` is deliberately absent —
 * moderation surfaces answer to workforce roles, not to consumer flags.
 */
const TEMPLATE_RULES: ReadonlyArray<readonly [RegExp, Vertical]> = [
  // venues — the venue social surface (mirrors VENUE_FEATURES scope).
  [/^\/v1\/rooms(\/|$)/, "venues"],
  [/^\/v1\/tables(\/|$)/, "venues"],
  [/^\/v1\/slots(\/|$)/, "venues"],
  [/^\/v1\/announcements(\/|$)/, "venues"],
  [/^\/v1\/presence\/checkin(\/|$)/, "venues"],
  [/^\/v1\/venues\/[^/]+\/rooms(\/|$)/, "venues"],
  // groups — table seat stakes.
  [/^\/v1\/groups(\/|$)/, "groups"],
  // dating mode.
  [/^\/v1\/dating(\/|$)/, "dating"],
  // marketplace.
  [/^\/v1\/marketplace(\/|$)/, "marketplace"],
  // marketplace (incl. barter swaps — a swap is a marketplace mode).
  [/^\/v1\/swaps(\/|$)/, "marketplace"],
  // services — bookable service/errand listings with milestone escrow.
  [/^\/v1\/services(\/|$)/, "services"],
  // payments — consumer wallet + transfer routes only; the moderation
  // wallet routes live under /v1/moderation and never match these.
  [/^\/v1\/transfers(\/|$)/, "payments"],
  [/^\/v1\/wallets(\/|$)/, "payments"],
  // trust instruments.
  [/^\/v1\/presence\/bond(\/|$)/, "trust"],
  [/^\/v1\/met-receipts(\/|$)/, "trust"],
  [/^\/v1\/escrows(\/|$)/, "trust"],
  [/^\/v1\/disclosure-grants(\/|$)/, "trust"],
  [/^\/v1\/attestation(\/|$)/, "trust"],
  // host-mediated introductions.
  [/^\/v1\/introductions(\/|$)/, "introductions"],
  // serendipity windows.
  [/^\/v1\/serendipity(\/|$)/, "serendipity"],
];

/** Resolve the vertical a route template belongs to, or null when ungated. */
export function verticalForTemplate(template: string): Vertical | null {
  for (const [re, vertical] of TEMPLATE_RULES) {
    if (re.test(template)) return vertical;
  }
  return null;
}

/**
 * AMD-VERT-02/03: the authenticated preHandler gate. Registered after
 * `authenticate` so req.userId is set; runs one withRls lookup against the
 * definer resolver. Fail-closed on database error only in the sense that the
 * error propagates to the error contract — a flag miss never throws.
 */
export function verticalGate(ctx: EdgeContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const template = req.routeOptions?.url;
    if (!template) return;
    const vertical = verticalForTemplate(template);
    if (vertical === null) return;
    const enabled = await withRls(ctx.pg, req.userId, async (c) => {
      const r = await c.query(`SELECT vertical_enabled($1) AS enabled`, [
        vertical,
      ]);
      return r.rows[0].enabled as boolean;
    });
    if (!enabled) {
      return reply.code(403).send({ error: "vertical_disabled", vertical });
    }
  };
}

/** Parsed body for PUT /v1/account/verticals. */
export interface VerticalsPatch {
  patch: Partial<Record<Vertical, boolean>>;
  source: "onboarding" | "settings";
}

const PATCH_SOURCES = ["onboarding", "settings"] as const;

/**
 * Strict body parser (TR-23 shape: unknown keys, non-boolean values, an
 * empty patch or an unknown source all refuse client-side before the
 * definer is involved — the definer re-validates everything regardless).
 * The locked core may be affirmed (`discovery: true`, a harmless no-op)
 * but never narrowed, mirroring the definer exactly.
 */
export function parseVerticalsPatchBody(body: unknown): VerticalsPatch | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "patch" && k !== "source")) return null;
  if (typeof b.source !== "string" ||
      !(PATCH_SOURCES as readonly string[]).includes(b.source)) {
    return null;
  }
  if (b.patch === null || typeof b.patch !== "object" || Array.isArray(b.patch)) {
    return null;
  }
  const entries = Object.entries(b.patch as Record<string, unknown>);
  if (entries.length === 0) return null;
  const patch: Partial<Record<Vertical, boolean>> = {};
  for (const [key, value] of entries) {
    if (!(VERTICALS as readonly string[]).includes(key)) return null;
    if (typeof value !== "boolean") return null;
    if (key === LOCKED_VERTICAL && value === false) return null;
    patch[key as Vertical] = value;
  }
  return { patch, source: b.source as VerticalsPatch["source"] };
}
