"""TECH-22: medallion layer tests — bronze append, silver conform, gold
k-suppression, all on real Delta tables."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from deltalake import DeltaTable

from analytics import gold
from analytics.extract import extract_event
from analytics.layers import BRONZE_SCHEMA, SILVER_SCHEMA, append_bronze, write_silver
from analytics.pseudonym import K_MIN

BASE = datetime(2026, 11, 24, 10, 0, tzinfo=timezone.utc)
CELL = "89589c984c7ffff"


def presence_events(n: int, *, start: datetime = BASE):
    return [
        extract_event(
            "presence_publish",
            {
                "event_id": f"p{i}",
                "occurred_at": (start + timedelta(minutes=i)).isoformat(),
                "cell": CELL,
            },
            account_id=f"user-{i}",
            key="k",
        )
        for i in range(n)
    ]


def test_bronze_append_round_trip(tmp_path):
    events = presence_events(3)
    append_bronze(str(tmp_path), events)
    append_bronze(str(tmp_path), events)  # append-only; duplicates conform away
    table = DeltaTable(f"{tmp_path}/bronze/events").to_pyarrow_table()
    assert table.num_rows == 6
    assert table.schema.field("occurred_at").type == BRONZE_SCHEMA.field("occurred_at").type
    # ARC §6.1: partitioned by date and cell prefix
    from pathlib import Path

    parts = [str(p.relative_to(f"{tmp_path}/bronze/events")) for p in
             Path(f"{tmp_path}/bronze/events").glob("date=*/cell_prefix=*")]
    assert parts, "bronze must be partitioned by date and cell prefix"
    assert all(p.startswith("date=2026-11-24/cell_prefix=8958") for p in parts)


def test_silver_dedupes_by_event_id(tmp_path):
    events = presence_events(3)
    write_silver(str(tmp_path), events + events[:2])  # replay two duplicates
    table = DeltaTable(f"{tmp_path}/silver/events").to_pyarrow_table()
    assert table.num_rows == 3  # one row per business event
    assert table.schema == SILVER_SCHEMA


def test_silver_sorted_deterministically(tmp_path):
    events = presence_events(4)
    write_silver(str(tmp_path), list(reversed(events)))
    rows = DeltaTable(f"{tmp_path}/silver/events").to_pyarrow_table().to_pylist()
    stamps = [r["occurred_at"] for r in rows]
    assert stamps == sorted(stamps)


def test_gold_density_k_floor(tmp_path):
    """SEC-16: a cell-hour with fewer than K_MIN distinct actors must not
    exist in gold at all."""
    below = gold.density_cell_hour(presence_events(K_MIN - 1))
    assert below.num_rows == 0
    at_floor = gold.density_cell_hour(presence_events(K_MIN))
    assert at_floor.num_rows == 1
    row = at_floor.to_pylist()[0]
    assert row["unique_actors"] == K_MIN
    assert row["presence_events"] == K_MIN
    assert row["cell"] == CELL


def test_gold_density_counts_scans():
    events = presence_events(K_MIN)
    events += [
        extract_event(
            "scan",
            {"event_id": f"s{i}", "occurred_at": BASE.isoformat(), "cell": CELL,
             "band": "busy", "result_count": 2},
            account_id=f"user-{i}",
            key="k",
        )
        for i in range(K_MIN)
    ]
    row = gold.density_cell_hour(events).to_pylist()[0]
    assert row["scan_events"] == K_MIN


def test_gold_venue_kpi_and_funnel():
    events = presence_events(K_MIN)
    for i in range(K_MIN):
        events.append(extract_event(
            "offer_transition",
            {"event_id": f"o{i}", "occurred_at": BASE.isoformat(), "cell": CELL,
             "venue_id": "v1", "from_state": "OFFERED", "to_state": "OPEN"},
            account_id=f"user-{i}", key="k"))
        events.append(extract_event(
            "consent_event",
            {"event_id": f"c{i}", "occurred_at": BASE.isoformat(), "cell": CELL,
             "transition": "WAVED->EXPRESSED"},
            account_id=f"user-{i}", key="k"))
    kpi = gold.venue_kpi(events).to_pylist()[0]
    assert kpi["venue_id"] == "v1"
    assert kpi["pairs_opened"] == K_MIN
    funnel = gold.consent_funnel(events).to_pylist()[0]
    assert funnel["transition"] == "WAVED->EXPRESSED"
    assert funnel["events"] == K_MIN


def test_gold_registry_matches_producers():
    """TR-39: the registry names exactly the tables gold.py produces."""
    assert set(gold.GOLD_REGISTRY) == {
        "density_cell_hour", "venue_kpi", "consent_funnel", "cell_attribution",
    }
