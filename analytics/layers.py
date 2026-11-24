"""TECH-22 / ARC-002 §6.1: the Delta-on-Parquet medallion layers.

bronze — raw events exactly as emitted post-extraction, append-only,
         partitioned by date and cell prefix, 90-day retention.
silver — deduplicated, validated, cell-normalised, one row per business
         event, partitioned by month, 25-month retention (NFR-23).
gold   — k-suppressed analytical products, partitioned by month, 25-month
         retention (NFR-23 caps the ARC's "indefinite, aggregated" wording).

Delta Lake gives the ACID + time-travel semantics the ARC mandates; Parquet
underneath keeps every layer readable without a live database (TR-43). The
P2 engines (Flink streaming ingest, Spark + Sedona batch joins) execute these
same layer definitions at scale when the phase gate opens — the semantics
here are the contract, not the engine.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pyarrow as pa
from deltalake import write_deltalake

from .schemas import validate_event

BRONZE = "bronze/events"
SILVER = "silver/events"

BRONZE_SCHEMA = pa.schema(
    [
        ("event_id", pa.string()),
        ("event_kind", pa.string()),
        ("occurred_at", pa.timestamp("us", tz="UTC")),
        ("date", pa.string()),          # YYYY-MM-DD partition
        ("cell", pa.string()),          # h3 index or null
        ("cell_prefix", pa.string()),   # first 4 chars — partition
        ("actor_pseudo", pa.string()),  # rotating-salt pseudonym or null
        ("payload", pa.string()),       # JSON of the kind-specific extras
    ]
)

SILVER_SCHEMA = pa.schema(
    [
        ("event_id", pa.string()),
        ("event_kind", pa.string()),
        ("occurred_at", pa.timestamp("us", tz="UTC")),
        ("month", pa.string()),         # YYYY-MM partition
        ("cell", pa.string()),
        ("actor_pseudo", pa.string()),
        ("venue_id", pa.string()),
        ("floor_id", pa.string()),
        ("payload", pa.string()),
    ]
)


def _as_utc(value: object) -> datetime:
    if isinstance(value, datetime):
        dt = value
    else:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def bronze_rows(events: list[dict]) -> pa.Table:
    """Project extracted events onto the bronze schema (partition cols added)."""
    cols: dict[str, list] = {name: [] for name in BRONZE_SCHEMA.names}
    for e in events:
        occurred = _as_utc(e["occurred_at"])
        known = set(BRONZE_SCHEMA.names) | {"venue_id", "floor_id"}
        cols["event_id"].append(e["event_id"])
        cols["event_kind"].append(e["event_kind"])
        cols["occurred_at"].append(occurred)
        cols["date"].append(occurred.strftime("%Y-%m-%d"))
        cols["cell"].append(e.get("cell"))
        cols["cell_prefix"].append(e.get("cell_prefix"))
        cols["actor_pseudo"].append(e.get("actor_pseudo"))
        cols["payload"].append(
            json.dumps({k: v for k, v in e.items() if k not in known}, sort_keys=True)
        )
    return pa.Table.from_pydict(cols, schema=BRONZE_SCHEMA)


def append_bronze(root: str, events: list[dict]) -> None:
    """Append extracted events to the bronze layer (idempotent at the sink:
    silver dedupes by event_id on conform)."""
    if not events:
        return
    write_deltalake(
        f"{root}/{BRONZE}",
        bronze_rows(events),
        mode="append",
        partition_by=["date", "cell_prefix"],
    )


def conform_silver(events: list[dict]) -> pa.Table:
    """Bronze -> silver: dedupe by event_id (first wins), re-validate every
    row against the FR-61 contract, normalise, and emit one row per business
    event in deterministic order (occurred_at, event_id)."""
    seen: set[str] = set()
    rows: list[dict] = []
    for e in events:
        eid = e["event_id"]
        if eid in seen:
            continue
        seen.add(eid)
        validate_event(e["event_kind"], e)
        occurred = _as_utc(e["occurred_at"])
        known = set(SILVER_SCHEMA.names) | {"date", "cell_prefix"}
        rows.append(
            {
                "event_id": eid,
                "event_kind": e["event_kind"],
                "occurred_at": occurred,
                "month": occurred.strftime("%Y-%m"),
                "cell": e.get("cell"),
                "actor_pseudo": e.get("actor_pseudo"),
                "venue_id": e.get("venue_id"),
                "floor_id": e.get("floor_id"),
                "payload": json.dumps(
                    {k: v for k, v in e.items() if k not in known}, sort_keys=True
                ),
            }
        )
    rows.sort(key=lambda r: (r["occurred_at"], r["event_id"]))
    cols: dict[str, list] = {name: [] for name in SILVER_SCHEMA.names}
    for r in rows:
        for name in SILVER_SCHEMA.names:
            cols[name].append(r[name])
    return pa.Table.from_pydict(cols, schema=SILVER_SCHEMA)


def write_silver(root: str, events: list[dict]) -> None:
    if not events:
        return
    write_deltalake(
        f"{root}/{SILVER}",
        conform_silver(events),
        mode="append",
        partition_by=["month"],
    )
