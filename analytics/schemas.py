"""FR-61: event contracts for the analytics pipeline.

The pipeline MUST exclude direct identifiers and MUST aggregate any
location-derived event to at least cell resolution before storage. That is
enforced structurally, not by convention: every bronze event is validated
against a per-kind ALLOWLIST, and a defence-in-depth DENYLIST rejects
identifier- or coordinate-shaped fields even if an allowlist is ever edited
carelessly. Validation is fail-closed — an unknown kind or an unexpected
field rejects the event.

The six bronze event kinds are ARC-002 §6.1: presence publish, scan, offer
transition, consent event, room note, report.

Allowed location: the H3 cell id only — cell resolution is the floor. Raw
coordinates, coordinate-shaped fields and anything finer than a cell are
denied everywhere.
"""

from __future__ import annotations

import re
from datetime import datetime

EVENT_KINDS = (
    "presence_publish",
    "scan",
    "offer_transition",
    "consent_event",
    "room_note",
    "report",
)

H3_CELL_PATTERN = re.compile(r"^[0-9a-f]{15}$")

# Fields every kind may carry (post-extraction; actor_pseudo and cell_prefix
# are added by the extractor, never by the source).
COMMON_FIELDS = frozenset({
    "event_id",
    "event_kind",
    "occurred_at",
    "cell",
    "actor_pseudo",
    "cell_prefix",
})

# Per-kind extras. Venues are public entities, so venue/floor ids are not
# personal identifiers and may flow. Report events carry counts and governed
# reason codes only — never reporter/reported identities.
KIND_FIELDS: dict[str, frozenset[str]] = {
    "presence_publish": frozenset({"venue_id", "floor_id", "attributed"}),
    "scan": frozenset({"venue_id", "band", "result_count"}),
    "offer_transition": frozenset({"venue_id", "from_state", "to_state"}),
    "consent_event": frozenset({"transition"}),
    "room_note": frozenset({"venue_id", "floor_id"}),
    "report": frozenset({"venue_id", "reason_code", "outcome"}),
}

# Defence in depth (SEC-16/FR-61): these keys are rejected wherever they
# appear, even if a future edit adds them to an allowlist by mistake.
DENYLIST = frozenset({
    "user_id", "account_id", "handle", "display_handle", "phone", "phone_hash",
    "email", "device_id", "attestation_key", "attestation_key_hash", "ip",
    "ip_address", "session_id", "pair_id",
    "lat", "lon", "lng", "latitude", "longitude", "coords", "coordinates",
    "geometry", "location",
    "envelope", "ciphertext", "content", "body", "message", "text",
    "reporter_id", "reported_id", "subject_id", "actor_id",
})


class EventRejected(ValueError):
    """An event failed the FR-61 contract."""


def validate_event(kind: str, event: dict) -> None:
    """Fail-closed validation of one post-extraction event."""
    if kind not in EVENT_KINDS:
        raise EventRejected(f"unknown event kind: {kind!r}")
    if not isinstance(event, dict):
        raise EventRejected("event must be a mapping")
    allowed = COMMON_FIELDS | KIND_FIELDS[kind]
    for field in event:
        if field in DENYLIST:
            raise EventRejected(f"denied field: {field!r}")
        if field not in allowed:
            raise EventRejected(f"field {field!r} is not allowlisted for {kind}")
    for required in ("event_id", "occurred_at"):
        if required not in event:
            raise EventRejected(f"missing field: {required!r}")
    cell = event.get("cell")
    if cell is not None and not H3_CELL_PATTERN.match(str(cell)):
        raise EventRejected("cell must be a 15-character lowercase H3 index")
    occurred = event["occurred_at"]
    if isinstance(occurred, datetime):
        return
    try:
        datetime.fromisoformat(str(occurred).replace("Z", "+00:00"))
    except ValueError as exc:
        raise EventRejected("occurred_at must be ISO-8601") from exc
