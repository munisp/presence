# presence-go — the Go presence service core (TECH-18)

The ARC language allocation puts the presence service in Go. This module is
that service's core: a faithful port of the pure domain logic the TypeScript
edge serves with today — SEC-20 velocity rules, the FR-28 density budget
ladder, and the canonical Valkey key model (FR-16/FR-23/FR-34/FR-91) — held
to the same constants and behaviour as the TS implementation it migrates
from.

## Contract

- **SEC-20 velocity rules** (`velocity.go`) — H3 grid-distance speed checks:
  `EDGE_KM` per storage resolution (9/10/11), centre-to-centre step of
  `edge·√3`, `MAX_PLAUSIBLE_KMH = 500` with a strictly-greater comparison,
  non-positive elapsed time treated as infinite speed. Ceilings:
  200 scans/hour, 20 waves/day.
- **FR-28 budget ladder** (`budget.go`) — sparse (< 25) → 3 scans/hour,
  busy (≥ 25) → 2/hour, crowd (≥ 100) → 1/day; a product budget layered
  under the SEC-20 anti-abuse ceilings.
- **Canonical key model** (`keys.go`) — FR-23 suppression keys
  (`suppress:{lo}:{hi}`, 600 s TTL), FR-91 rotation keys (`rotate:{lo}:{hi}`,
  604 800 s TTL), FR-34 block keys (`block:{lo}:{hi}`, permanent), all with
  canonical pair ordering so either side computes the same key; FR-16
  128-bit hex presence session ids and their reverse-index key.

## Verification

`go vet ./... && go test ./...` (wired into CI as the `go-services` job):

- `velocity_test.go` — grid-step geometry pinned to the TS constants,
  impossible-travel boundaries (strictly-greater contract asserted against
  the computed speed), infinite-speed guards, ceiling constants.
- `budget_test.go` — the full ladder, both thresholds, every window length.
- `keys_test.go` — canonical ordering from either side, exact key formats,
  TTLs, session-id shape and uniqueness.

The module is stdlib-only — no `go.sum`, nothing to vendor (SEC-24 pinning
discipline holds trivially).

## Serving

The TypeScript edge remains the P0 serving stand-in (documented in the ARC
traceability); this module is the verified core it migrates to. Binding into
serving is a deployment decision and changes no behaviour — the pytest
invariants (`tests/test_batch30.py`) pin every constant to the TS sources.
