"""Batch 64 invariants — the PostGIS integration gate (TECH-24 / TR-41 /
TR-42 / FR-90):

  scripts/verify_geogates.py applies the full migration chain against REAL
  PostGIS and fires known-answer polygons through every geospatial gate —
  the complement to the full-chain rehearsal, which stubs every spatial
  predicate (geography -> text, ST_IsValid = true, ST_Area = 0) so no
  geofence check can ever fire there.

These pins are static: the live behaviour is proven by the geofence-gates
CI job (postgis/postgis, the deploy image's base) — 33/33 checks at
authoring time. What pytest guards is the gate's own contract:

  * the transform keeps geography/geometry REAL (never degraded to text)
    while degrading only the non-spatial surface (vector -> text,
    HNSW -> btree, the h3 domain + the two h3 functions the chain calls);
  * the gate pre-creates postgis + pgcrypto and strips CREATE EXTENSION
    lines (the cluster owns the extensions, not the chain);
  * the known-answer suite covers every refusal string the migrations
    promise, the 25 m segmentisation boundary probed at 24/26 m (never
    exactly 25.000 m), the 10 m² overlap tolerance probed from both sides,
    the four-eyes publish refusals, the floor overlap exemption, and the
    batch-63 cold-connection NULL-safe QA gate;
  * the gate is rerunnable (drops its scratch database AND the two
    cluster-global roles the chain creates) and skips cleanly without
    DATABASE_URL;
  * CI wires it against the deploy image's PostGIS base, and the ops doc
    explains the division of labour with the stubbing rehearsal.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATE = (ROOT / "scripts/verify_geogates.py").read_text()
REHEARSAL = (ROOT / "scripts/rehearse_full_chain.py").read_text()
CI = (ROOT / ".github/workflows/ci.yml").read_text()
OPS_DOC = (ROOT / "docs/ops/geofence-qa.md").read_text()


def test_transform_keeps_spatial_real():
    # The whole point: geography/geometry must NOT degrade to text here.
    assert 're.sub(r"\\bgeography\\b"' not in GATE
    assert 're.sub(r"\\bgeometry\\b"' not in GATE
    assert 're.sub(r"geography\\(' not in GATE
    # …while the non-spatial extension surface degrades exactly as in the
    # rehearsal (vector -> text, the taxonomy HNSW index -> btree, the h3
    # domain plus the only two h3 functions the chain calls).
    assert 're.sub(r"vector\\(' in GATE
    assert 're.sub(r"\\bvector\\b"' in GATE
    assert "USING hnsw (embedding vector_cosine_ops)" in GATE
    assert "USING btree (embedding)" in GATE
    assert "CREATE DOMAIN h3index AS text" in GATE
    assert "h3_cell_to_parent" in GATE and "h3_get_resolution" in GATE
    # Extension loads are stripped; the gate creates postgis + pgcrypto.
    assert 're.match(r"\\s*CREATE EXTENSION"' in GATE
    assert "CREATE EXTENSION IF NOT EXISTS postgis" in GATE
    assert "CREATE EXTENSION IF NOT EXISTS pgcrypto" in GATE
    # The rehearsal keeps its stubs — the two gates stay complementary.
    assert 're.sub(r"\\bgeography\\b", "text", sql)' in REHEARSAL
    assert "ST_IsValid(text) RETURNS boolean" in REHEARSAL


def test_known_answer_suite_covers_every_gate():
    # Reality proof — a stubbed cluster fails these loudly.
    for name in ("postgis_real", "geodesic_area_real", "segmentize_real"):
        assert f'"{name}"' in GATE
    # Density gate (0017) — every promised refusal string, plus the 25 m
    # boundary probed from both sides (never exactly 25.000 m).
    for name in ("density_valid_passes", "density_bowtie_invalid",
                 "density_vertex_branch_defensive", "density_too_small",
                 "density_too_large", "density_edge_24m_passes",
                 "density_edge_26m_fails"):
        assert f'"{name}"' in GATE
    assert "polygon is not valid" in GATE
    assert "polygon area must be between 10 m² and 1 km²" in GATE
    assert "polygon edges must be at most 25 m (densify the outline)" in GATE
    assert "geometry requires more points" in GATE  # parser pre-empts <4
    # Overlap gate (0023) — both sides of the 10 m² tolerance, the
    # plausible-m2 assertion, and self-exclusion.
    for name in ("overlap_far_zero", "overlap_shared_edge_zero",
                 "overlap_sliver_below_tolerance", "overlap_half_conflicts",
                 "overlap_excludes_self"):
        assert f'"{name}"' in GATE
    assert "150 < half[0][1] < 250" in GATE
    # Publish path — happy-path invariants and every named refusal.
    for name in ("publish_happy_path", "publish_writes_canonical",
                 "publish_marks_draft_published", "publish_audits",
                 "publish_bumps_version", "publish_wrong_reviewer_refused",
                 "publish_reviewer_is_author_refused",
                 "publish_unapproved_refused", "publish_unknown_draft_refused",
                 "publish_density_failure_refused", "publish_overlap_refused",
                 "publish_floor_overlap_exempt",
                 "publish_floor_writes_canonical"):
        assert f'"{name}"' in GATE
    assert "geofence draft not found" in GATE
    assert "geofence draft is not approved" in GATE
    assert "publish requires the reviewing second person" in GATE
    assert "density verification failed:" in GATE
    assert "geofence overlaps venue" in GATE
    assert "geofence.draft.publish" in GATE
    # QA report — the batch-63 cold-connection NULL-safe gate, then rows.
    for name in ("qa_report_cold_refusal", "qa_report_rows_with_role",
                 "qa_report_flags_legacy_density", "qa_report_counts_conflicts"):
        assert f'"{name}"' in GATE
    assert "geofence QA report requires the venue-ops role" in GATE


def test_gate_is_rerunnable_and_skips_cleanly():
    # Roles are cluster-global; dropping only the scratch database would
    # collide on the chain's CREATE ROLE on the second run.
    assert "DROP DATABASE IF EXISTS" in GATE
    assert 'DROP ROLE IF EXISTS' in GATE
    assert "presence_app" in GATE and "presence_match" in GATE
    # The rehearse_migrations.py pattern: no database, no failure.
    assert "DATABASE_URL not set" in GATE
    assert "presence_geogates" in GATE


def test_ci_and_docs_wire_the_gate():
    assert "geofence-gates:" in CI
    assert "postgis/postgis:17-3.5-alpine" in CI
    assert "scripts/verify_geogates.py" in CI
    assert "verify_geogates.py" in OPS_DOC
    assert "Reality proof" in OPS_DOC
