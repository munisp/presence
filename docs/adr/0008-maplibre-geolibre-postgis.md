# ADR 0008: MapLibre + GeoLibre + PostGIS

Status: accepted

## Context

Venue maps and geofence editing need a rendering stack and a polygon editor.
Mapbox's pricing scales against a developing-market rollout.

## Decision

MapLibre GL for rendering (open fork of Mapbox GL), GeoLibre as the polygon
editor, PostGIS `geography` as the canonical geofence store (`venues.geofence`).
H3 handles presence cells; PostGIS handles venue geometry; the two never mix
concerns — presence never stores coordinates (TR-15).

## Consequences

No per-render map billing; geofences are editable by venue staff and queryable
with standard spatial SQL.
