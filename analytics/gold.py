"""Gold analytical products (ARC-002 §6.1) with the SEC-16 k floor applied.

Every gold table is k-suppressed: a cell-hour, venue-day or funnel step with
fewer than K_MIN distinct actors is omitted entirely, so re-identification at
cell level below the k floor is structurally impossible (SEC-16).

Each product registers itself in GOLD_REGISTRY — name, grain, owner,
freshness SLO, retention — and scripts/check_gold_catalogue.py fails the
build if any gold table is missing from docs/analytics/catalogue.yaml
(TR-39: registered before use by any product surface).
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime

import pyarrow as pa

from .pseudonym import K_MIN

# TR-39 registry — the machine-checkable half of the catalogue contract.
# check_gold_catalogue.py requires an exact match against catalogue.yaml.
GOLD_REGISTRY: dict[str, dict[str, object]] = {
    "density_cell_hour": {
        "grain": "one row per (cell, hour) — presence and scan intensity",
        "owner": "venue-analytics",
        "freshness_slo": "T+1 day",
        "retention_months": 25,
    },
    "venue_kpi": {
        "grain": "one row per (venue, date) — presence, scans, offers, funnel",
        "owner": "venue-analytics",
        "freshness_slo": "T+1 day",
        "retention_months": 25,
    },
    "consent_funnel": {
        "grain": "one row per (date, transition) — consent state volumes",
        "owner": "product-analytics",
        "freshness_slo": "T+1 day",
        "retention_months": 25,
    },
    "cell_attribution": {
        "grain": "one row per H3 cell — venue/floor scope (TR-38)",
        "owner": "venue-ops",
        "freshness_slo": "T+1 day after any geometry publication",
        "retention_months": 25,
    },
}

DENSITY_SCHEMA = pa.schema(
    [
        ("cell", pa.string()),
        ("date", pa.string()),
        ("hour", pa.int32()),
        ("month", pa.string()),
        ("presence_events", pa.int64()),
        ("scan_events", pa.int64()),
        ("unique_actors", pa.int64()),
    ]
)

VENUE_KPI_SCHEMA = pa.schema(
    [
        ("venue_id", pa.string()),
        ("date", pa.string()),
        ("month", pa.string()),
        ("presence_events", pa.int64()),
        ("scan_events", pa.int64()),
        ("offers_made", pa.int64()),
        ("pairs_opened", pa.int64()),
        ("unique_actors", pa.int64()),
    ]
)

FUNNEL_SCHEMA = pa.schema(
    [
        ("date", pa.string()),
        ("month", pa.string()),
        ("transition", pa.string()),
        ("events", pa.int64()),
        ("unique_actors", pa.int64()),
    ]
)


def _utc(value: object) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _payload(event: dict) -> dict:
    raw = event.get("payload")
    if isinstance(raw, str):
        return json.loads(raw)
    return raw if isinstance(raw, dict) else {}


def density_cell_hour(events: list[dict], k: int = K_MIN) -> pa.Table:
    """Cell-hour density surface (ARC §6.2) — feeds the FR-78 halo and the
    TR-14 crowd threshold calibration. Rows below the k floor are omitted."""
    buckets: dict[tuple[str, str, int], dict[str, int] | set] = {}
    actors: dict[tuple[str, str, int], set[str]] = defaultdict(set)
    for e in events:
        cell = e.get("cell")
        if not cell:
            continue
        at = _utc(e["occurred_at"])
        key = (cell, at.strftime("%Y-%m-%d"), at.hour)
        bucket = buckets.setdefault(key, {"presence": 0, "scan": 0})
        if e["event_kind"] == "presence_publish":
            bucket["presence"] += 1
        elif e["event_kind"] == "scan":
            bucket["scan"] += 1
        if e.get("actor_pseudo"):
            actors[key].add(e["actor_pseudo"])

    cols: dict[str, list] = {name: [] for name in DENSITY_SCHEMA.names}
    for (cell, date, hour) in sorted(buckets):
        n_actors = len(actors[(cell, date, hour)])
        if n_actors < k:
            continue  # SEC-16 k floor — the row must not exist at all
        b = buckets[(cell, date, hour)]
        cols["cell"].append(cell)
        cols["date"].append(date)
        cols["hour"].append(hour)
        cols["month"].append(date[:7])
        cols["presence_events"].append(b["presence"])
        cols["scan_events"].append(b["scan"])
        cols["unique_actors"].append(n_actors)
    return pa.Table.from_pydict(cols, schema=DENSITY_SCHEMA)


def venue_kpi(events: list[dict], k: int = K_MIN) -> pa.Table:
    """Venue KPI mart (ARC §6.1 gold). Venue ids are public entities; actor
    counts are k-suppressed."""
    buckets: dict[tuple[str, str], dict[str, int]] = {}
    actors: dict[tuple[str, str], set[str]] = defaultdict(set)
    for e in events:
        venue = e.get("venue_id") or _payload(e).get("venue_id")
        if not venue:
            continue
        date = _utc(e["occurred_at"]).strftime("%Y-%m-%d")
        key = (str(venue), date)
        bucket = buckets.setdefault(
            key, {"presence": 0, "scan": 0, "offers": 0, "pairs": 0}
        )
        if e["event_kind"] == "presence_publish":
            bucket["presence"] += 1
        elif e["event_kind"] == "scan":
            bucket["scan"] += 1
        elif e["event_kind"] == "offer_transition":
            bucket["offers"] += 1
            to_state = e.get("to_state") or _payload(e).get("to_state")
            if to_state == "OPEN":
                bucket["pairs"] += 1
        if e.get("actor_pseudo"):
            actors[key].add(e["actor_pseudo"])

    cols: dict[str, list] = {name: [] for name in VENUE_KPI_SCHEMA.names}
    for (venue, date) in sorted(buckets):
        n_actors = len(actors[(venue, date)])
        if n_actors < k:
            continue
        b = buckets[(venue, date)]
        cols["venue_id"].append(venue)
        cols["date"].append(date)
        cols["month"].append(date[:7])
        cols["presence_events"].append(b["presence"])
        cols["scan_events"].append(b["scan"])
        cols["offers_made"].append(b["offers"])
        cols["pairs_opened"].append(b["pairs"])
        cols["unique_actors"].append(n_actors)
    return pa.Table.from_pydict(cols, schema=VENUE_KPI_SCHEMA)


def consent_funnel(events: list[dict], k: int = K_MIN) -> pa.Table:
    """Conversion funnel over consent transitions (ARC §6.1 gold)."""
    buckets: dict[tuple[str, str], int] = defaultdict(int)
    actors: dict[tuple[str, str], set[str]] = defaultdict(set)
    for e in events:
        if e["event_kind"] != "consent_event":
            continue
        transition = str(_payload(e).get("transition") or e.get("transition") or "")
        if not transition:
            continue
        date = _utc(e["occurred_at"]).strftime("%Y-%m-%d")
        key = (date, transition)
        buckets[key] += 1
        if e.get("actor_pseudo"):
            actors[key].add(e["actor_pseudo"])

    cols: dict[str, list] = {name: [] for name in FUNNEL_SCHEMA.names}
    for (date, transition) in sorted(buckets):
        n_actors = len(actors[(date, transition)])
        if n_actors < k:
            continue
        cols["date"].append(date)
        cols["month"].append(date[:7])
        cols["transition"].append(transition)
        cols["events"].append(buckets[(date, transition)])
        cols["unique_actors"].append(n_actors)
    return pa.Table.from_pydict(cols, schema=FUNNEL_SCHEMA)
