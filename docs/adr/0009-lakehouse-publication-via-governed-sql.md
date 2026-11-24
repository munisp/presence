# ADR-0009: Lakehouse publication reaches the operational store as governed SQL, never a Python connection

- Status: Accepted (2026-11-24)
- Amends: nothing. Resolves the apparent conflict between TR-38 and ARC-002 §4.3.

## Context

TR-38 requires venue polygon attribution to be computed in the lakehouse and
*published to the operational store*. ARC-002 §4.3 forbids Python from ever
writing to the OLTP database ("a rule that prevents the classic 'notebook
changed production' incident"). Both are load-bearing: attribution must land
where matching can read it, and the lakehouse must never hold a production
write credential.

## Decision

Publication is a **bundle**, not a connection:

1. `analytics/attribution.py` computes the cell → venue/floor map as a
   spatial join (centroid containment at the governed attribution resolution
   9) and emits a publication bundle: a manifest (run id, row count, content
   digest) plus SQL text.
2. The SQL applies the rows through `publish_cell_attribution`
   (migration 0018), the single governed write path: SECURITY DEFINER,
   gated on the venue-ops GUC (geometry ownership follows TR-41),
   version-monotonic (a stale run cannot roll a cell back), audited via
   `admin_audit_log` (FR-60).
3. An operator or CI automation applies the bundle with psql, exactly like a
   migration. Python's write boundary is preserved — it writes Delta,
   GeoParquet and a text artifact; it never opens a socket to the OLTP store.

Read-side freshness is enforced in the edge: `cell_attribution` rows carry
the `geofence_version` they were computed from (FR-90 versioning), and the
presence-publish lookup joins the live `venues.geofence_version`. A polygon
revision suspends attribution — presence falls back to plain cell scope —
until the lakehouse republishes. A stale map can never mis-scope presence.

## Consequences

- Attribution is never recomputed per request: matching reads a primary-key
  lookup (TR-38), and the lookup is version-checked (FR-90 precedence with
  safe staleness behaviour).
- Every publication is an audited, reviewable artifact in git/CI rather than
  an invisible data-pipeline side effect.
- When the P2 engine gate opens (Spark + Sedona), the same bundle contract
  carries over — only the join engine changes.

## Alternatives considered

- **Python writes via a least-privilege role** — violates the ARC §4.3
  ownership boundary; rejected.
- **Edge recomputes point-in-polygon per publish** — exactly what TR-38
  forbids; rejected.
- **Debezium-style CDC back into the OLTP store** — adds a component the
  phase gates do not admit at P1; rejected.
