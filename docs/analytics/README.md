# Analytics lakehouse (P1, ARC-002 §6)

The analytics pipeline turns production events into venue and product
insight without ever weakening the privacy invariants: no coordinates,
no direct identifiers, no sub-k aggregates.

## Boundary rules (enforced in code)

- **FR-61** — direct identifiers are excluded and location-derived events are
  aggregated to at least cell resolution *before storage*. Enforced
  structurally: `analytics/schemas.py` validates every event against a
  per-kind allowlist plus a denylist (identifiers, coordinates, message
  content) that rejects even allowlisted-looking edits.
- **SEC-16** — events are pseudonymised before leaving production:
  `analytics/pseudonym.py` substitutes the account id with an HMAC keyed by a
  salt that rotates every calendar month, so pseudonyms are uncorrelatable
  across months. Every gold aggregate applies the k floor (K_MIN = 11,
  pinned to `services/edge/src/aggregate.ts`): a cell-hour, venue-day or
  funnel step below the floor does not exist in gold.
- **NFR-23** — retention: bronze 90 days, silver 25 months, gold 25 months
  (the SRS retention schedule caps the ARC's "indefinite" wording).
  `analytics/retention.py` prunes partitions on every run.

## Layers (TECH-22 — Delta Lake on Parquet)

| Layer | Contents | Partitions | Retention |
|---|---|---|---|
| bronze | events exactly as emitted post-extraction | date + cell prefix | 90 days |
| silver | deduplicated, validated, one row per business event | month | 25 months |
| gold | k-suppressed analytical products | month | 25 months |

The P2 engines (Flink ingest, Spark + Sedona batch joins) execute these same
layer definitions at scale when the phase gate opens; the semantics here —
contracts, keys, retention, k floor — are the invariant.

## Gold products (TR-39)

Every gold table is registered in `catalogue.yaml` with owner, grain,
freshness SLO and retention; `scripts/check_gold_catalogue.py` fails CI on
any drift. Current tables: `density_cell_hour` (FR-78 halo / TR-14
calibration feed), `venue_kpi`, `consent_funnel`, `cell_attribution`.

## Venue polygon attribution (TR-38 / FR-90)

`analytics/attribution.py` computes the cell → venue/floor map as a spatial
join (centroid containment at the governed resolution 9) and emits a
publication bundle — manifest + SQL — that is applied through
`publish_cell_attribution` (migration 0018), the single governed write path.
Presence publishing reads the map as a version-checked primary-key lookup
(`services/edge/src/attribution.ts`); the polygon is never recomputed per
request, and a polygon revision suspends attribution until republication.
See ADR-0009.

## Geospatial export (TR-43)

Geospatial gold publishes as GeoParquet 1.0 (`analytics/geoparquet.py`) so
GIS tooling reads density surfaces and attribution maps without a live
database connection; no reporting surface requires database access to render
a map.

## Running

```bash
pip install -r analytics/requirements.txt
python -m pytest tests/ -q            # full suite incl. analytics
python scripts/check_gold_catalogue.py # TR-39 gate
```

A scheduled run is `analytics.pipeline.run(root, raw_events, geometries)` —
extract, append, conform, build, publish-bundle, export, prune — returning a
manifest. In the P1 wiring, raw events arrive from the Kafka bus; the
extractor is the production boundary and the only place account ids are
seen (and immediately pseudonymised).
