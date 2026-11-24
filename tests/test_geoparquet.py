"""TR-43: GeoParquet publication tests."""

from __future__ import annotations

import json

import pyarrow as pa
import pyarrow.parquet as pq
from shapely.wkb import loads as wkb_loads

from analytics.geoparquet import (
    CRS84,
    GEOPARQUET_VERSION,
    cell_polygon,
    geo_metadata,
    write_geoparquet,
)


def sample_table():
    return pa.table(
        {
            "cell": ["89589c984c7ffff", "89589c984dbffff"],
            "presence_events": [40, 17],
        }
    )


def test_cell_polygon_closed_ring():
    poly = cell_polygon("89589c984c7ffff")
    assert poly.geom_type == "Polygon"
    coords = list(poly.exterior.coords)
    assert coords[0] == coords[-1]
    assert len(coords) == 7  # hexagon + closing vertex


def test_geo_metadata_block():
    meta = geo_metadata(["Polygon"], [3.0, 6.0, 3.1, 6.1])
    geo = json.loads(meta[b"geo"])
    assert geo["version"] == GEOPARQUET_VERSION
    assert geo["primary_column"] == "geometry"
    col = geo["columns"]["geometry"]
    assert col["encoding"] == "WKB"
    assert col["crs"] == CRS84
    assert col["edges"] == "spherical"
    assert col["bbox"] == [3.0, 6.0, 3.1, 6.1]


def test_write_round_trip(tmp_path):
    table = sample_table()
    cells = table.column("cell").to_pylist()
    polys = [cell_polygon(c) for c in cells]
    out = tmp_path / "density.parquet"
    write_geoparquet(str(out), table, polys)

    pf = pq.ParquetFile(out)
    geo = json.loads(pf.schema_arrow.metadata[b"geo"])
    assert geo["primary_column"] == "geometry"
    assert geo["columns"]["geometry"]["geometry_types"] == ["Polygon"]
    minx, miny, maxx, maxy = geo["columns"]["geometry"]["bbox"]
    for g in polys:
        assert minx <= g.bounds[0] and miny <= g.bounds[1]
        assert maxx >= g.bounds[2] and maxy >= g.bounds[3]

    back = pq.read_table(out)
    assert back.num_rows == 2
    wkbs = back.column("geometry").to_pylist()
    for original, wkb in zip(polys, wkbs):
        assert wkb_loads(wkb).equals_exact(original, 1e-12)


def test_row_geometry_count_mismatch_rejected(tmp_path):
    import pytest

    with pytest.raises(ValueError):
        write_geoparquet(str(tmp_path / "x.parquet"), sample_table(), [])
