# Just-in-time workforce elevation (SEC-03)

Workforce administrative access is just-in-time: nobody holds standing
moderator power. An `elevation-eligible` member requests a time-boxed
grant, a **different** moderator approves it (four-eyes), the grant expires
automatically inside the workforce realm's 4-hour session ceiling, and
every transition is written to the FR-60 append-only audit trail inside
its definer. Migration 0022 is the source of truth; the edge replays the
grant window into Keycloak via the Admin API.

## Workflow

1. **Request** — `POST /v1/console/elevation/requests` (workforce realm +
   `elevation-eligible` role) with a scope (`moderation`) and a screened
   10–500 character justification. One open request per subject and scope;
   re-requesting is idempotent and returns the open request.
2. **Approve** — `POST /v1/moderation/elevation/:requestId/approve`
   (moderator). The definer refuses `actor = subject` — four-eyes is
   enforced by the definer AND the table `CHECK (decided_by <> subject)`,
   so it cannot be bypassed by a direct write either. The grant window is
   4 hours from the decision, pinned to the realm's
   `ssoSessionMaxLifespan` (14400 s): no grant can outlive the session
   ceiling the realm already enforces.
3. **Bind** — on approval the edge adds the `moderator` realm role via the
   Keycloak Admin API (`keycloakAdmin.ts`, env-gated). The Postgres grant
   is authoritative; the Admin API mapping calls are idempotent, so a
   failed bind is repaired by the next transition.
4. **Expire** — the 60-second lifecycle tick runs `expire_elevations()`:
   grants past their window flip to `expired` (audited) and the edge
   removes the realm role. Stale pending requests lapse after 24 hours so
   the queue cannot accumulate undecided requests.
5. **Revoke** — `POST /v1/moderation/elevation/:requestId/revoke` ends a
   live grant early (compromise suspicion, task finished) and unbinds the
   role in the same request.
6. **Reject** — `POST /v1/moderation/elevation/:requestId/reject` closes a
   pending request without a grant.

## Audit

Every state change writes `admin_audit` with reason code `jit_elevation`:
`elevation.requested` / `.approved` / `.rejected` / `.revoked` /
`.expired`. The audit write is inside the definer transaction — the record
cannot be detached from the action. Expiry rows carry a NULL actor (the
system marker), matching the ledger-anonymisation convention.

## Keycloak binding

`KEYCLOAK_ADMIN_BASE_URL`, `KEYCLOAK_ADMIN_CLIENT_ID`,
`KEYCLOAK_ADMIN_CLIENT_SECRET` (plus optional `KEYCLOAK_ADMIN_REALM` =
"workforce" and `KEYCLOAK_ADMIN_TOKEN_REALM` = "master"). The client uses
the `client_credentials` grant and caches its token until 30 s before
expiry. Setup for the service-account client is in
`deploy/keycloak/README.md`. Without credentials the binding is a
documented no-op: operators bind manually in the admin console and the
Postgres workflow remains complete and audited.

## Why this satisfies SEC-03

- **Just-in-time** — access exists only inside an approved, time-boxed
  grant window; the default state is no access.
- **Four-eyes** — requester ≠ approver, enforced at two layers (definer
  exception and table CHECK).
- **Bounded** — the 4-hour grant TTL is pinned to the realm session
  ceiling by a cross-layer test (tests/test_batch31.py), and expiry is
  driven by the same 60-second tick that enforces the offer lifecycle.
- **Audited** — append-only, in-transaction, with the governed reason
  code; reviewable via the moderation console's audit surface.
