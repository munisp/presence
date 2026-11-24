"""TR-38 / FR-90: venue polygon attribution as a lakehouse spatial join.

The join maps H3 cells at the governed attribution resolution onto venue and
floor polygons. Containment is centroid-based — H3's polygon_to_cells
semantics — which is the finest claim a polygon can make about a cell without
raw coordinates: the cell is attributed only when its centre sits inside the
geometry.

The cell universe is the union of
  - every cell observed in silver presence events (so analytics coverage
    follows reality), and
  - the centroid-contained covering of every published venue/floor polygon
    (so venues with no presence yet still attribute — matching needs the map
    before the first visitor, FR-90).

Output feeds two products:
  - the operational publication bundle (publish_cell_attribution, migration
    0018) — the only path matching uses, so attribution is never recomputed
    per request (TR-38);
  - the GeoParquet export (TR-43) for GIS tooling.

Determinism: inputs are sorted and ties resolve by (venue_id, floor_id), so
the same inputs always produce byte-identical bundles.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone

import h3

# Governed resolution for the published map. Mirrored in
# services/edge/src/attribution.ts and pinned by a pytest cross-check.
ATTRIBUTION_RESOLUTION = 9


@dataclass(frozen=True)
class VenueGeometry:
    """One published polygon from the operational store (venues or
    venue_floors). geometry_version is the FR-90 record version the
    attribution is computed from."""

    venue_id: str
    floor_id: str | None
    polygon: tuple[tuple[float, float], ...]  # (lon, lat) ring, closed
    geometry_version: int


@dataclass(frozen=True)
class AttributionRow:
    cell: str
    venue_id: str
    floor_id: str | None
    geometry_version: int


def _contained_cells(geom: VenueGeometry, resolution: int = ATTRIBUTION_RESOLUTION) -> set[str]:
    """Cells whose centroids lie inside the polygon (H3 polygon_to_cells
    semantics), at the governed resolution."""
    # LatLngPoly expects (lat, lng) outer rings; geometries arrive (lon, lat).
    outer = tuple((lat, lon) for lon, lat in geom.polygon)
    cells = h3.polygon_to_cells(h3.LatLngPoly(outer), resolution)
    return set(cells)


def compute_attribution(
    geometries: list[VenueGeometry],
    observed_cells: set[str] | None = None,
    resolution: int = ATTRIBUTION_RESOLUTION,
) -> list[AttributionRow]:
    """Spatial join: cell universe x venue polygons -> attribution rows.

    A cell is claimed by at most one geometry; overlaps resolve
    deterministically by (venue_id, floor_id) so a contested boundary cell is
    stable run-over-run until the geometry is revised.
    """
    claimed: dict[str, tuple[str, str | None, int]] = {}
    ordered = sorted(
        geometries,
        key=lambda g: (g.venue_id, g.floor_id is None, g.floor_id or ""),
    )
    for geom in ordered:
        for cell in sorted(_contained_cells(geom, resolution)):
            if cell not in claimed:
                claimed[cell] = (geom.venue_id, geom.floor_id, geom.geometry_version)
    # Observed cells with no polygon over them are simply unattributed — the
    # map only asserts venue scope where a polygon genuinely contains the cell.
    _ = observed_cells  # retained in the signature: the universe contract
    rows = [
        AttributionRow(cell, venue, floor, version)
        for cell, (venue, floor, version) in claimed.items()
    ]
    rows.sort(key=lambda r: r.cell)
    return rows


def run_id_for(rows: list[AttributionRow], at: datetime) -> str:
    """Deterministic run id: UTC date + content digest of the row set."""
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    digest = hashlib.sha256(
        json.dumps(
            [[r.cell, r.venue_id, r.floor_id, r.geometry_version] for r in rows],
            separators=(",", ":"),
        ).encode()
    ).hexdigest()[:16]
    return f"{at.strftime('%Y%m%d')}-{digest}"


def publication_bundle(
    rows: list[AttributionRow],
    at: datetime,
) -> dict:
    """Emit the governed publication bundle: manifest + SQL text applying the
    rows through publish_cell_attribution (migration 0018).

    Python never writes to the OLTP database (ARC-002 §4.3): this bundle is
    the artifact an operator or automation applies, with the venue-ops GUC
    set, so every publication lands in admin_audit (FR-60).
    """
    run_id = run_id_for(rows, at)
    payload = [
        {
            "cell": r.cell,
            "venue_id": r.venue_id,
            "floor_id": r.floor_id,
            "geometry_version": r.geometry_version,
        }
        for r in rows
    ]
    sql = (
        "-- TR-38 cell attribution publication\n"
        f"-- run_id: {run_id}\n"
        "SET app.venue_ops = 'on';\n"
        "SELECT publish_cell_attribution(\n"
        f"  '{json.dumps(payload, separators=(',', ':'))}'::jsonb,\n"
        f"  '{run_id}'\n"
        ");\n"
    )
    return {
        "run_id": run_id,
        "generated_at": at.astimezone(timezone.utc).isoformat(),
        "rows": len(rows),
        "cells_digest": hashlib.sha256(
            json.dumps([r.cell for r in rows]).encode()
        ).hexdigest(),
        "sql": sql,
    }
