# ADR 0001: P0 sequencing principle

Status: accepted (P0)

## Context

PRS-ARC-002's enterprise stack (Keycloak, Kafka, Dapr, OpenSearch, Mojaloop,
TigerBeetle, …) is a target, not a starting point. Standing it all up at once
delays the only question that matters first: does the matching loop work?

## Decision

A component is admitted only when its predecessor is the measured bottleneck.
P0 is five product processes: client, Fastify edge, stateless match service,
Valkey 8 presence, Postgres 17 — plus Centrifugo for realtime fan-out.

Amended 2026-11-23: the original text of this ADR placed Keycloak in P1. That
misread ARC-002 §9, whose phase table puts Go, Rust, Python, Kubernetes,
Postgres, Valkey, **APISIX and Keycloak** in P0 — "pilot needs them on day
one". Identity (Keycloak, three realms) and the gateway (APISIX) are therefore
P0, and Keycloak now ships in the P0 compose stack with the edge verifying
realm RS256 tokens via JWKS (ADR-0003). Later components stay phase-gated:
P1 streaming/analytics (Kafka, Temporal, OpenSearch, Delta lakehouse), P2
stream depth and security analytics, P3 payments (Mojaloop/TigerBeetle).

## Consequences

The scan path is two processes and one cache — debuggable in an afternoon.
Every later component must justify itself against a P0 measurement.
