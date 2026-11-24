"""TR-43: GeoParquet publication for analytical geospatial outputs.

GIS tooling must be able to read analytical geospatial outputs without a live
database connection, and no reporting surface may require database access to
render a map. Every geospatial gold product therefore also publishes as
GeoParquet: Parquet files whose schema carries the `geo` metadata key
(primary column, WKB encoding, geometry types, bbox, CRS = OGC:CRS84).

Written with plain pyarrow + shapely WKB so the writer has no geopandas
dependency and the metadata is explicit and testable.
"""

from __future__ import annotations

import json

import h3
import pyarrow as pa
import pyarrow.parquet as pq
from shapely.geometry import Polygon, mapping
from shapely.wkb import dumps as wkb_dumps

GEOPARQUET_VERSION = "1.0.0"
# GeoParquet 1.0: CRS84 expressed in the PROJJSON-less fallback form. The
# axis order of the written coordinates is always (lon, lat).
CRS84 = "OGC:CRS84"


def cell_polygon(cell: str) -> Polygon:
    """Shapely polygon for an H3 cell boundary, (lon, lat) vertex order."""
    boundary = h3.cell_to_boundary(cell)  # (lat, lng) pairs
    ring = [(lng, lat) for lat, lng in boundary]
    ring.append(ring[0])
    return Polygon(ring)


def geo_metadata(geometry_types: list[str], bbox: list[float]) -> dict[bytes, bytes]:
    """The GeoParquet `geo` schema metadata block."""
    geo = {
        "version": GEOPARQUET_VERSION,
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                "geometry_types": sorted(set(geometry_types)),
                "crs": CRS84,
                "edges": "spherical",
                "bbox": bbox,
            }
        },
    }
    return {b"geo": json.dumps(geo).encode()}


def write_geoparquet(
    path: str,
    base: pa.Table,
    geometries: list[Polygon],
) -> None:
    """Write a table plus a WKB geometry column as GeoParquet 1.0."""
    if base.num_rows != len(geometries):
        raise ValueError("one geometry per row")
    wkbs = [wkb_dumps(g) for g in geometries]
    if geometries:
        minx = min(g.bounds[0] for g in geometries)
        miny = min(g.bounds[1] for g in geometries)
        maxx = max(g.bounds[2] for g in geometries)
        maxy = max(g.bounds[3] for g in geometries)
        bbox = [minx, miny, maxx, maxy]
        types = sorted({g.geom_type for g in geometries})
    else:
        bbox = [0.0, 0.0, 0.0, 0.0]
        types = []
    table = base.append_column("geometry", pa.array(wkbs, type=pa.binary()))
    schema = table.schema.with_metadata(geo_metadata(types, bbox))
    pq.write_table(table.cast(schema), path)


def density_geoparquet_rows(density: pa.Table) -> tuple[pa.Table, list[Polygon]]:
    """Density cell-hour rows -> (metrics table, cell boundary polygons)."""
    cells = density.column("cell").to_pylist()
    polygons = [cell_polygon(c) for c in cells]
    return density.drop_columns([]), polygons


def table_to_geojson_features(table: pa.Table, geometries: list[Polygon]) -> list[dict]:
    """Debug/export helper: feature dicts pairing row fields with geometry."""
    rows = table.to_pylist()
    return [
        {"type": "Feature", "geometry": mapping(g), "properties": r}
        for r, g in zip(rows, geometries)
    ]
