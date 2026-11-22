# ADR 0002: Valkey over Redis

Status: accepted (P0)

## Context

Presence needs a low-latency ephemeral store (strings, sets, TTLs). Redis Ltd's
 licence change (RSALv2/SSPLv1) creates commercial uncertainty for a platform
we may host for partners.

## Decision

Valkey 8 (Linux Foundation, BSD 3-clause). The client is ioredis — RESP is
RESP; the iovalkey fork is adopted once its releases stabilise.

## Consequences

No licence exposure; drop-in RESP compatibility; the key model in
`docs/presence-model.md` works identically on either server.
