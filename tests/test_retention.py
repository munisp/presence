"""NFR-23: retention enforcement tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from deltalake import DeltaTable

from analytics import retention
from analytics.extract import extract_event
from analytics.layers import append_bronze, write_silver
from analytics.retention import (
    BRONZE_RETENTION_DAYS,
    GOLD_RETENTION_MONTHS,
    SILVER_RETENTION_MONTHS,
    add_months,
    enforce,
    partition_cutoffs,
)

NOW = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)
CELL = "89589c984c7ffff"


def event_at(dt: datetime, eid: str):
    return extract_event(
        "presence_publish",
        {"event_id": eid, "occurred_at": dt.isoformat(), "cell": CELL},
        account_id="u1",
        key="k",
    )


def test_horizons():
    assert BRONZE_RETENTION_DAYS == 90          # ARC §6.1
    assert SILVER_RETENTION_MONTHS == 25        # NFR-23
    assert GOLD_RETENTION_MONTHS == 25          # NFR-23 caps ARC "indefinite"


def test_add_months():
    assert add_months("2026-11", -24) == "2024-11"
    assert add_months("2026-01", -1) == "2025-12"
    assert add_months("2024-11", 25) == "2026-12"


def test_partition_cutoffs():
    cutoffs = partition_cutoffs(NOW)
    assert cutoffs["bronze_min_date"] == "2026-08-26"  # 2026-11-24 - 90 days
    # 25 months inclusive: current month + 24 back
    assert cutoffs["silver_min_month"] == "2024-11"
    assert cutoffs["gold_min_month"] == "2024-11"


def test_enforce_prunes_old_bronze(tmp_path):
    old = event_at(NOW - timedelta(days=91), "old")
    fresh = event_at(NOW - timedelta(days=10), "fresh")
    append_bronze(str(tmp_path), [old, fresh])
    cutoffs = enforce(str(tmp_path), NOW)
    table = DeltaTable(f"{tmp_path}/bronze/events").to_pyarrow_table()
    ids = set(table.column("event_id").to_pylist())
    assert ids == {"fresh"}
    assert cutoffs["bronze_min_date"] == "2026-08-26"


def test_enforce_keeps_boundary_bronze(tmp_path):
    boundary = event_at(NOW - timedelta(days=90), "boundary")
    append_bronze(str(tmp_path), [boundary])
    enforce(str(tmp_path), NOW)
    table = DeltaTable(f"{tmp_path}/bronze/events").to_pyarrow_table()
    assert table.num_rows == 1  # the cutoff day itself is kept (inclusive)


def test_enforce_prunes_old_silver(tmp_path):
    expired = event_at(datetime(2024, 10, 31, 23, 0, tzinfo=timezone.utc), "expired")
    kept = event_at(datetime(2024, 11, 1, 0, 0, tzinfo=timezone.utc), "kept")
    write_silver(str(tmp_path), [expired, kept])
    enforce(str(tmp_path), NOW)
    table = DeltaTable(f"{tmp_path}/silver/events").to_pyarrow_table()
    ids = set(table.column("event_id").to_pylist())
    assert ids == {"kept"}  # month 2024-10 pruned, 2024-11 kept (25-month window)


def test_enforce_on_empty_lake_is_noop(tmp_path):
    cutoffs = enforce(str(tmp_path), NOW)
    assert "bronze_min_date" in cutoffs
