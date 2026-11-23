/**
 * Venue floor declarations (PRS-SRS-001 §3.4, FR-99, TR-42).
 *
 * A venue declares its floors (venue_floors) and which floors are connected
 * — the declaration is directional in the table but read symmetrically here:
 * either side listing the other is enough for the pair to be discoverable
 * across the floor boundary. Floors only scope discovery inside one venue;
 * presence without a floor, or at another venue, is unaffected.
 */

export interface FloorDeclaration {
  floorId: string;
  connectedTo: string[];
}

/**
 * Is a candidate on `candFloor` discoverable by a requester on `reqFloor`
 * at the same venue? Either floor missing → no floor rule applies.
 */
export function floorsCompatible(
  reqFloor: string | null,
  candFloor: string | null,
  declarations: FloorDeclaration[],
): boolean {
  if (reqFloor === null || candFloor === null) return true;
  if (reqFloor === candFloor) return true;
  for (const d of declarations) {
    if (d.floorId === reqFloor && d.connectedTo.includes(candFloor)) return true;
    if (d.floorId === candFloor && d.connectedTo.includes(reqFloor)) return true;
  }
  return false;
}
