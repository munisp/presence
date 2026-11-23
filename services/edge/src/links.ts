/**
 * Post-OPEN external link sharing (PRS-SRS-001 §4, FR-65/SEC-34).
 *
 *   FR-65   a matched pair member may share exactly one external social
 *           link, readable by the counterpart only, once the pair is OPEN.
 *   SEC-34  links are plain text on the wire, carry an interstitial flag
 *           for the client warning sheet, are restricted to a governed
 *           domain allowlist, and are NEVER fetched server-side — this
 *           module contains no network code and the routes store and
 *           return the string untouched.
 *
 * The allowlist is deliberately small and code-owned: widening it is a
 * reviewed change, not a runtime configuration.
 */

/** SEC-34: governed allowlist of shareable external domains. */
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

/** FR-65: mirrors the pair_links CHECK constraint. */
export const LINK_MAX_LEN = 300;

export interface ParsedLink {
  url: string;
  domain: string;
}

export type LinkParseResult =
  | { ok: true; link: ParsedLink }
  | { ok: false; error: string };

/** Exact host or any subdomain of an allowlisted domain. */
export function isAllowedLinkHost(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_LINK_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Validate a shared link (SEC-34): https only, no credentials, bounded
 * length, allowlisted host. Returns the normalized URL plus its registrable
 * display domain, or a rejection reason the route can pass through as 422.
 */
export function parseSharedLink(raw: unknown): LinkParseResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "link must be a non-empty string" };
  }
  if (raw.length > LINK_MAX_LEN) {
    return { ok: false, error: `link must be at most ${LINK_MAX_LEN} characters` };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "link is not a valid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "link must use https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, error: "link must not contain credentials" };
  }
  const host = parsed.hostname.toLowerCase();
  if (!isAllowedLinkHost(host)) {
    return { ok: false, error: "link domain is not on the allowlist" };
  }
  const domain =
    ALLOWED_LINK_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`)) ?? host;
  return { ok: true, link: { url: parsed.toString(), domain } };
}
