# ADR 0003: Keycloak over Ory

Status: accepted (lands P1)

## Context

The platform serves three populations with different assurance needs:
consumers, venue workforce, integration partners. Ory's composable services
are elegant but multiply operational surface.

## Decision

Keycloak, three realms: `consumer`, `workforce`, `partners`. P0 ships with a
shared HS256 secret so the stack runs self-contained; the edge's JWT plumbing
is realm-agnostic and switches to Keycloak-issued RS256 tokens unchanged.

## Consequences

One IdP to operate; social login and MFA are configuration, not code. P0 auth
is dev-grade by design and isolated behind the `Authorization` header.
