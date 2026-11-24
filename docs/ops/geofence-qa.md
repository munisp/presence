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
