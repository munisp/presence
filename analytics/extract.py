"""SEC-16 / FR-61: the production-boundary extractor.

Events cross from production into the lakehouse through one function:
extract_event. It

  1. substitutes the account id with the rotating-salt pseudonym
     (SEC-16, analytics/pseudonym.py) — the raw id is never returned;
  2. keeps only allowlisted fields (FR-61) — everything else is dropped;
  3. carries the H3 cell as the only location signal (FR-61) and derives the
     bronze partition prefix from it (ARC-002 §6.1: partitioned by date and
     cell prefix).

In the P1 wiring the extractor runs inside the production environment against
the Kafka event bus; here it is a pure function over event dicts so the
contract is testable and the boundary is unmissable. Python never writes to
the OLTP store (ARC-002 §4.3).
"""

from __future__ import annotations

from datetime import datetime, timezone

from .pseudonym import pseudonym
from .schemas import COMMON_FIELDS, DENYLIST, EVENT_KINDS, KIND_FIELDS, EventRejected, validate_event

# ARC-002 §6.1: bronze partitions by date and cell prefix.
CELL_PREFIX_LEN = 4


def _parse_time(value: object) -> datetime:
    if isinstance(value, datetime):
        dt = value
    else:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def extract_event(
    kind: str,
    raw: dict,
    *,
    account_id: str | None,
    key: str | None = None,
) -> dict:
    """Map one production event to its bronze row.

    `raw` is the event exactly as the emitting service produced it; only the
    allowlisted fields survive. `account_id` (when the kind carries an actor)
    is pseudonymised and never copied through.
    """
    if kind not in EVENT_KINDS:
        raise EventRejected(f"unknown event kind: {kind!r}")
    if not isinstance(raw, dict):
        raise EventRejected("event must be a mapping")

    occurred = _parse_time(raw.get("occurred_at"))
    event_id = raw.get("event_id")
    if not event_id or not isinstance(event_id, str):
        raise EventRejected("missing event_id")

    row: dict[str, object] = {
        "event_id": event_id,
        "event_kind": kind,
        "occurred_at": occurred,
        "cell": None,
        "actor_pseudo": None,
        "cell_prefix": None,
    }

    cell = raw.get("cell")
    if cell is not None:
        cell = str(cell).lower()
        row["cell"] = cell
        row["cell_prefix"] = cell[:CELL_PREFIX_LEN]

    if account_id is not None:
        row["actor_pseudo"] = pseudonym(account_id, occurred, key)

    for field, value in raw.items():
        if field in DENYLIST:
            continue  # identifiers and coordinates are dropped, not copied
        if field in KIND_FIELDS[kind]:
            row[field] = value
        elif field in ("event_id", "occurred_at", "cell"):
            continue
        # anything else is dropped: allowlist, not blocklist (FR-61)

    validate_event(kind, row)
    return row
