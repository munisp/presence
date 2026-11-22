# ADR 0005: Dapr — selective building blocks only

Status: accepted (lands with the components that need it)

## Context

Dapr's sidecar can standardise pub/sub, secrets and bindings — but adopting
the full programming model couples every service to it.

## Decision

Selective: pub/sub (over Kafka at P2), secrets, and external bindings only.
No Dapr service invocation, no actors, no state stores — the scan path stays
direct service-to-cache.

## Consequences

Portability where it is valuable, zero overhead where it is not.
