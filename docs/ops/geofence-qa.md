# Geofence QA workflow (TECH-24)

The MapLibre + GeoLibre + PostGIS stack (ADR-0008) ships with a quality
workflow, not just an editor. TR-41 built the authoring half — drafts,
second-person review, density verification, one DB-final publish path.
This page is the QA half: what is verified, when, and what to do when a
check fails.

## The gates, in order

| Stage | Check | Authority | Failure surface |
|---|---|---|---|
| Authoring | Polygon parses, single closed ring | edge (`geofence.ts`) | 422 with the parse error |
| Authoring | Density gate — valid, ≥4 vertices, 10 m²–1 km², no edge > 25 m | edge mirror, DB re-verifies | 422 with the failing check |
| Authoring | Overlap probe — `POST /v1/ops/geofences/overlap-check` | DB (`geofence_overlap_check`) | `ok: false` + conflicting venues |
| Review | Four-eyes — reviewer is never the author | edge transition + publish definer | 409 |
| Publish | Density gate re-run | DB (`publish_geofence_draft`) | 409 `density verification failed: …` |
| Publish | Overlap gate — venue targets may not claim another venue's ground | DB (`publish_geofence_draft`) | 409 `geofence overlaps venue … by … m2` |
| Post-publish | Estate audit — `GET /v1/ops/geofences/qa` | DB (`geofence_qa_report`) | QA dashboard rows |

## Overlap semantics

Attribution (FR-90) joins presence cells against venue polygons; two
venues claiming the same ground would make that join ambiguous, so the
publish gate rejects venue-target polygons that intersect any **other**
venue's live geofence by more than **10 m²**. Below 10 m² the intersection
is survey noise or a shared property line and is tolerated.

Floor polygons are exempt from the overlap gate: floors legitimately nest
inside their venue's footprint. The QA report's conflict count is
venue-level for the same reason.

## Operating the QA report

`GET /v1/ops/geofences/qa` (venue-ops role) returns one row per venue:

- `hasGeofence` — coverage; a venue without a polygon cannot attribute
  presence and should be first on the authoring queue.
- `densityError` — the live polygon re-verified against the density gate;
  `null` means pass. Any non-null value on a published polygon means the
  gate tightened after that polygon shipped: re-author it through the
  normal draft workflow (never patch the column directly — the publish
  path is the only write path, enforced by grants).
- `overlapConflicts` — how many other venues this polygon conflicts with
  (over the 10 m² tolerance). Non-zero after publish means the conflict
  predates the overlap gate; resolve by re-authoring the smaller claimant.
- `geofenceVersion` — the version attribution is bound to; a bump
  suspends attribution until republication (FR-90), so expect a version
  change to coincide with a brief attribution gap.
- `openDrafts` — drafts in flight (`draft`, `in_review`, `approved`);
  approved-but-unpublished rows are publish actions waiting on the second
  person.

## Cadence

Run the QA report after every publish, weekly per launch metro, and
before any venue-onboarding batch. Every publish is audit-logged
(`geofence.draft.publish` with the draft, target and author detail), so
the QA dashboard can always be reconciled against the audit trail.

## Verification

`scripts/verify_geogates.py` is the PostGIS integration gate behind this
workflow (the `geofence-gates` CI job, running on the deploy image's
`postgis/postgis` base). The full-chain rehearsal stubs every spatial
predicate so it can run on a bare cluster — geography degrades to text,
`ST_IsValid` is constant true, `ST_Area` constant 0 — which means no
geofence gate ever fires there. This gate is the complement: it applies
the full migration chain against REAL PostGIS and fires known-answer
polygons through every spatial check:

- **Reality proof** — `postgis_version()` answers 3.x, a ~20 m Lagos
  square measures ~400 m² geodesically (a stub answers 0), and
  `ST_Segmentize` actually splits a 26 m edge (a stub is the identity).
- **Density gate** — a dense 20 m square passes; a bowtie fails validity;
  a 2 m and a 1.5 km square hit the area bounds; a 26 m edge fails the
  25 m segmentisation bound while a 24 m edge passes it. The sub-4-vertex
  branch is proven defensive depth: the WKT parser refuses such rings
  before any gate can see them.
- **Overlap gate** — far away, shared-edge and a ~3 m² sliver (below the
  10 m² tolerance) are silent; a ~50% overlap conflicts with the right
  venue at a plausible m²; a venue never conflicts with itself.
- **Publish path** — the happy path writes the canonical polygon, bumps
  `geofence_version` and audits; wrong reviewer, reviewer-equals-author,
  unapproved, unknown draft, density-failing and overlapping drafts each
  raise their named refusal; a floor target is overlap-exempt and
  publishes over another venue's ground.
- **QA report** — refuses on a cold connection that never set
  `app.venue_ops` (the NULL-safe GUC gate), then reports the estate with
  the legacy density error and symmetric overlap conflicts.

Only the non-spatial extension surface is degraded (vector → text, HNSW →
btree, the two h3 functions the chain calls). Run it against any
PostGIS-enabled cluster:

```
DATABASE_URL=postgres://postgres:rehearse@localhost:5432/postgres \
    python3 scripts/verify_geogates.py
```

The gate drops and recreates its own `presence_geogates` scratch database
(including the two cluster-global roles the chain creates), so it is
rerunnable; without `DATABASE_URL` it skips with a message and exits 0.
