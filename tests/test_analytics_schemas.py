"""FR-61: extraction contract tests — identifier exclusion and the
cell-resolution floor are structural, not conventional."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from analytics.extract import CELL_PREFIX_LEN, extract_event
from analytics.schemas import DENYLIST, EVENT_KINDS, EventRejected, validate_event

AT = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)
CELL = "89589c984c7ffff"


def raw(**extra):
    base = {"event_id": "e1", "occurred_at": AT.isoformat(), "cell": CELL}
    base.update(extra)
    return base


def test_all_six_arc_kinds_accepted():
    for kind in EVENT_KINDS:
        row = extract_event(kind, raw(), account_id="u1", key="k")
        assert row["event_kind"] == kind


def test_unknown_kind_rejected():
    with pytest.raises(EventRejected):
        extract_event("message_content", raw(), account_id="u1")


@pytest.mark.parametrize(
    "field",
    ["user_id", "handle", "phone", "phone_hash", "email", "device_id",
     "attestation_key", "ip", "session_id", "pair_id",
     "reporter_id", "reported_id"],
)
def test_direct_identifiers_never_cross(field):
    """FR-61: direct identifiers are dropped at the boundary and can never
    appear in a bronze row — even when the source event carries them."""
    row = extract_event("scan", raw(**{field: "x", "band": "busy"}), account_id="u1", key="k")
    assert field not in row
    assert "x" not in row.values()


@pytest.mark.parametrize("field", ["lat", "lon", "latitude", "longitude", "coordinates"])
def test_coordinates_never_cross(field):
    """FR-61: location-derived events are aggregated to at least cell
    resolution before storage — coordinate fields are dropped wholesale."""
    row = extract_event("presence_publish", raw(**{field: 6.5}), account_id="u1", key="k")
    assert field not in row
    assert row["cell"] == CELL  # the cell is the only location signal


def test_message_content_never_crosses():
    row = extract_event("room_note", raw(envelope="dGV4dA==", venue_id="v"), account_id=None)
    assert "envelope" not in row
    assert row["venue_id"] == "v"


def test_actor_pseudonymised_not_copied():
    row = extract_event("scan", raw(), account_id="u-secret", key="k")
    assert row["actor_pseudo"] is not None
    assert row["actor_pseudo"] != "u-secret"
    assert "u-secret" not in str(row)


def test_cell_prefix_partition_derived():
    row = extract_event("scan", raw(), account_id=None)
    assert row["cell_prefix"] == CELL[:CELL_PREFIX_LEN]


def test_validate_rejects_denylist_even_if_allowlisted():
    """Defence in depth: a denied field is rejected by validate_event even if
    a careless edit were to add it to an allowlist."""
    assert "user_id" in DENYLIST
    with pytest.raises(EventRejected):
        validate_event("scan", {"event_id": "e", "occurred_at": AT.isoformat(), "user_id": "u"})


def test_validate_rejects_unexpected_field():
    with pytest.raises(EventRejected):
        validate_event("scan", {"event_id": "e", "occurred_at": AT.isoformat(), "surprise": 1})


def test_validate_rejects_bad_cell():
    with pytest.raises(EventRejected):
        validate_event("scan", {"event_id": "e", "occurred_at": AT.isoformat(), "cell": "XYZ"})


def test_validate_rejects_bad_time():
    with pytest.raises(EventRejected):
        validate_event("scan", {"event_id": "e", "occurred_at": "not-a-time"})


def test_missing_event_id_rejected():
    with pytest.raises(EventRejected):
        extract_event("scan", {"occurred_at": AT.isoformat()}, account_id=None)
