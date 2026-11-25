/**
 * NFR-27: localisation without code changes.
 *
 * The SRS: English at launch; the client MUST be localisable without
 * code changes; two additional locales follow within three months of
 * launch.
 *
 * What is enforceable without a device lands here as the copy contract:
 *
 *   1. ONE registry — every user-facing shell string is a key in
 *      {@link ENGLISH_COPY}, the launch-locale baseline. A surface never
 *      hard-codes a sentence; it resolves one. (Module-internal pinned
 *      legal sentences stay pinned in their owning modules; they are
 *      registry-adjacent contract text, not free copy.)
 *   2. Locales are DATA — a {@link LocaleBundle} is a tag plus a string
 *      map. Adding a locale is constructing data and calling
 *      {@link resolveCopy}; no code path changes. {@link copyHonoursNfr27}
 *      proves it by registering a synthetic locale at runtime and
 *      observing the override resolve.
 *   3. English is the floor — {@link resolveCopy} falls back to the
 *      English baseline for any key a bundle does not translate, so a
 *      partial locale degrades to English, never to a raw key or a blank
 *      string.
 *   4. Fail closed — an unknown key resolves to null (a surface renders
 *      nothing rather than leaking a registry key), and an unreadable
 *      bundle or malformed tag is treated as English.
 *   5. Launch readiness — {@link localeCoverage} reports exactly which
 *      keys a locale is missing; {@link localeIsLaunchReady} requires
 *      full coverage, which is the bar the two post-launch locales must
 *      clear inside their three-month window.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

/** NFR-27: the launch locale. */
export const LAUNCH_LOCALE = "en";

/**
 * NFR-27: the post-launch commitment — two additional locales within
 * three months. The capability is proven here; scheduling the two packs
 * is the ops half of the requirement.
 */
export const ADDITIONAL_LOCALES_COMMITTED = 2;
export const ADDITIONAL_LOCALES_WINDOW_MONTHS = 3;

/**
 * BCP-47-lite: a primary language subtag of two or three lowercase
 * letters, optionally followed by a script (four letters, title case)
 * and/or a region (two uppercase letters or three digits), hyphen
 * separated. "en", "en-GB", "zh-Hant-TW" pass; garbage fails.
 */
export const LOCALE_TAG_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/** The English launch baseline — every user-facing shell string by key. */
export const ENGLISH_COPY: Readonly<Record<string, string>> = {
  "app.title": "Presence",
  "app.subtitle": "Be where your people are.",
  "presence.checkin.cta": "Check in with a venue code",
  "presence.publish.refused":
    "Precise location is off — presence stays unpublished until you enable it or check in.",
  "power.reduced.notice": "Reduced power: presence refreshes every ten minutes.",
  "offer.expired": "This offer has expired.",
  "report.cta": "Report",
  "block.cta": "Block",
  "settings.delete-account": "Delete account",
  // UI shell (b47): screen titles, mode labels, tray and gesture copy.
  "ui.discovery.title": "Discovery",
  "ui.mode.pairs": "Pairs",
  "ui.mode.rooms": "Rooms",
  "ui.mode.tables": "Tables",
  "ui.refresh": "Refresh",
  "ui.back": "Back",
  "ui.safety.tray": "Safety",
  "ui.safety.withdraw": "Withdraw consent",
  "ui.safety.privacy": "Privacy controls",
  "ui.thread.title": "Conversation",
  "ui.checkin.title": "Venue check-in",
  "ui.settings.title": "Settings",
  "ui.match.title": "Match",
  "ui.wave.hold": "Hold to wave",
  "ui.thread.send": "Send",
  "ui.thread.revoke": "Revoke",
  "ui.thread.close-offer": "Close offer",
  "ui.thread.delete-local": "Delete local copy",
  "ui.thread.leave": "Leave",
  // SRS Addendum 001 (b48) — identity assurance surfaces.
  "ui.identity.status-title": "Identity & verification",
  "ui.kyc.status.pending": "Verification in progress",
  "ui.kyc.status.verified": "Verified",
  "ui.kyc.status.rejected": "Verification declined",
  "ui.kyc.status.suspended": "Verification suspended",
  "ui.avatar.choose": "Choose your symbol",
  "ui.avatar.cooldown": "Your symbol can change once a day",
  "ui.avatar.locked": "Your symbol stays while a conversation is open",
  // SRS Addendum 001 (b49) — P2P transfer surfaces (AMD-PAY).
  "ui.transfer.title": "Send money",
  "ui.transfer.fee": "Transfer fee",
  "ui.transfer.accept": "Accept transfer",
  "ui.transfer.decline": "Decline transfer",
  "ui.transfer.cancel": "Cancel transfer",
  "ui.transfer.dispute": "Report a problem",
  "ui.transfer.kyc-required": "Both sides must be verified to send money",
  "ui.transfer.open-required": "Money moves only inside an open conversation",
  "ui.transfer.state.proposed": "Waiting for acceptance",
  "ui.transfer.state.accepted": "Accepted",
  "ui.transfer.state.declined": "Declined",
  "ui.transfer.state.cancelled": "Cancelled",
  "ui.transfer.state.expired": "Expired",
  "ui.transfer.state.settled": "Settled",
  "ui.transfer.state.disputed": "In dispute",
  "ui.transfer.state.resolved": "Resolved",
  // SRS Addendum 001 (b53) — wallet surfaces (AMD-PAY-10..14).
  "ui.wallet.title": "Wallet",
  "ui.wallet.balance": "Balance",
  "ui.wallet.available": "Available",
  "ui.wallet.held": "Reserved for transfers",
  "ui.wallet.create": "Open your wallet",
  "ui.wallet.exists": "Your wallet is ready",
  "ui.wallet.kyc-required": "Verify your identity to open a wallet",
  "ui.wallet.status.active": "Active",
  "ui.wallet.status.frozen": "Frozen",
  "ui.wallet.status.closed": "Closed",
  "ui.wallet.entry.fund": "Funds added",
  "ui.wallet.entry.withdrawal": "Withdrawal",
  "ui.wallet.entry.transfer_out": "Transfer sent",
  "ui.wallet.entry.transfer_in": "Transfer received",
  "ui.wallet.entry.fee_charge": "Transfer fee",
  "ui.wallet.entry.fee_revenue": "Fee revenue",
  "ui.wallet.hold.pending": "Reserved",
  "ui.wallet.hold.posted": "Settled",
  "ui.wallet.hold.voided": "Released",
};

/** A locale pack: pure data. Adding one never touches code. */
export interface LocaleBundle {
  readonly tag: string;
  readonly copy: Readonly<Record<string, string>>;
}

/** True when the tag is a well-formed BCP-47-lite locale tag. */
export function isValidLocaleTag(tag: unknown): boolean {
  return typeof tag === "string" && LOCALE_TAG_PATTERN.test(tag);
}

/**
 * Resolve one copy key through a locale bundle with the English floor.
 *
 * Order: a valid bundle's own translation (non-empty string) → the
 * English baseline. An unknown key — one absent from the baseline —
 * resolves to null: a missing translation degrades to English, but a
 * key the registry does not own is a defect and renders nothing.
 */
export function resolveCopy(
  bundle: LocaleBundle | null | undefined,
  key: string,
): string | null {
  const baseline = Object.prototype.hasOwnProperty.call(ENGLISH_COPY, key)
    ? ENGLISH_COPY[key]
    : undefined;
  if (baseline === undefined) return null;
  if (
    bundle !== null &&
    bundle !== undefined &&
    isValidLocaleTag(bundle.tag) &&
    bundle.copy !== null &&
    typeof bundle.copy === "object"
  ) {
    const translated = bundle.copy[key];
    if (typeof translated === "string" && translated.trim() !== "") {
      return translated;
    }
  }
  return baseline;
}

/** Coverage report for one locale against the English baseline. */
export interface LocaleCoverage {
  readonly tag: string;
  readonly total: number;
  readonly translated: number;
  readonly missing: readonly string[];
}

/**
 * Measure a locale against the baseline: which keys it translates and
 * which it is missing. The two post-launch packs are launch-ready only
 * at full coverage — partial packs ship only with the English floor
 * doing the honest fallback, never silently.
 */
export function localeCoverage(bundle: LocaleBundle): LocaleCoverage {
  const keys = Object.keys(ENGLISH_COPY);
  const missing = keys.filter((key) => {
    const translated = bundle.copy[key];
    return !(typeof translated === "string" && translated.trim() !== "");
  });
  return {
    tag: bundle.tag,
    total: keys.length,
    translated: keys.length - missing.length,
    missing,
  };
}

/** A locale is launch-ready only at full coverage of the baseline. */
export function localeIsLaunchReady(bundle: LocaleBundle): boolean {
  if (!isValidLocaleTag(bundle.tag)) return false;
  return localeCoverage(bundle).missing.length === 0;
}

/**
 * The NFR-27 contract as an executable check:
 *
 *  - the launch locale is English;
 *  - the baseline has no empty strings;
 *  - the commitment constants are pinned (two locales, three months);
 *  - adding a locale is data-only — a synthetic bundle constructed at
 *    runtime resolves its override with zero code change;
 *  - a partial bundle falls back to English on its missing keys;
 *  - an unknown key fails closed to null;
 *  - a malformed bundle or tag is treated as English, never as an error.
 */
export function copyHonoursNfr27(): boolean {
  if (LAUNCH_LOCALE !== "en") return false;
  if (ADDITIONAL_LOCALES_COMMITTED !== 2 || ADDITIONAL_LOCALES_WINDOW_MONTHS !== 3) {
    return false;
  }
  if (!isValidLocaleTag(LAUNCH_LOCALE)) return false;
  const keys = Object.keys(ENGLISH_COPY);
  if (keys.length === 0) return false;
  if (keys.some((key) => ENGLISH_COPY[key].trim() === "")) return false;

  // Data-only locale addition: construct a pack at runtime and resolve
  // through it. No code path changed — this IS the "without code
  // changes" proof.
  const synthetic: LocaleBundle = {
    tag: "yo",
    copy: { "app.title": "Iwalaye" },
  };
  if (resolveCopy(synthetic, "app.title") !== "Iwalaye") return false;

  // Partial bundle: missing keys fall back to the English floor.
  if (resolveCopy(synthetic, "app.subtitle") !== ENGLISH_COPY["app.subtitle"]) {
    return false;
  }

  // Unknown key fails closed.
  if (resolveCopy(synthetic, "no.such.key") !== null) return false;
  if (resolveCopy(null, "no.such.key") !== null) return false;

  // Garbage bundles and tags resolve as English, never throw.
  const malformed = { tag: "EN!!", copy: { "app.title": "Forged" } };
  if (resolveCopy(malformed, "app.title") !== ENGLISH_COPY["app.title"]) {
    return false;
  }
  if (resolveCopy(undefined, "app.title") !== ENGLISH_COPY["app.title"]) {
    return false;
  }
  if (
    resolveCopy(
      { tag: "en", copy: { "app.title": "" } },
      "app.title",
    ) !== ENGLISH_COPY["app.title"]
  ) {
    return false;
  }

  // Readiness: the synthetic partial pack is not launch-ready; a full
  // pack is.
  if (localeIsLaunchReady(synthetic)) return false;
  const full: LocaleBundle = {
    tag: "fr",
    copy: Object.fromEntries(keys.map((key) => [key, ENGLISH_COPY[key]])),
  };
  return localeIsLaunchReady(full);
}
