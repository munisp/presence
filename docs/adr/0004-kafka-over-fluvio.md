# ADR 0004: Kafka over Fluvio (deferred to P2/P3)

Status: accepted (lands P2; Fluvio re-evaluated P3)

## Context

Event streaming is needed for analytics and audit fan-out, not for P0 — no
async work may sit on the scan path regardless.

## Decision

Kafka when streaming is admitted (P2), for ecosystem breadth and operational
familiarity. Fluvio is re-evaluated at P3 when Rust-native stateful stream
processing could collapse the topology.

## Consequences

P0 has no broker at all: Centrifugo fan-out and Postgres writes cover every
P0 flow. Nothing is designed against a Kafka-specific API.
