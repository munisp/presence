/**
 * SEC-34: external social links — the client half of the contract.
 *
 * The server half (services/edge/src/links.ts) already guarantees the
 * wire shape: https-only, credential-free, length-bound, restricted to a
 * governed domain allowlist, stored and returned untouched, and NEVER
 * fetched server-side for previews or metadata. This module holds the
 * render policy the surfaces must obey:
 *
 *   1. Every external link renders as PLAIN TEXT. There is no preview
 *      card, no unfurl, no metadata fetch — this module contains no
 *      network code at all (pinned by tests/test_batch36.py, same trick
 *      as the sha256 import-free pin).
 *   2. Opening is always behind a confirmation INTERSTITIAL whose copy
 *      is fixed here, so the warning cannot be diluted by a surface.
 *   3. The allowlist MIRRORS the server's governed list (the mirror is
 *      pinned equal by tests/test_batch36.py). A link whose host is not
 *      allowlisted gets no open affordance at all — defense in depth:
 *      the server already rejects it at write time with a 422.
 *
 * Widening the allowlist is a reviewed change on BOTH sides, never a
 * runtime configuration.
 */

/** SEC-34: governed allowlist — mirror of services/edge/src/links.ts. */
export const ALLOWED_LINK_DOMAINS: readonly string[] = [
  "bsky.app",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "mastodon.social",
  "signal.me",
  "t.me",
  "tiktok.com",
  "twitter.com",
  "wa.me",
  "x.com",
];

/** SEC-34: the interstitial copy — fixed, so every surface warns alike. */
export const LINK_INTERSTITIAL = {
  title: "Leaving Presence",
  body: "This link opens an external site. Its content is not moderated by Presence.",
  confirmLabel: "Open link",
  cancelLabel: "Go back",
} as const;

export interface LinkRenderDecision {
  /** Always plain text — previews and unfurls are forbidden. */
  render: "plain-text";
  /** SEC-34: the client must not fetch the target for metadata either. */
  preview: "forbidden";
  /** "interstitial" = tappable behind the warning; "never" = inert text. */
  open: "interstitial" | "never";
  /** Registrable allowlist domain when allowed, else the raw host. */
  domain: string;
  /** False = not allowlisted → no open affordance, plain inert text. */
  allowed: boolean;
}

/** Exact host or any subdomain of an allowlisted domain. */
export function isAllowedLinkHost(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_LINK_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Classify a shared external link for rendering. Never throws: anything
 * unparseable degrades to inert plain text, which is always safe.
 */
export function classifyExternalLink(raw: unknown): LinkRenderDecision {
  const inert: LinkRenderDecision = {
    render: "plain-text",
    preview: "forbidden",
    open: "never",
    domain: "",
    allowed: false,
  };
  if (typeof raw !== "string" || raw.length === 0) return inert;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return inert;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    return { ...inert, domain: parsed.hostname.toLowerCase() };
  }
  const host = parsed.hostname.toLowerCase();
  const domain =
    ALLOWED_LINK_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`)) ?? host;
  const allowed = isAllowedLinkHost(host);
  return {
    render: "plain-text",
    preview: "forbidden",
    open: allowed ? "interstitial" : "never",
    domain,
    allowed,
  };
}

/**
 * Resolve the interstitial. The only path to opening a link runs through
 * an explicit confirm; cancel and dismissal both leave the link inert.
 */
export function resolveInterstitial(choice: "confirm" | "cancel"): "open" | "dismiss" {
  return choice === "confirm" ? "open" : "dismiss";
}
