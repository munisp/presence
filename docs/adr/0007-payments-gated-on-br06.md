# ADR 0007: Mojaloop + TigerBeetle gated on BR-06 revision

Status: gated (not before P3)

## Context

The payments architecture (Mojaloop scheme, TigerBeetle ledger) assumes
BR-06's commercial model. Until BR-06 is revised and signed off, building the
ledger stack is speculative spend.

## Decision

No payments code before P3, and then only after the BR-06 revision lands.
Venue offers in P0 are informational rows, not payment instruments.

## Consequences

Zero throwaway payments work; the offer surface (`/v1/offers`) is deliberately
payment-free.
