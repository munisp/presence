# venue-go — the Go venue service core (TECH-18)

The ARC language allocation puts the venue service in Go. This module is that
service's core: a faithful port of the venue registry and dashboard domain
logic — BR-13 k-anonymity suppression, the FR-42 operating-schedule shape and
evaluation, the partner-status lifecycle (FR-42/BR-14), and the aggregate
dashboard figures (BR-12) — held to the same behaviour as the TS edge routes
and the Postgres constraints they serve with.

## Contract

- **BR-13 suppression** (`aggregate.go`) — `K_MIN = 11`; every aggregate
  figure passes through `KSuppressed`, which withholds any value backed by
  fewer than k individuals (the venue sees "suppressed", never the small
  number). The dashboard never serves user-level data at all.
- **FR-42 operating schedule** (`schedule.go`) — the jsonb shape enforced by
  `operating_schedule_valid()` (migration 0020), ported with the exact same
  day/time regular expressions; `IsOpenAt` evaluates windows in the
  schedule's own timezone, including overnight windows that wrap past
  midnight. An unparseable timezone is an error, never a silent fallback.
- **Partner lifecycle** (`partner.go`) — the governed status set
  {prospect, active, suspended, offboarded} and `SyncActive`, an exact port
  of the `venues_sync_active` trigger: `active` is derived (never set
  directly), entering suspension stamps `suspended_at`, leaving it clears
  the stamp, staying suspended keeps it.
- **BR-12 dashboard** (`dashboard.go`) — every served figure (live presence,
  scans last hour, active offers, live announcements, live-event presence)
  passes through the same k-suppression as the TS route.

## Verification

`go vet ./... && go test ./...` (wired into CI as the `go-services` job):

- `aggregate_test.go` — suppression boundaries and the dashboard mapping.
- `schedule_test.go` — shape validation against the SQL regexes (including
  rejected forms the CHECK would reject), timezone-aware evaluation,
  overnight wrapping, exclusive close times, error-on-bad-timezone.
- `partner_test.go` — the status set and every `SyncActive` transition.

The module is stdlib-only — no `go.sum`, nothing to vendor.

## Serving

The TypeScript edge remains the P0 serving stand-in (documented in the ARC
traceability); this module is the verified core it migrates to. The pytest
invariants (`tests/test_batch30.py`) pin the constants, regexes and status
set to the SQL migrations and TS sources.
