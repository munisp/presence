"""TR-38 / FR-90: attribution spatial join, publication bundle, and the
migration + edge constants that complete the loop."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import h3

from analytics import attribution
from analytics.attribution import (
    ATTRIBUTION_RESOLUTION,
    VenueGeometry,
    compute_attribution,
    publication_bundle,
    run_id_for,
)

ROOT = Path(__file__).resolve().parent.parent
AT = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)

# ~1.1 km square in Lagos — comfortably contains res-9 cell centroids
LAGOS_POLY = ((3.370, 6.520), (3.370, 6.530), (3.380, 6.530), (3.380, 6.520), (3.370, 6.520))
VENUE = "11111111-1111-1111-1111-111111111111"


def geom(floor=None, version=1):
    return VenueGeometry(VENUE, floor, LAGOS_POLY, version)


def test_resolution_pinned_to_edge():
    """The governed attribution resolution is one constant, mirrored in the
    edge lookup."""
    src = (ROOT / "services" / "edge" / "src" / "attribution.ts").read_text()
    m = re.search(r"ATTRIBUTION_RESOLUTION\s*=\s*(\d+)", src)
    assert m and int(m.group(1)) == ATTRIBUTION_RESOLUTION == 9


def test_centroid_contained_cells_attribute():
    rows = compute_attribution([geom()])
    assert rows, "the polygon covering must claim cells"
    for r in rows:
        lat, lng = h3.cell_to_latlng(r.cell)
        # centroid containment is the H3 polygon_to_cells semantic
        assert 3.370 <= lng <= 3.380 and 6.520 <= lat <= 6.530
        assert r.venue_id == VENUE and r.geometry_version == 1
        assert h3.get_resolution(r.cell) == ATTRIBUTION_RESOLUTION


def test_far_cells_not_attributed():
    rows = compute_attribution([geom()])
    far = h3.latlng_to_cell(6.6, 3.5, ATTRIBUTION_RESOLUTION)
    assert all(r.cell != far for r in rows)


def test_deterministic_output():
    a = compute_attribution([geom()])
    b = compute_attribution([geom()])
    assert a == b


def test_overlap_resolves_deterministically():
    """A contested boundary cell is claimed by exactly one geometry, stable
    run-over-run."""
    other = VenueGeometry(
        "22222222-2222-2222-2222-222222222222", None, LAGOS_POLY, 1
    )
    rows = compute_attribution([other, geom()])  # reverse insertion order
    rows2 = compute_attribution([geom(), other])
    assert rows == rows2
    cells = [r.cell for r in rows]
    assert len(cells) == len(set(cells))  # one claimant per cell


def test_floor_targeting():
    rows = compute_attribution([geom(floor="L1", version=3)])
    assert all(r.floor_id == "L1" and r.geometry_version == 3 for r in rows)


def test_run_id_deterministic_and_content_keyed():
    rows = compute_attribution([geom()])
    assert run_id_for(rows, AT) == run_id_for(rows, AT)
    assert run_id_for(rows, AT) != run_id_for(rows + rows[:1], AT)


def test_publication_bundle_shape():
    rows = compute_attribution([geom()])
    bundle = publication_bundle(rows, AT)
    assert bundle["rows"] == len(rows)
    sql = bundle["sql"]
    assert "SELECT publish_cell_attribution(" in sql
    assert "SET app.venue_ops = 'on';" in sql  # TR-41 venue-ops gate
    assert bundle["run_id"] in sql
    payload = json.loads(re.search(r"'(\[.*\])'::jsonb", sql, re.S).group(1))
    assert len(payload) == len(rows)
    assert {"cell", "venue_id", "floor_id", "geometry_version"} == set(payload[0])


# --- migration 0018 invariants ------------------------------------------------

MIGRATION = (ROOT / "db" / "migrations" / "0018_analytics_publication.sql").read_text()


def test_migration_versions_geometry():
    assert "geofence_version" in MIGRATION
    assert MIGRATION.count("geofence_version_bump") >= 3  # function + 2 triggers
    assert "BEFORE UPDATE OF geofence ON venues" in MIGRATION
    assert "BEFORE UPDATE OF geofence ON venue_floors" in MIGRATION


def test_migration_read_all_no_write_policy():
    assert "cell_attribution_read_all" in MIGRATION
    assert re.search(r"FOR SELECT\s+USING \(true\)", MIGRATION)
    # the only write path is the SECURITY DEFINER function
    assert "CREATE POLICY" in MIGRATION
    assert MIGRATION.count("CREATE POLICY") == 1
    assert "SECURITY DEFINER" in MIGRATION


def test_migration_gated_and_audited():
    assert "app.venue_ops" in MIGRATION
    assert "admin_audit_log" in MIGRATION
    assert "venue.attribution.publish" in MIGRATION


def test_migration_version_monotonic_upsert():
    assert "ON CONFLICT (cell) DO UPDATE" in MIGRATION
    assert "EXCLUDED.geometry_version >= cell_attribution.geometry_version" in MIGRATION


def test_migration_mounted_everywhere():
    compose = (ROOT / "deploy" / "docker-compose.yml").read_text()
    k8s = (ROOT / "deploy" / "k8s" / "README.md").read_text()
    assert "0018_analytics_publication.sql" in compose
    assert "0018_analytics_publication.sql" in k8s


def test_all_migrations_mounted_in_compose_and_k8s():
    """Every migration file must appear in both deployment manifests — this
    guards the drift that left 0015-0017 out of the k8s list."""
    compose = (ROOT / "deploy" / "docker-compose.yml").read_text()
    k8s = (ROOT / "deploy" / "k8s" / "README.md").read_text()
    for path in sorted((ROOT / "db" / "migrations").glob("0*.sql")):
        assert path.name in compose, f"{path.name} missing from docker-compose.yml"
        assert path.name in k8s, f"{path.name} missing from k8s README"
