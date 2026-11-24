"""End-to-end lakehouse run: extract -> bronze -> silver -> gold -> publish.

One run over a batch of raw production events:

  1. extract every event at the production boundary (FR-61/SEC-16);
  2. append to bronze (90-day, date + cell-prefix partitioned);
  3. conform to silver (dedupe, validate, month-partitioned, 25-month);
  4. build the gold products with the k floor applied;
  5. compute TR-38 attribution from the venue geometry feed and emit the
     publication bundle for the operational store;
  6. export geospatial gold as GeoParquet (TR-43);
  7. prune expired partitions (NFR-23).

Returns a manifest describing the run — counts, cutoffs, run id.
"""

from __future__ import annotations

from datetime import datetime, timezone

from deltalake import write_deltalake

from . import attribution, geoparquet, gold, retention
from .extract import extract_event
from .layers import append_bronze, write_silver


def run(
    root: str,
    raw_events: list[tuple[str, dict, str | None]],
    geometries: list[attribution.VenueGeometry],
    *,
    key: str | None = None,
    now: datetime | None = None,
) -> dict:
    """raw_events: (kind, raw payload, account_id or None) triples."""
    at = now or datetime.now(timezone.utc)

    extracted = [extract_event(kind, raw, account_id=account_id, key=key)
                 for kind, raw, account_id in raw_events]

    append_bronze(root, extracted)
    write_silver(root, extracted)

    density = gold.density_cell_hour(extracted)
    kpis = gold.venue_kpi(extracted)
    funnel = gold.consent_funnel(extracted)
    for name, table in (
        ("density_cell_hour", density),
        ("venue_kpi", kpis),
        ("consent_funnel", funnel),
    ):
        if table.num_rows:
            write_deltalake(f"{root}/gold/{name}", table, mode="append", partition_by=["month"])

    rows = attribution.compute_attribution(geometries)
    bundle = attribution.publication_bundle(rows, at)

    # TR-43: geospatial gold publishes as GeoParquet.
    if density.num_rows:
        base, polys = geoparquet.density_geoparquet_rows(density)
        geoparquet.write_geoparquet(f"{root}/gold/density_cell_hour.parquet", base, polys)

    cutoffs = retention.enforce(root, at)
    return {
        "run_id": bundle["run_id"],
        "events": len(extracted),
        "gold_rows": {
            "density_cell_hour": density.num_rows,
            "venue_kpi": kpis.num_rows,
            "consent_funnel": funnel.num_rows,
        },
        "attribution_rows": len(rows),
        "retention_cutoffs": cutoffs,
    }
