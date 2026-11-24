/**
 * FR-90 / TR-38: polygon attribution lookup.
 *
 * Venue polygon attribution is computed in the lakehouse (spatial join,
 * analytics/attribution.py) and published to the operational store as a
 * cell -> venue/floor map (publish_cell_attribution, migration 0018).
 * Presence publishing consults that map with a primary-key lookup — the
 * polygon test is never recomputed per request (TR-38).
 *
 * Freshness: attribution rows carry the geometry version they were computed
 * from; the lookup joins venues.geofence_version and only honours rows that
 * match the live version. A polygon revision therefore suspends attribution
 * (falling back to plain cell scope) until the lakehouse republishes — a
 * stale map can never mis-scope presence (FR-90 versioning).
 */

import { cellToParent, getResolution } from "h3-js";
import { EdgeContext } from "./context.js";

/** Governed publication resolution — mirrored in
 * analytics/attribution.py and pinned by a pytest cross-check. */
export const ATTRIBUTION_RESOLUTION = 9;

export interface Attribution {
  venueId: string;
  floorId: string | null;
}

/** The map key for a stored presence cell: the cell itself when already at
 * the attribution resolution, else its ancestor there. Cells coarser than
 * the attribution resolution cannot claim a polygon (their footprint is
 * larger than the map's grain) and return null. */
export function attributionLookupCell(storedCell: string): string | null {
  const res = getResolution(storedCell);
  if (res < ATTRIBUTION_RESOLUTION) return null;
  return res === ATTRIBUTION_RESOLUTION
    ? storedCell
    : cellToParent(storedCell, ATTRIBUTION_RESOLUTION);
}

/** Resolve the venue scope for a presence cell, honouring only attribution
 * rows whose geometry version is still live. */
export async function lookupAttribution(
  ctx: EdgeContext,
  storedCell: string,
): Promise<Attribution | null> {
  const key = attributionLookupCell(storedCell);
  if (key === null) return null;
  const res = await ctx.pg.query(
    `SELECT ca.venue_id, ca.floor_id
       FROM cell_attribution ca
       JOIN venues v
         ON v.venue_id = ca.venue_id
        AND v.geofence_version = ca.geometry_version
      WHERE ca.cell = $1`,
    [key],
  );
  if (res.rows.length === 0) return null;
  return {
    venueId: res.rows[0].venue_id as string,
    floorId: (res.rows[0].floor_id as string | null) ?? null,
  };
}
