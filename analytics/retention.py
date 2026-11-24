"""NFR-23 / ARC-002 §6.1: retention enforcement across the medallion layers.

  bronze — 90 days   (raw events, ARC §6.1)
  silver — 25 months (pseudonymised business events, ARC §6.1)
  gold   — 25 months (NFR-23 caps the ARC's "indefinite, aggregated" wording:
                     the SRS retention schedule governs every analytics store)

Enforcement is partition pruning: bronze partitions are date + cell prefix,
silver and gold are monthly. A partition older than its layer's horizon is
deleted with a Delta DELETE; the helper partition_cutoffs is pure so the
calendar math is unit-tested without a lake.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from deltalake import DeltaTable

BRONZE_RETENTION_DAYS = 90
SILVER_RETENTION_MONTHS = 25  # NFR-23
GOLD_RETENTION_MONTHS = 25    # NFR-23 caps ARC "indefinite"


def _today(now: datetime | None) -> date:
    if now is None:
        return datetime.now(timezone.utc).date()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(timezone.utc).date()


def add_months(month: str, delta: int) -> str:
    """Shift a YYYY-MM month by delta months."""
    year, mon = int(month[:4]), int(month[5:7])
    total = (year * 12 + (mon - 1)) + delta
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def partition_cutoffs(now: datetime | None = None) -> dict[str, str]:
    """The oldest partition each layer keeps, inclusive.

    bronze: keep dates >= today - 90 days.
    silver/gold: keep the current month and the 24 before it — 25 months of
    data at any moment (NFR-23).
    """
    today = _today(now)
    return {
        "bronze_min_date": (today - timedelta(days=BRONZE_RETENTION_DAYS)).isoformat(),
        "silver_min_month": add_months(today.strftime("%Y-%m"), -(SILVER_RETENTION_MONTHS - 1)),
        "gold_min_month": add_months(today.strftime("%Y-%m"), -(GOLD_RETENTION_MONTHS - 1)),
    }


def _prune(path: str, predicate: str) -> None:
    try:
        table = DeltaTable(path)
    except Exception:
        return  # layer not materialised yet — nothing to prune
    table.delete(predicate)


def enforce(root: str, now: datetime | None = None) -> dict[str, str]:
    """Delete expired partitions in every layer that exists under `root`.
    Returns the cutoffs applied (for the run manifest and tests)."""
    cutoffs = partition_cutoffs(now)
    _prune(f"{root}/bronze/events", f"date < '{cutoffs['bronze_min_date']}'")
    _prune(f"{root}/silver/events", f"month < '{cutoffs['silver_min_month']}'")
    for gold_table in ("density_cell_hour", "venue_kpi", "consent_funnel", "cell_attribution"):
        _prune(f"{root}/gold/{gold_table}", f"month < '{cutoffs['gold_min_month']}'")
    return cutoffs
