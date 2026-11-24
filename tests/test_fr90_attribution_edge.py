"""FR-90: edge wiring invariants — polygon precedence, version-checked
lookup, and the pipeline end-to-end run."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRESENCE = (ROOT / "services" / "edge" / "src" / "routes" / "presence.ts").read_text()
LOOKUP = (ROOT / "services" / "edge" / "src" / "attribution.ts").read_text()


def test_lookup_is_version_checked():
    """A stale attribution row (geometry revised since publication) is never
    honoured — the join demands the live geofence_version."""
    assert "v.geofence_version = ca.geometry_version" in LOOKUP


def test_lookup_is_primary_key_not_spatial():
    """TR-38: no spatial function is evaluated at request time."""
    assert "WHERE ca.cell = $1" in LOOKUP
    assert not re.search(r"ST_|Intersects|Contains", LOOKUP)


def test_lookup_refuses_coarse_cells():
    """A cell coarser than the attribution grain cannot claim a polygon."""
    assert "res < ATTRIBUTION_RESOLUTION" in LOOKUP
    assert "return null" in LOOKUP


def test_presence_route_applies_polygon_precedence():
    """FR-90: with no explicit venue claim, the polygon attributes the
    presence; an explicit claim (check-in path) is left untouched."""
    block = PRESENCE[PRESENCE.index("FR-90/TR-38"):]
    block = block[: block.index("// TR-12/14")]
    assert "venueId === null" in block
    assert "lookupAttribution(ctx, cell)" in block
    assert "venueId = attributed.venueId" in block
    assert "floorId = attributed.floorId" in block


def test_attribution_runs_before_resolution_ladder():
    """The lookup must precede the TR-12/14 coarsening so the live venue
    density feeds the ladder with the attributed venue."""
    assert PRESENCE.index("lookupAttribution(ctx, cell)") < PRESENCE.index(
        "const live = venueId"
    )


def test_presence_response_contract():
    """The publish response carries exactly the contract fields: ok, cell,
    ttl, sessionId and — since batch 27 (FR-43) — the event the presence is
    attributable to, null when the venue hosts no live event. The FR-90
    analytics attribution itself remains silent (no analytics field leaks)."""
    m = re.search(r"return reply\.send\(\{(.*?)\}\);", PRESENCE, re.S)
    assert m, "publish reply not found"
    body = re.sub(r"^\s*//.*$", "", m.group(1), flags=re.M)  # drop comments
    fields = re.findall(r"^\s*(\w+)\s*[:,]", body, re.M)
    assert fields == ["ok", "cell", "ttl", "sessionId", "event"], fields
    assert "event: eventId ? { eventId, name: eventName } : null" in m.group(1)


# --- pipeline end-to-end ------------------------------------------------------


def test_pipeline_end_to_end(tmp_path):
    import h3

    from analytics import attribution
    from analytics.pipeline import run

    cell = h3.latlng_to_cell(6.521, 3.371, 9)
    base = datetime(2026, 11, 24, 10, 0, tzinfo=timezone.utc)
    events = []
    for i in range(12):  # above the k floor
        events.append((
            "presence_publish",
            {
                "event_id": f"p{i}",
                "occurred_at": (base + timedelta(minutes=i)).isoformat(),
                "cell": cell,
            },
            f"user-{i}",
        ))
    geoms = [
        attribution.VenueGeometry(
            "11111111-1111-1111-1111-111111111111",
            None,
            ((3.370, 6.520), (3.370, 6.530), (3.380, 6.530), (3.380, 6.520), (3.370, 6.520)),
            1,
        )
    ]
    manifest = run(str(tmp_path), events, geoms, key="k", now=base)
    assert manifest["events"] == 12
    assert manifest["gold_rows"]["density_cell_hour"] == 1
    assert manifest["attribution_rows"] > 0
    assert (tmp_path / "gold" / "density_cell_hour.parquet").exists()
    assert (tmp_path / "bronze" / "events").exists()
    assert (tmp_path / "silver" / "events").exists()
