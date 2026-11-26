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
  // SRS Addendum 001 (b54) — the live wallet rail (AMD-PAY-15..20).
  "ui.wallet.fund": "Add money",
  "ui.wallet.fund.pending": "Funding arrives by bank transfer",
  "ui.wallet.withdraw": "Withdraw to bank",
  "ui.wallet.withdraw.insufficient": "Your available balance cannot cover this",
  "ui.wallet.withdraw.over-cap": "This amount exceeds a platform cap",
  "ui.wallet.withdraw.cancel": "Cancel withdrawal",
  "ui.wallet.rail-disabled": "Money movement is temporarily paused",
  "ui.wallet.withdrawal.requested": "Requested",
  "ui.wallet.withdrawal.processing": "On its way",
  "ui.wallet.withdrawal.paid": "Paid",
  "ui.wallet.withdrawal.failed": "Failed",
  "ui.wallet.withdrawal.cancelled": "Cancelled",
  // AMD-VERT-01..05: vertical feature flags — the onboarding/settings
  // toggle screen (client/src/presence/verticalOnboarding.ts).
  "ui.verticals.title": "Choose your experiences",
  "ui.verticals.subtitle": "Turn on what you want — you can change this any time in settings.",
  "ui.verticals.toggle.on": "On",
  "ui.verticals.toggle.off": "Off",
  "ui.verticals.locked": "Always on — this is the core of Presence",
  "ui.verticals.ineligible.kyc_required": "Available after identity verification",
  "ui.verticals.ineligible.underage": "Available to members 18 and over",
  "ui.verticals.disabled": "This experience is off — enable it in settings to use it",
  "ui.vertical.discovery.label": "Discovery",
  "ui.vertical.discovery.summary":
    "The proximity core: publish presence, scan, consent and matching.",
  "ui.vertical.venues.label": "Venues",
  "ui.vertical.venues.summary":
    "Venue social surfaces: rooms, tables, booking slots, announcements and check-in.",
  "ui.vertical.groups.label": "Groups",
  "ui.vertical.groups.summary":
    "Group tables and seat stakes — commit to a shared table with a refundable stake.",
  "ui.vertical.dating.label": "Dating",
  "ui.vertical.dating.summary":
    "Dating mode: an opt-in structured profile and preference-based matching.",
  "ui.vertical.marketplace.label": "Marketplace",
  "ui.vertical.marketplace.summary":
    "Structured listings and escrow-backed purchases between members.",
  "ui.vertical.services.label": "Services",
  "ui.vertical.services.summary":
    "Local services and errands: book a vetted provider with milestone escrow — value is committed up-front and released as work completes.",
  "ui.vertical.payments.label": "Payments",
  "ui.vertical.payments.summary": "Wallets and person-to-person transfers.",
  "ui.vertical.trust.label": "Trust",
  "ui.vertical.trust.summary":
    "Presence bonds, verified-met receipts, trust escrows and selective disclosure.",
  "ui.vertical.introductions.label": "Introductions",
  "ui.vertical.introductions.summary":
    "Host-mediated introductions between members who both accept.",
  "ui.vertical.serendipity.label": "Serendipity",
  "ui.vertical.serendipity.summary":
    "Serendipity windows: time-boxed openness to unplanned meets.",
  // SRS Addendum 001 (b60) — barter swap surfaces (AMD-SWP).
  "ui.swaps.title": "Swap board",
  "ui.swaps.create": "Offer a swap",
  "ui.swaps.propose": "Propose a swap",
  "ui.swaps.accept": "Accept swap",
  "ui.swaps.decline": "Decline swap",
  "ui.swaps.cancel": "Withdraw proposal",
  "ui.swaps.confirm": "Confirm exchange",
  "ui.swaps.dispute": "Report a problem",
  "ui.swaps.stake-bond": "Stake swap bond",
  "ui.swaps.kyc-required": "Both sides must be verified to swap",
  "ui.swaps.bond-required": "Both swap bonds must be staked first",
  "ui.swaps.balance": "Cash balance one side adds",
  "ui.swaps.listing.state.listed": "Listed",
  "ui.swaps.listing.state.held": "In a proposal",
  "ui.swaps.listing.state.swapped": "Swapped",
  "ui.swaps.listing.state.removed": "Removed",
  "ui.swaps.agreement.state.proposed": "Waiting for an answer",
  "ui.swaps.agreement.state.accepted": "Exchange in progress",
  "ui.swaps.agreement.state.completed": "Swap completed",
  "ui.swaps.agreement.state.cancelled": "Cancelled",
  "ui.swaps.agreement.state.disputed": "In dispute",
  // SRS Addendum 001 (b61) — service booking surfaces (AMD-SVC).
  "ui.services.title": "Service bookings",
  "ui.services.book": "Book this service",
  "ui.services.start": "Start work",
  "ui.services.confirm-milestone": "Confirm milestone",
  "ui.services.dispute": "Report a problem",
  "ui.services.kyc-required": "Both sides must be verified to book",
  "ui.services.milestones": "Milestones",
  "ui.services.ghost-refund": "Unstarted bookings refund automatically after 7 days",
  "ui.services.booking.state.accepted": "Booked — waiting for the provider",
  "ui.services.booking.state.in_progress": "Work in progress",
  "ui.services.booking.state.completed": "Completed",
  "ui.services.booking.state.cancelled": "Cancelled",
  "ui.services.booking.state.disputed": "In dispute",
  // SRS Addendum 001 (b62) — stakeholder onboarding surfaces (AMD-ONB).
  "ui.onboarding.title": "Get set up",
  "ui.onboarding.step.age": "Confirm your age",
  "ui.onboarding.step.kyc": "Verify your identity",
  "ui.onboarding.step.avatar": "Pick your symbol",
  "ui.onboarding.step.verticals": "Choose what you want to use",
  "ui.onboarding.kyc.request": "Request verification",
  "ui.onboarding.kyc.under-review": "Verification is under review",
  "ui.onboarding.kyc.rejected": "Verification was declined — you can request a new review",
  "ui.onboarding.kyc.suspended": "Verification is suspended",
  "ui.onboarding.complete": "You're all set",
  "ui.onboarding.apply.venue": "Register your venue",
  "ui.onboarding.apply.provider": "Become a provider",
  "ui.onboarding.apply.statement": "Tell us what you run",
  "ui.onboarding.application.state.pending": "Under review",
  "ui.onboarding.application.state.approved": "Approved",
  "ui.onboarding.application.state.rejected": "Declined",
  "ui.onboarding.application.state.withdrawn": "Withdrawn",
  "ui.onboarding.withdraw": "Withdraw application",
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
