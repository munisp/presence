# Stakeholder onboarding (AMD-ONB-01..06)

Batch 62 gives every stakeholder a governed way onto the platform. Until
now only consumers had a first-run journey at all; venue operators were
hand-provisioned in Keycloak with no platform record, and providers were
gated on nothing but KYC. This document maps the journeys the migration,
edge routes and client contract implement.

## The consumer journey

`GET /v1/account/onboarding` is the canonical stepper — one ordered read
instead of five endpoint polls:

1. **Confirm your age** (`ui.onboarding.step.age`) — the FR-04 age
   declaration with its neutral response.
2. **Verify your identity** (`ui.onboarding.step.kyc`) — the member
   initiates review with `POST /v1/identity/kyc/request`; the step shows
   `ui.onboarding.kyc.under-review` while the request is open, and the
   moderation console works the `GET /v1/moderation/kyc-queue` worklist.
   A rejection renders the step blocked with
   `ui.onboarding.kyc.rejected` — the member can request a fresh review.
3. **Pick your symbol** (`ui.onboarding.step.avatar`) — the AMD-AVT-01
   curated avatar.
4. **Choose what you want to use** (`ui.onboarding.step.verticals`) — the
   AMD-VERT-05 toggle screen; a written flag row marks the step done.

`complete` is the AND of the four. The client module
(`client/src/presence/stakeholderOnboarding.ts`) derives exactly one
`ready` step — the first incomplete one.

## Becoming a venue partner

1. A verified member applies: `POST /v1/onboarding/applications` with
   `kind: "venue_partner"`, a venue name, the geofence polygon (4–64
   lon/lat pairs), an optional operating schedule and a short statement.
   Applying twice returns the open application (`already_open`) — the
   screen can never create duplicates.
2. The application lands in the moderation queue
   (`GET /v1/moderation/onboarding`). A moderator approves or rejects —
   never their own application (four-eyes, enforced by the database), and
   a rejection always carries a reason the applicant reads back on
   `GET /v1/onboarding/applications/mine`.
3. Approval **provisions the venue as a prospect** and binds the operator
   as its owner in `venue_accounts` — the platform's source of truth the
   BR-12 `venue_ids` claim replays from. A prospect is not live.
4. Venue-ops activates the venue (`POST /v1/venues/{venueId}/activate`) —
   a second governed act: approval onboards, activation goes live.
5. The partner then operates the existing registry surface: dashboard,
   schedule, self-serve suspend/resume (BR-14).
6. Offboarding (`POST /v1/venues/{venueId}/offboard`, venue-ops only,
   terminal) revokes the operator bindings, and the claim replay unbinds
   them.

## Becoming a provider

1. A verified member applies with `kind: "provider"`, accepting a terms
   version (`v<major>.<minor>`) with a short statement.
2. Moderation decides under the same four-eyes and mandatory-reason
   discipline. The approved application IS the vetted-standing record —
   listing creation stays KYC-gated as before (the 306-requirement ledger
   is untouched), and moderation can still suspend a bad actor's KYC,
   which closes every seller surface at once.

## The moderation console

Two queues serve the workflows: `GET /v1/moderation/onboarding`
(applications — pending first, oldest waiting) and
`GET /v1/moderation/kyc-queue` (member review requests, oldest first).
Every submission, withdrawal, decision, provisioning, activation and
binding revocation lands in the admin audit log (FR-60).

## Record-keeping

The FR-62 export (`GET /v1/account/export`) carries the member's
onboarding record: every application with its payload, status and
decision, and the KYC review stamp on the user object.
