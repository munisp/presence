"""Presence P1 analytics lakehouse (ARC-002 §6).

Python owns lakehouse jobs (ARC-002 §4.3). This package implements the
medallion pipeline semantics:

  extract   — production boundary: identifier exclusion + pseudonymisation
              (FR-61, SEC-16) before any event leaves production
  bronze    — raw events exactly as emitted post-extraction, append-only
              Delta/Parquet partitioned by date and cell prefix (90 days)
  silver    — deduplicated, validated, cell-normalised, one row per business
              event (25 months, NFR-23)
  gold      — k-suppressed analytical products (25 months, NFR-23 caps the
              ARC "indefinite" wording)
  attribution — TR-38 venue polygon spatial join, published to the
              operational store as a cell map (never recomputed per request)
  catalogue — TR-39 owner/grain/SLO/retention registration for gold tables
  geoparquet — TR-43 GeoParquet publication for GIS tooling

Python writes only to Delta/OpenSearch and never to the OLTP database
(ARC-002 §4.3); operational publication travels as a governed SQL bundle
applied through publish_cell_attribution (migration 0018, ADR-0009).
"""
