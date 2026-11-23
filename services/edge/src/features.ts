/**
 * FR-63: per-venue feature flags (PRS-SRS-001 §4.4/4.5/4.7 behaviours).
 * Flags live in venue_features and are written by ops with an admin_audit
 * row (FR-60), never by client traffic. A missing row means the feature is
 * ON — flags only ever narrow behaviour, so an unknown venue degrades to
 * fully enabled rather than fully broken.
 */

import Postgres from "pg";

export const VENUE_FEATURES = [
  "announcements",
  "offers",
  "rooms",
  "tables",
  "booking",
  "checkin",
] as const;

export type VenueFeature = (typeof VENUE_FEATURES)[number];

/** FR-63: is `feature` enabled at `venueId`? Default-on when undeclared. */
export async function venueFeatureEnabled(
  pg: Postgres.Pool,
  venueId: string,
  feature: VenueFeature,
): Promise<boolean> {
  const r = await pg.query(
    "SELECT enabled FROM venue_features WHERE venue_id = $1 AND feature = $2",
    [venueId, feature],
  );
  return r.rows.length === 0 || r.rows[0].enabled === true;
}
