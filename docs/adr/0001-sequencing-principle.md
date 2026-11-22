# ADR 0001: P0 sequencing principle

Status: accepted (P0)

## Context

PRS-ARC-002's enterprise stack (Keycloak, Kafka, Dapr, OpenSearch, Mojaloop,
TigerBeetle, …) is a target, not a starting point. Standing it all up at once
delays the only question that matters first: does the matching loop work?

## Decision

A component is admitted only when its predecessor is the measured bottleneck.
P0 is five processes: client, Fastify edge, stateless match service, Valkey 8
presence, Postgres 17 — plus Centrifugo for realtime fan-out. Enterprise
components land phased: P1 identity (Keycloak), P2 analytics (OpenSearch,
Kafka), P3 payments (Mojaloop/TigerBeetle) and streaming depth (Fluvio
evaluation).

## Consequences

The scan path is two processes and one cache — debuggable in an afternoon.
Every later component must justify itself against a P0 measurement.
