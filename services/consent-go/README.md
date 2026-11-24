# consent-go — the Go consent service core (TECH-18)

The ARC language allocation puts the consent service in Go. This module is
that service's core: a faithful port of the FR-29 consent state machine, the
closure masking rules (FR-32/FR-34), and the offer/conversation lifecycle
constants — held to the same behaviour as the Postgres trigger and the TS
edge routes they govern.

## Contract

- **FR-29 state machine** (`statemachine.go`) — `ConsentTransitionOK`, an
  exact port of `consent_transition_ok()` (migration 0001):
  NULL → DETECTED only; DETECTED → {NUDGED, EXPRESSED}; NUDGED → EXPRESSED;
  EXPRESSED → MUTUAL; MUTUAL → OPEN; everything else illegal. The database
  trigger remains the final arbiter at write time — the ledger is
  append-only (FR-35) and this helper only computes intent.
- **Closure masking** (`lifecycle.go`) — `MaskCloseReason`: FR-32 silent
  decline (a 'declined' close is reported as 'expired'), FR-34 blocks
  invisible (nil — the row never reaches the list).
- **Lifecycle** (`lifecycle.go`) — offer TTL 30 min (FR-33), conversation
  TTL 24 h (FR-37), purge 24 h after close (NFR-20), one-minute sweep tick;
  `IsOfferLive`: pre-OPEN, unclosed, inside deadline.

## Verification

`go vet ./... && go test ./...` (wired into CI as the `go-services` job):

- `statemachine_test.go` — the exhaustive 5×5 transition table plus the
  NULL-from case, and the masking contract.
- `lifecycle_test.go` — every constant pinned to the TS source, and the
  `IsOfferLive` matrix including the exclusive deadline boundary.

The module is stdlib-only — no `go.sum`, nothing to vendor.

## Serving

The TypeScript edge remains the P0 serving stand-in (documented in the ARC
traceability); this module is the verified core it migrates to. The pytest
invariants (`tests/test_batch30.py`) pin the transition table, mask mapping
and TTLs to the SQL migrations and TS sources.
