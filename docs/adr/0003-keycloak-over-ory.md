# ADR 0003: Keycloak over Ory

Status: accepted (lands P0 — amended 2026-11-23; this ADR originally said P1,
which misread the ARC-002 §9 phase table)

## Context

The platform serves three populations with different assurance needs:
consumers, venue workforce, integration partners. Ory's composable services
are elegant but multiply operational surface.

## Decision

Keycloak, three realms: `consumer`, `workforce`, `partners`. The realms are
versioned as import files in `deploy/keycloak/` and boot with the P0 compose
stack. The edge verifies Keycloak-issued RS256 tokens against the realm JWKS
when `KEYCLOAK_ISSUER` is set; with the variable unset it falls back to a
shared HS256 dev secret so unit tests and offline runs stay self-contained.

## Consequences

One IdP to operate; social login and MFA are configuration, not code. P0 auth
is dev-grade by design and isolated behind the `Authorization` header.
