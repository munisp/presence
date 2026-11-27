/**
 * AMD-CON-01 (console surfaces): the console's section tree and the role
 * visibility map. Visibility here is a UX filter ONLY — the edge re-checks
 * every role server-side; a section a role cannot read is hidden so the
 * operator is not offered actions that would come back 403.
 */

export const CONSOLE_SECTIONS = [
  "dashboard",
  "moderation",
  "appeals",
  "kyc",
  "onboarding",
  "elevation",
  "geofences",
  "security-events",
] as const;

export type ConsoleSection = (typeof CONSOLE_SECTIONS)[number];

export const SECTION_TITLES: Record<ConsoleSection, string> = {
  dashboard: "Overview",
  moderation: "Reports",
  appeals: "Appeals",
  kyc: "KYC review",
  onboarding: "Onboarding",
  elevation: "Elevation",
  geofences: "Geofences",
  "security-events": "Security events",
};

/**
 * Which workforce realm roles may READ each section. Mirrors the edge:
 * requireModerator gates moderation/appeals/kyc/onboarding/elevation,
 * requireVenueOps gates the geofence estate, and the security-event store
 * is moderator-only with analyst read for the audit function.
 */
const SECTION_ROLES: Record<ConsoleSection, readonly string[]> = {
  dashboard: ["moderator", "venue-ops", "analyst"],
  moderation: ["moderator"],
  appeals: ["moderator"],
  kyc: ["moderator"],
  onboarding: ["moderator"],
  elevation: ["moderator"],
  geofences: ["venue-ops", "moderator"],
  "security-events": ["moderator", "analyst"],
};

export function visibleSections(roles: readonly string[]): ConsoleSection[] {
  return CONSOLE_SECTIONS.filter((section) =>
    SECTION_ROLES[section].some((role) => roles.includes(role)),
  );
}

/** The section a freshly signed-in operator lands on. */
export function defaultSection(roles: readonly string[]): ConsoleSection | null {
  return visibleSections(roles)[0] ?? null;
}

/** A role set with no console surface at all is not a workforce sign-in. */
export function hasConsoleAccess(roles: readonly string[]): boolean {
  return visibleSections(roles).length > 0;
}
