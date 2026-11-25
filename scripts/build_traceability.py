#!/usr/bin/env python3
"""Generate the Presence requirement traceability matrix.

PRS-SRS-001 requires the traceability matrix to be a generated artefact, not a
hand-maintained spreadsheet. This script is the generator:

  1. CLASSIFICATION below holds, per requirement id, the audited status and a
     one-line basis note (the audit itself — updated when code changes).
  2. Evidence pointers are extracted mechanically by scanning the repo for
     requirement-id mentions in source, tests, schema, docs and eval assets.
  3. Outputs:
       docs/traceability.json  — machine-readable matrix
       docs/traceability.md    — human-readable matrix with summary counts

Run from the repo root:  python3 scripts/build_traceability.py

Statuses:
  implemented       working in the repo with tests or structural evidence
  partial           meaningful part implemented; named gap remains
  gap-p0            in ARC-P0 product scope, not yet built (code work)
  phase-gated       belongs to an ARC P1+ component (Kafka/Temporal/OpenSearch/
                    lakehouse); correctly deferred per TR-40 / ARC-002 §9
  client            requires the React Native client workstream
  organisational    legal / process / staffing; not expressible as code here
  external-evidence needs production infrastructure or third-party evidence
  superseded        superseded by a recorded architecture decision (ADR)
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import OrderedDict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FAMILIES = OrderedDict(
    [
        ("BR", ("Business requirements (§3)", 33)),
        ("FR", ("Functional requirements (§4)", 100)),
        ("NFR", ("Non-functional requirements (§5)", 37)),
        ("TR", ("Technical requirements (§6)", 44)),
        ("SEC", ("Security requirements (§7)", 38)),
        ("INF", ("Infrastructure requirements (§8)", 20)),
        ("TECH", ("Technology requirements (§9)", 24)),
        ("ACC", ("Acceptance and verification (§10)", 10)),
    ]
)

STATUS_ORDER = [
    "implemented",
    "partial",
    "gap-p0",
    "phase-gated",
    "client",
    "organisational",
    "external-evidence",
    "superseded",
]

# id -> (status, basis note)
CLASSIFICATION: dict[str, tuple[str, str]] = {
    # ---------------- BR ----------------
    "BR-01": ("organisational", "Single-metro launch with >=3 venues in 2 km — launch-ops gate (ACC-07), not code."),
    "BR-02": ("organisational", "Positioning (friendship, not dating) — store copy / onboarding / marketing review; no dating surface exists in code."),
    "BR-03": ("implemented", "Adults-only enforced end to end: year-only declaration (FR-02) blocks under-18s from every discovery surface with a neutral error; an underage report resolved actioned sets age_reverify_required_at in the same transaction (0016), discovery stays closed, and only an adult re-declaration within ±1 year of the stored year clears the flag — the loop cannot be decade-jumped. Console card exposes the state."),
    "BR-04": ("organisational", "Second-city expansion gate on anchor-venue metrics (§2.5 for 3 consecutive weeks)."),
    "BR-05": ("implemented", "Event-scoped mode is live: an event is a venue+window (0001, CHECK ends_at > starts_at), presence published inside the window attributes to the event (FR-43) and the venue dashboard/registry expose the live event with k-suppressed liveEventPresence — a conference or match day runs as a self-contained discovery surface (per-event live set presence:event:{id}) with no permanent local user base required."),
    "BR-06": ("organisational", "Five sequenced revenue lines only; payments gated per docs/adr/0007."),
    "BR-07": ("implemented", "Safety is free and two taps away end to end: the report, block, consent-withdrawal and account-deletion endpoints exist and are ungated (no monetisation gate exists), and the client reportFlow.ts contract pins the five SRS-named actions on their wires, the safety-tray entry on every screen, the two-tap budget for any screen x action, and monetisation fields as audit violations."),
    "BR-08": ("implemented", "Structural: no endpoint exposes precise location, pre-OPEN identity, or unconsented data; no paid tier exists to violate it."),
    "BR-09": ("organisational", "Per-market local-currency pricing via store billing — monetisation phase."),
    "BR-10": ("organisational", "Pilot unit-economics targets (CAC <= EUR6, payback <=4 mo, conversion >=3%)."),
    "BR-11": ("organisational", "Venue agreement: data-processing roles, signage, escalation, 30-day termination."),
    "BR-12": ("implemented", "GET /v1/venues/:venueId/dashboard serves live presence, hourly scans, active offers and live announcements to venue_ids-claim tokens; match-funnel attribution arrives with FR-43."),
    "BR-13": ("implemented", "kSuppressed (aggregate.ts, k=11) withholds every dashboard figure below k; routes/venue.ts applies it to all metrics."),
    "BR-14": ("implemented", "POST /v1/venues/:venueId/suspend + resume (BR-12 claim-scoped) flip partner_status via venue_suspend/venue_resume SECURITY DEFINER (migration 0020, admin_audit FR-60); the sync trigger flips venues.active the moment the status is recorded, the edge purges presence:venue:{id} and strips venue attribution from live entries (KEEPTTL+XX), explicit claims to an inactive venue are refused 409 and polygon attribution skips it — effective immediately, well within the one-business-day allowance and the 15-min TTL bound."),
    "BR-15": ("organisational", "Resourcing: 4 FTE + fractional design/DPO/T&S, 16 weeks to pilot."),
    "BR-16": ("organisational", "T&S staffing >=1 moderator per 10k MAU + named escalation path."),
    "BR-17": ("organisational", "Budget: build + 12-month run + EUR2M cyber insurance + independent pen test."),
    "BR-18": ("organisational", "Named DPO before EU processing, independent of Product/Engineering."),
    "BR-19": ("organisational", "DPIA signed before launch; annual or on-material-change review."),
    "BR-20": ("organisational", "ToS / Privacy Notice / Community Guidelines / Cookie notice per launch language."),
    "BR-21": ("implemented", "taxonomy_releases.provenance (migration 0019) recorded at publish: license CC0, structureSource Wikidata, attribution text retained in the record, proprietaryVenueData none; immutable afterwards — rolled-back releases keep the provenance they published with (TAXONOMY_PROVENANCE, services/edge/src/taxonomy.ts; publish route writes it in the same transaction)."),
    "BR-22": ("organisational", "Nominative, descriptive use only; seed uses names without logos/marks; formal legal review outstanding."),
    "BR-23": ("organisational", "Register of processing activities + published sub-processor list."),
    "BR-24": ("organisational", "Five launch lines / prices / inclusions per §3.6.1."),
    "BR-25": ("organisational", "Venue pricing per venue, unmetered."),
    "BR-26": ("implemented", "Structural: the scorer reads profile + corpus only; no tier or payment input exists on the match path."),
    "BR-27": ("implemented", "Structural: the matcher never receives partner status; per-venue config is limited to threshold/result-count (TR-11)."),
    "BR-28": ("organisational", "Aggregate-only reporting principle; no revenue line exists yet."),
    "BR-29": ("organisational", "Unit-economics model as single source of truth, monthly review."),
    "BR-30": ("organisational", "New revenue line requires DPIA + spec revision."),
    "BR-31": ("organisational", "Commercial model reviewed vs telemetry at each month close."),
    "BR-32": ("organisational", ">20% multi-site discounts modelled pre-signature."),
    "BR-33": ("implemented", "Category CHECK in migration 0004 + canPublishCategory; the work category requires the verified_org token claim (FR-97)."),
    # ---------------- FR ----------------
    "FR-01": ("implemented", "Passkey-only sign-in end to end: the consumer realm ships the passkey policy (platform authenticator, user verification required, passwords disabled — b31) and the edge verifies RS256 via JWKS; the client runs Authorization Code + PKCE (S256) in the system browser (authFlow.ts — fail-closed callback parse, S256 via the in-repo pure-TS SHA-256, injected randomness) and owns the token lifecycle (session.ts — refresh 30 s ahead of the 300 s SEC-02 expiry, exactly one refresh-retry per 401, x-device-id on every authed call, logout pinned to withdraw-first → RP-initiated logout → TR-30 wipe). The device-reachable issuer is served at GET /v1/client/config (auth block; KEYCLOAK_PUBLIC_ISSUER_URL, compose + k8s). A second device enrols only through an authenticated session at attestation-gated POST /v1/devices (three-device cap); recovery is the SEC-09 recovery phone. docs/security/client-auth.md."),
    "FR-02": ("implemented", "POST /account/age-declaration upserts a birth-year declaration; under-18 sets age_blocked; presence+scan refuse with a neutral 403 (no reason disclosed); boundary fails toward blocking; tested."),
    "FR-03": ("implemented", "DELETE /v1/account erases in one authenticated call; the client journey is pinned in journeyContracts.ts — three steps (settings -> account -> confirm) inside the three-tap budget ending in that call, with no support-contact step (budget and no-support proofs test-pinned, App-shell guard)."),
    "FR-04": ("implemented", "delete_account purges envelopes/pairs/blocks/profile/identity synchronously and tombstones the user; the edge strips Valkey presence+suppress+block keys in the same call; ledger actors anonymised after the 90-day hold by lifecycle_tick."),
    "FR-05": ("implemented", "POST/GET/DELETE /v1/devices over the devices registry (migration 0010): device_cap() trigger locks the user row FOR UPDATE and rejects the fourth concurrent device (SEC-33 idiom; re-enrolment of a live fingerprint is a refresh, exempt from the count); one active row per key_fingerprint via partial unique index; enrolment publishes device_enrolled to the account's own channel with label only — never the fingerprint; revocation is idempotent and owner-scoped by RLS."),
    "FR-06": ("implemented", "PUT/GET /v1/profile/identity over user_identities (migration 0020): handle set-once (409 on change), display_name <=80 chars defaulting to the handle at render time (COALESCE in display_handle(), the route reads and dsar_export), bio varchar(140) enforced in the data layer and the route schema; display name and bio are content-screened (SEC-37 idiom); the photo stays RLS-gated to OPEN (identity_after_open) and is uploaded out of band."),
    "FR-07": ("implemented", "register_attestation_key() SECURITY DEFINER enrols/refreshes/detects atomically: a cross-account collision keeps the key with its original account, inserts attestation_duplicates and writes admin_audit_log('moderation.duplicate.detected','impersonation'); the enrolment route returns the same neutral 201 regardless — the console-only registry (RLS app_moderator) surfaces collisions on the moderation account card as keyHashPrefix + both accounts + detected_at. P0 uses the assertion SHA-256 as the key stand-in until cryptographic App Attest verification lands (FR-51 idiom)."),
    "FR-08": ("implemented", "PUT/GET /v1/profile/interests replace the set server-side: 3-20 unique taxonomy nodes validated, weights in (0,1], sensitive rejected at write time (TR-22). Client journeyContracts.ts mirrors the 3..20 bounds (cross-pinned to profile.ts INTEREST_MIN/MAX), pins the <=3-level first interaction, and makes the FR-08/FR-11 acceptance executable: below three declarations the publish is blocked with the pinned explanation and the picker offer (constellationPicker.ts reaches three inside its interaction budget); garbage counts fail closed to blocked."),
    "FR-09": ("implemented", "POST /v1/profile/interests/link: free text (<=500 chars, screened SEC-26 idiom) is embedded with the deterministic ngram-hash-384.v1 embedder and matched over the pgvector taxonomy space (migration 0011 + generated seed); top-5 candidates above a 0.15 cosine floor, sensitive/redirected nodes excluded at seed and query time (TR-22), already-declared nodes excluded via the owner-GUC read (FR-13 discipline). Per-node confirmation: the route never writes (test-pinned) — confirmed nodes go through the governed FR-08 endpoint."),
    "FR-10": ("implemented", "Sensitive nodes excluded from vectors, reasons, idf and bonus at build time; covered by engine tests."),
    "FR-11": ("implemented", "The discoverability floor counts NON-sensitive interests via nonSensitiveCount() (engine.ts) at all three match gates — scan candidates, corpus rebuild, global prior; a node flipped sensitive by FR-59 governance after declaration stops counting, a node the taxonomy no longer knows is skipped rather than throwing. GET /v1/profile/interests returns discoverable + discoverabilityNote explaining the floor so the editor can show the reason before the user leaves the screen."),
    "FR-12": ("implemented", "Profile and corpus caches refresh on a 60 s loop (TR-05)."),
    "FR-13": ("implemented", "GET /v1/interests/:nodeId/popularity — live-cell count over declarations of the node and its descendants, kSuppressed at k=11 (BR-13); sensitive nodes indistinguishable from unknown (TR-22)."),
    "FR-14": ("implemented", "900 s Valkey TTL; stale cell members filtered at read; tested."),
    "FR-15": ("implemented", "Both halves done: the server rejects coordinate-shaped fields with 422 (TR-15), and the client computes the H3 cell on device — client/src/presence/cell.ts builds a publish payload of exactly {cell}, with payloadDiscardsCoordinates pinned by unit tests and approximate-only fixes refused (FR-88)."),
    "FR-16": ("implemented", "newPresenceSessionId (128-bit hex) on session start, kept on heartbeats, reuse rejected 409; presence:session reverse index; scan results carry sessionId+pairId — account ids never leave the edge pre-OPEN."),
    "FR-17": ("implemented", "PUT/GET/DELETE /v1/presence/intent over Valkey only: governed 8-word vocabulary (coffee/food/chat/walk/dance/network/explore/quiet), EX 3600 hard cap, requires live presence, purgePresence deletes intent:{uid} so it dies with presence; scan annotates results with sharedIntent when both sides declared the same active intent — signal only, score contract untouched (test-pinned)."),

    "FR-18": ("implemented", "users.invisible flag (migration 0004); PUT/GET /v1/account/visibility; flipping on purges live presence at once; publishes refused 403 while set."),
    "FR-19": ("implemented", "client/src/presence/presenceLifecycle.ts — backgrounding without the background-presence opt-in yields a withdraw decision pinned to the 60 s deadline and the DELETE /v1/presence wire target; foreground return cancels a pending withdrawal; FR-85 reduced power never extends the deadline. Pinned by client tests + tests/test_batch37.py."),
    "FR-20": ("implemented", "<=3 candidates with ordered reasons; unit + golden tests."),
    "FR-21": ("implemented", "Adaptive threshold: (1-5/n)-quantile floored at venue base; tested."),
    "FR-22": ("implemented", "Hard guarantee in the ranker: MMR (lambda 0.7) still orders the pool, but a candidate whose primary reason (top-contributing reason node) is already taken is skipped — no two of the at-most-three results share a primary reason; the list may come back short (FR-20 is an upper bound). Unit-pinned incl. the rotation tests."),
    "FR-23": ("implemented", "Canonical suppression keys, 600 s TTL, both directions; tested."),
    "FR-24": ("implemented", "6 scans/min per user at the edge; tested."),
    "FR-25": ("implemented", "Bands from H3 grid distance only; no metres/bearing/cell ids in responses."),
    "FR-26": ("implemented", "Explanatory empty state below 8 discoverable users in scope; tested."),
    "FR-27": ("implemented", "Ordered reason path in every scan payload; /v1/score re-scores any explicit pair."),
    "FR-28": ("implemented", "budget.ts ladder (sparse <25: 3/hr; busy <100: 2/hr; crowd: 1/day) enforced in scan.ts via budget:scan:{uid} Valkey counters; separate from the SEC-20 abuse ceiling."),
    "FR-29": ("implemented", "DETECTED>NUDGED>EXPRESSED>MUTUAL>OPEN enforced by DB trigger; DETECTED recorded on first surfacing; tested."),
    "FR-30": ("implemented", "Identity RLS-gated to OPEN; verified by policy + edge tests."),
    "FR-31": ("implemented", "One wave per offer via illegal-transition rejection; the wave carries no content."),
    "FR-32": ("implemented", "Silent decline: POST /consent/:id/decline always answers 204, publishes 'expired'; maskCloseReason maps declined>expired; tested."),
    "FR-33": ("implemented", "30-min offer window: expires_at set at first surfacing, renewed per action; lifecycle_tick expires overdue offers; tested."),
    "FR-34": ("implemented", "Blocking: blocks table (no UPDATE/DELETE grants), permanent Valkey blockKey, scan excludes both directions via blocked_users_for; pair closes silently."),
    "FR-35": ("implemented", "Append-only ledger, no-update trigger, actor+timestamp per row; the sole exception is a transaction-local purge mode reachable only from SECURITY DEFINER retention functions (NFR-19/21); tested."),
    "FR-36": ("implemented", "Server stores opaque MLS envelopes only (bytea), RLS-gated to OPEN members; client MLS integration pending."),
    "FR-37": ("implemented", "24-h conversation clock: closes_at set on OPEN, /consent/:id/keep from both sides clears it; lifecycle_tick lapses the rest; messages RLS gates on closed_at."),
    "FR-38": ("implemented", "First message per sender per pair screened at the edge for links/phones/emails/bypass/scam patterns before storage; rejection is inline and category-level, nothing stored; tested. With MLS the same classifier runs in the client compose path (TECH-08)."),
    "FR-39": ("implemented", "Only text envelopes exist; no media/voice/file paths to disable."),
    "FR-40": ("implemented", "POST /v1/reports anchors to the offer identifier: pair_id (+ optional message_id) columns on reports (migration 0019, ON DELETE SET NULL so anchors detach with NFR-20/erasure while the report survives), validated under RLS — a pair or message the reporter is not part of is simply not found; a pair anchor defaults reported to the counterpart. The in-conversation control itself is client work over this contract."),
    "FR-41": ("implemented", "DELETE /v1/pairs/:pairId/messages/:messageId — sender-only (RESTRICTIVE policy + column-limited grant), 24-h window blanks the envelope and tombstones; 410 after. Client journeyContracts.ts mirrors the window and the pinned 410 sentence (revocation offered only for the user's own messages inside the window; garbage and future timestamps fail closed) and pins the local-delete honesty note; conversationThread.ts wires the per-message revoke plan, renders the 410 notice past the window, and plans local deletion."),
    "FR-42": ("implemented", "venues is now the full registry (migration 0020): partner_status (prospect/active/suspended/offboarded) with venues.active derived by trigger, operating_schedule jsonb shape-checked by operating_schedule_valid() (timezone + weekly day/open/close HH:MM), suspended_at; cells map through the cell_attribution projection (0017). GET /v1/venues/:id/registry serves cells+status+schedule (BR-12), PUT .../schedule replaces it, offboard is venue-ops-only; every mutation is SECURITY DEFINER with an admin_audit row."),
    "FR-43": ("implemented", "events = venue + window (0001). Presence published at a venue with a live event (starts_at <= now < ends_at) attributes to it: the entry carries eventId, presence:event:{id} keeps the live set under the NFR-18 TTL, the publish reply echoes {eventId, name}, moving between events/leave/venue suspension all strip the attribution, and dashboard + registry surface the live event with k-suppressed presence."),
    "FR-44": ("implemented", "Crowd-band transition: GET /v1/venues/:id/rooms lists rooms derived owner-side (room_topics() SECURITY DEFINER) from live members' declared non-sensitive interests; below crowd the list is empty with the mode field; scan responses announce mode=rooms + roomsUrl in the crowd band; joins need live venue presence, a still-crowded venue and a declared interest in the topic."),

    "FR-45": ("implemented", "Room content rules: opaque roomKey (sha256 venue:node), topic, kSuppressed member count, member-only GET with uniform 404, opt-in join/leave; notes carry no author field — opting in is what publishes; everything lives in Valkey with presence-aligned TTL (900s), no room table in Postgres (test-pinned)."),

    "FR-46": ("implemented", "Posting discipline: SET NX EX 300 gate → one note per member per room per five minutes (429); first note per member per room screened via screenText (SEC-21 idiom, room:screened marker), later notes not re-screened; notes ring-buffered at 50 with TTL refresh on activity."),

    "FR-47": ("implemented", "Resolution ladder 9>10 (2 000) >11 (10 000) on live venue density; tested."),
    "FR-48": ("implemented", "Venue check-in codes live via FR-99/FR-100 signed per-floor tokens: the venue mints at POST /v1/venues/:venueId/checkin-tokens (printed as the per-floor QR/NFC code — the displayable artefact) and the user presents at POST /v1/presence/checkin for (venueId, floorId) attribution. Client journeyContracts.ts pins the higher-than-cell confidence ordering (FR-89: indoors the cell is the fallback, never the default), the fail-closed code journey, and the tie to the FR-88 refusal's pinned alternative (publishGate.ts)."),
    "FR-49": ("implemented", "reports.category NOT NULL with the six governed values (harassment, impersonation, under_age, commercial_solicitation, hate, other) as a CHECK constraint (migration 0019); the edge requires it in the report schema via REPORT_CATEGORIES (services/edge/src/reports.ts) — pinned equal to the SQL list by test_reporting_compliance.py so the vocabularies cannot drift."),
    "FR-50": ("organisational", "24/7 4-h high-severity triage — staffing/rota (BR-16) plus the moderation console (FR-54)."),
    "FR-51": ("implemented", "Cryptographic verified enrolment (migration 0021): challenge-bound ECDSA P-256 assertion verified against the presented key, monotonic counter enforced inside register_verified_attestation() (replays never honour the write), FR-07 dedupe semantics preserved with the same neutral 201. The discovery gate is structural: the match service reads profiles only for accounts in the attested_accounts view (verified keys + approved fallbacks) — an unattested account has no corpus profile and cannot appear in results. Pins: test_batch29.py + edge attestation.test.ts (real P-256 pairs)."),
    "FR-52": ("implemented", "trust_score() (db/migrations/0008): deterministic SECURITY DEFINER score — base 0.50, +0.20 age-verified, +0.10 at 30/180 days, -0.15/actioned report (cap -0.45), +0.05/dismissed (cap +0.15), -0.02/unresolved (cap -0.10), clamped [0,1]; drives the moderation queue ordering and account card."),
    "FR-53": ("implemented", "users.investigation_removed_at (discovery gate shares the neutral FR-02 error) + silent purgePresence (no realtime event) via POST /v1/moderation/accounts/:id/investigation-remove|restore; appeals table (one open per account, partial unique index) with POST/GET /v1/account/appeals (screened SEC-26) and console resolve — overturn lifts the suspension and clears the removal in one transaction."),
    "FR-54": ("implemented", "Workforce-realm moderator gate (requireModerator + per-issuer JWKS, app.moderator GUC via withModerator) fronting 8 console routes: trust-ordered queue, account card (trust inputs, suspensions, report stats, account_ledger_stats aggregates, liveNow, audit trail — never message content), report resolve, investigation remove/restore, suspension lift, appeals queue/resolve; every action admin_audit-logged with governed reason codes."),
    "FR-55": ("implemented", "suspensions table + suspension_dimension enum (attestation_key/handle/payment_instrument), one active per (user, dimension) partial unique index; attestation gate wired into presence publish (neutral 403), handle mask via display_handle() inside group_member_directory, payment_instrument record-only until the P3 payments surface; lift is per-dimension."),
    "FR-56": ("implemented", "Push pipeline shipped (edge push.ts): buildPushPayload derives exactly {type, ref} from notification events — an allowlisted opaque identifier only, never profile content/reason/handle/location, with assertMinimalPayload as the send-side gate. APNs background push + FCM data-only providers, env-gated (dormant without credentials, k8s optional secretKeyRefs via the SEC-28 store); dead tokens dropped via drop_push_token(). Device tokens registered per device (PUT /v1/devices/:deviceId/push-token, owner-RLS; migration 0021). Dispatch rides notifyUser after the realtime publish, inheriting the FR-57/58 gates. Pins: test_batch29.py + edge push.test.ts."),
    "FR-57": ("implemented", "POST /v1/consent/:pairId/nudge (DETECTED→NUDGED ledger transition, window renewed) capped at 3/sender/UTC-day via Valkey (429); recipient quiet window {start,end} HH:MM UTC (overnight-aware, equal=disabled) stored in notification_prefs and editable via PUT /v1/account/notifications; realtime event suppressed in the window or when the nudges category is off; the event carries no actor identity (FR-30)."),
    "FR-58": ("implemented", "GET/PUT /v1/account/notifications over users.notification_prefs: six categories default-on, safety exemption enforced (422 on safety=false). Delivery side: shouldNotify()/notifyUser() are the single gate for every realtime user-channel send — safety notices (device_enrolled, announcement_removed) always pass switch and quiet window; nudge (nudges) and pair-open (matches) events gate on the recipient's prefs; announcements/offers are pulled surfaces (no push path), so their switches are trivially honoured."),
    "FR-59": ("implemented", "Taxonomy CMS (migration 0012 + /v1/taxonomy/releases console): draft → submit → approve (second-person, author <> reviewer enforced in SQL) → publish → one-action rollback of the latest published release. Six governed ops (add_node/edit_label/set_sensitive/deprecate/add_link/remove_link; node deletion is not an operation — history is deprecated, never destroyed). Publish snapshots, applies re-validated ops, rebuilds the closure and re-syncs embeddings in one transaction; rollback restores the snapshot as a delta and never touches rows user data references (SECURITY DEFINER reference count, FR-13 discipline). Write-guard triggers keep live taxonomy SELECT-only to the app role outside the CMS; every route gated by requireTaxonomist + app.taxonomist GUC; publish/rollback audited (FR-60)."),
    "FR-60": ("implemented", "db/migrations/0006 admin_audit — append-only (immutability trigger for every role), actor/action/reason_code/target/before+after jsonb; SECURITY DEFINER admin_audit_log writer for ops and the FR-54 console."),
    "FR-61": ("implemented", "analytics/extract.py + schemas.py: the production boundary enforces identifier exclusion structurally — per-kind allowlists plus a denylist that rejects identifiers, coordinates and message content even if allowlisted by mistake; the H3 cell is the only location signal (cell-resolution floor before storage). Tested in tests/test_analytics_schemas.py."),
    "FR-62": ("implemented", "GET /account/export assembles the full subject record (profile, interests, pairs, ledger actions, blocks, reports) via dsar_export() with FR-32/34 masking intact; erasure via DELETE /account."),
    "FR-63": ("implemented", "db/migrations/0006 venue_features (default-on, ops-written with admin_audit) + features.ts consulted by the announcements route (403 when disabled); further surfaces inherit as they land."),
    "FR-64": ("implemented", "profile_prompts (slot 1-3, varchar 120) behind PUT/GET /v1/profile/prompts, screened like announcements (SEC-37); attached to surfaced scan candidates as reason material; no search endpoint, no content index."),
    "FR-65": ("implemented", "PUT/GET /v1/pairs/:pairId/link over pair_links: OPEN-gated by an RLS policy mirroring messages, one link per member (upsert keeps shared_at), counterpart-only reads (owner <> caller), https-only + <=300 chars at the data layer; the server stores and returns the string and never fetches it (SEC-34)."),
    "FR-66": ("implemented", "group_tables + group_table_members with member-only RLS; create/join require live venue presence; the six-seat cap is a data-layer trigger (SEC-33), re-join idempotent; self-serve leave, host remove, last-member-out closes."),
    "FR-67": ("implemented", "GET /v1/tables/:id/cards — join-time snapshot (group_table_interests, joining is the act that shares) aggregated over nodes shared by >=2 members, sensitive excluded, ranked by reach, top 5; every card labelled generated:true (buildCards, unit-tested)."),
    "FR-68": ("implemented", "table_slots (5-60 min, future start) + slot_bookings: the booking row IS the consent act (actor+timestamp, PK caps one booking per slot); conditional state flip guards races; cancel by booker or offerer re-opens future slots, idempotent."),
    "FR-69": ("implemented", "Exactly-one-host trigger + creator seated as host; group_member_directory (SECURITY DEFINER) returns co-member handle+role to members only — the scoped FR-30 carve-out; no photos, nothing leaves the table."),
    "FR-70": ("implemented", "client/src/presence/verificationBadge.ts — the identity-reveal registry is exactly the three SRS surfaces (offer, table-roster, booked-slot; account settings is NOT one); a reveal is built from the FR-51 attestation state alone with the badge label pinned (a surface cannot forge a friendlier status), and unregistered surfaces, blank names and garbage states fail closed to null; the audit flags a label that does not match its state. Pinned by client tests + tests/test_batch43.py."),
    "FR-71": ("implemented", "Recurrence signal: recur:<sha256(lo:hi)> key names nobody; {days, lastDay} day-ordinal counter bumped at most once per UTC day on scan surfacing (bumpRecurrence), EX 90 days retention; wire carries recurrenceDays only — never a timestamp (test-pinned)."),

    "FR-72": ("implemented", "tests/test_group_surface.py asserts the cap/single-host triggers, RLS on all six tables, member-only policies, creator-scoped insert, the member-scoped directory (no photos), the open-only join probe, and membership-scoped listing with uniform 404s."),
    "FR-73": ("implemented", "tests/test_group_surface.py asserts the slot_bookings PK double-book guard, state/duration CHECKs, actor-scoped booking/cancel policies, column-limited grants, the atomic state flip, and host-action audit logging."),
    "FR-74": ("implemented", "Host remove and close write admin_audit rows (FR-60, governed host_discretion reason); host visibility stops at directory name+role; a host with members cannot leave (409) — they close the table instead."),
    "FR-75": ("implemented", "GET /v1/tables returns only the caller's memberships (no venue-wide listing exists); every table/slot-scoped route answers a uniform 404 to non-members; group_join_info reveals only venue+headcount of open tables, closed indistinguishable from nonexistent."),
    "FR-76": ("implemented", "client/src/presence/matchSurface.ts — the match surface is built ONLY from the TR-35 MatchDiagram (itself derived from one scan result, no round trip): one ConvergingPath per shared node, a headline that names the commonality ('what you have in common'), a fixed {headline, paths} field set no photo/name/handle can occupy, and the matchSurfaceViolations guard scanning against the FR-87 registry + FORBIDDEN_MATCH_IDENTITY_FIELDS. Pinned by client tests + tests/test_batch39.py."),
    "FR-77": ("implemented", "Structural: no endpoint exposes maps, bearings, distances, radii, or proximity arrangements. Client side, client/src/presence/surfaceIntegrity.ts pins the PROHIBITED_PROXIMITY_ELEMENTS registry every surface descriptor is audited against, and client/src/presence/presenceHalo.ts renders density with a fixed {intensity, level} field set — no positional or directional component exists in the type. Pinned by tests/test_batch39.py."),
    "FR-78": ("implemented", "client/src/presence/presenceHalo.ts — density as an undirected field: a 0..1 intensity rising monotonically with the k-anonymised aggregate count (HALO_FULL_SCALE 20, clamped), a qualitative level (calm/stirring/lively/buzzing) forbidden from carrying digits so the raw count cannot leak, and invalid counts failing closed to the calmest field. haloHonoursFr77 asserts the descriptor against the FR-77 registry. Pinned by client tests + tests/test_batch39.py."),
    "FR-79": ("implemented", "client/src/presence/offerWindow.ts — expiry as a closing perimeter: a 0..1 fraction monotonic non-increasing over OFFER_WINDOW_MS (mirror of edge OFFER_TTL_MS, pinned equal), DEFAULT_EXPIRY_PRESENTATION 'perimeter', and secondsRemaining physically null unless the user explicitly opted into the numeric form — the default render never computes a countdown. Pinned by client tests + tests/test_batch39.py."),
    "FR-80": ("implemented", "client/src/presence/discoverySkeleton.ts — pairs/rooms/tables share one pinned region list (header/modeSelector/resultRegion/statusTray); only resultContent differs (skeletonSharedAcrossModes guard). Each mode has a pinned one-sentence explanation shown once per user (seen-set under the allowlisted presence.ui.seenExplanations key, TR-30 wiped, parse fails toward explaining again); planModeChange defers any switch while a conversation is open. SKELETON_AFFORDANCES has no load-more — the result region renders one bounded payload. Pinned by client tests + tests/test_batch39.py."),
    "FR-81": ("implemented", "client/src/presence/constellationPicker.ts — PICKER_MODES pinned to constellation + search (spatial alongside text); every ConstellationNode is selectable at any depth (the selectable:true literal type), so interactionsToDeclare is pinned at 3 against MAX_PICKER_INTERACTIONS 4 with exactly one spare; auditInteractionSequence re-checks real sequences at runtime; renderPopularity returns null below POPULARITY_K_FLOOR 11 (cross-pinned to edge aggregate K_MIN) so a raw small count never renders. Pinned by client tests + tests/test_batch40.py."),
    "FR-82": ("implemented", "client/src/presence/holdToWave.ts — WAVE_PRESS_MIN_MS 400: waveProgress ramps 0..1 with quartered haptic stages (monotonic non-decreasing, garbage fails closed); evaluatePress returns 'wave' only at or beyond the threshold on-control — early release cancels, moving off the control cancels at any duration, and tapCannotWave proves no sub-threshold tap can ever fire. Pinned by client tests + tests/test_batch40.py."),
    "FR-83": ("implemented", "client/src/presence/haptics.ts — CONSENT_TRANSITIONS pins the five legal FR-29 transitions (cross-pinned to services/consent-go/statemachine.go); each has a distinct haptic signature (hapticsAreDistinct proves pairwise difference) plus a named audio cue and spoken announcement (audibleWithoutHaptics) so every state change survives haptics-off and eyes-free; unknown transitions fail closed to no feedback. Pinned by client tests + tests/test_batch40.py."),
    "FR-84": ("implemented", "client/src/presence/closeOffer.ts — COLOCATION_CLOSE_OFFER_MIN_MS 15 min, open conversation required, broken clocks fail closed; the offer carries the pinned CLOSE_OFFER_BASIS ('if you've met…'); accepting closes thread + notifications, declining returns the conversation snapshot byte-identical (declineLeavesIntact) and is never re-asked (due → shown → declined|accepted, no return). Pinned by client tests + tests/test_batch40.py."),
    "FR-85": ("implemented", "client/src/presence/powerMode.ts — standard 300 s / reduced 600 s publish intervals, both strictly below the FR-14 900 s session TTL; the pinned REDUCED_POWER_NOTICE states matches arrive less timely; the selection persists under presence.powerMode (TR-30 allowlist, wiped on logout). Pinned by client tests + tests/test_batch37.py."),
    "FR-86": ("implemented", "client/src/presence/ambientSurfaces.ts — the three named surfaces (lockScreenIndicator, liveActivity, homeScreenWidget) are individually opt-in via setAmbientPreference (one surface per flip), defaultAmbientPreferences is all-false, planDisable is pinned to one action with no confirmation step; preferences persist under the allowlisted presence.ambient.prefs key (TR-30 wiped) and parse fails closed to all-off. Pinned by client tests + tests/test_batch40.py."),
    "FR-87": ("implemented", "client/src/presence/surfaceIntegrity.ts — the single PROHIBITED_ENGAGEMENT_PATTERNS registry (infinite/auto-loading scroll, typing indicators, read receipts, streaks, daily-login rewards, like/view counts, photo-at-match) every surface descriptor is audited against via descriptorViolations; the discovery surfaces (matchSurface, presenceHalo, offerWindow, discoverySkeleton) pass the guard by construction with pinned affordance lists, and the conversation surfaces inherit the same registry. Server-side the patterns remain structural (no endpoint serves the data). Pinned by client tests + tests/test_batch39.py."),
    "FR-88": ("implemented", "client/src/presence/publishGate.ts — the platform accuracy grant is read before any publish; only an explicit precise grant publishes, approximate/garbage fails closed with the pinned one-sentence refusal and the venue check-in offer (POST /v1/presence/checkin, FR-99/100). The fix-accuracy half stays in cell.ts (MAX_FIX_ACCURACY_M). Pinned by client tests + tests/test_batch37.py."),
    "FR-89": ("implemented", "Check-in is the primary indoor presence path end to end: signed per-floor tokens + floor attribution server-side (FR-99/FR-100), and the client indoorPresence.ts contract resolves the primary action to venue check-in via the FR-48 confidence ordering — the cell appears indoors only as the explicit fallback with the pinned notice, an empty code still presents check-in first while refusing at the wire, and garbage venue context fails closed."),
    "FR-90": ("implemented", "Full loop: venues.geofence canonical polygon (TR-41 review workflow) → lakehouse spatial join publishes cell_attribution (TR-38) → presence publish applies version-checked polygon precedence via PK lookup (services/edge/src/attribution.ts). geofence_version triggers version the polygon with the venue record; a revision suspends attribution until republication, so a stale map never mis-scopes presence."),
    "FR-91": ("implemented", "rotate:{lo}:{hi} keys (EX 604800) set on consent express and excluded from scans; per-user tbreak counter feeds the match service's seeded sha256 tie-break."),
    "FR-92": ("implemented", "client/src/presence/cellStabiliser.ts — sliding 5-min sample window; the published cell is the mode of the window (deterministic ties: frequency, recency, cell id); movement > 1 h3 grid step publishes fresh immediately, and unmeasurable distance counts as movement, never as same place. Pinned by client tests + tests/test_batch37.py."),
    "FR-93": ("implemented", "POST /v1/announcements: 24-h account trust floor (isTrustedPublisher), effectiveTtlMinutes clamps to the 4-h cap, category on insert."),
    "FR-94": ("implemented", "announcement_responses + accept route; publicResponse masks the responder id until accepted_at is set."),
    "FR-95": ("implemented", "One-live (409) and 24-h publish cooldown (429) edge-side; UNIQUE(announcement_id, responder); responses listing LIMIT 5."),
    "FR-96": ("implemented", "Fixed category enum (schema + CHECK); bodies and responses screened with screenText, category-coded 422 (SEC-37)."),
    "FR-97": ("implemented", "canPublishCategory refuses the work category unless the token carries verified_org (BR-33)."),
    "FR-98": ("implemented", "reports.announcement_id + maybe_remove_announcement (2 reports/10 min, removed_at retained); publisher notified via Centrifugo; reads filter removed rows."),
    "FR-99": ("implemented", "venue_floors (0005) with per-floor polygons + connected_to; presence floorId attribution validated against declarations; same-venue scans floor-scoped via floorsCompatible."),
    "FR-100": ("implemented", "HMAC-SHA256 pc1.<claims>.<sig> tokens, TTL<=300s, mint (partner) + verify (user) routes; NFC/QR printing is venue-side ops of the same token format."),
}
CLASSIFICATION.update({
    # ---------------- NFR ----------------
    "NFR-01": ("external-evidence", "Scan server latency p95 <=150 ms — load evidence (ACC-04)."),
    "NFR-02": ("external-evidence", "Scan server latency p99 <=400 ms — load evidence (ACC-04)."),
    "NFR-03": ("external-evidence", "Presence publish ack p95 <=120 ms — load evidence."),
    "NFR-04": ("partial", "client/src/presence/startupBudget.ts — pinned phase ledger (native-init/js-bundle/secure-store/config-cache/first-render/handoff summing to exactly 1800 ms), deferred work (BLE start, prefetch, flush) banned from the critical path by audit; on-device profiling on the reference mid-tier remains."),
    "NFR-05": ("partial", "client/src/presence/startupBudget.ts — the same ledger's warm column: resume pays nothing for the resident native runtime or JS bundle, sums to exactly 600 ms, no warm phase dearer than its cold twin; on-device profiling remains."),
    "NFR-06": ("external-evidence", "Tap-to-results p95 <=900 ms — end-to-end measurement with the client."),
    "NFR-07": ("implemented", "The server leg of sender-to-device delivery is measured and SLO-alerted: publishRealtime times every broker call into presence_realtime_publish_duration_seconds per channel class and counts failures; RealtimeDeliverySlow (prometheusrules.yaml) pages realtime-oncall when the publish p95 exceeds the 500 ms budget for 15 min; runbook entry + ServiceMonitor scrape wired. The device-leg confirmation rides on client telemetry."),
    "NFR-08": ("external-evidence", "25 000 concurrent presences per city cluster — capacity test."),
    "NFR-09": ("external-evidence", "600 scans/s at p95 peak — capacity test."),
    "NFR-10": ("external-evidence", "60 000 single-venue burst per 10 min — capacity test."),
    "NFR-11": ("external-evidence", "Linear 2x scale-out without schema/client change — K8s HPA + test."),
    "NFR-12": ("external-evidence", "250k-node taxonomy at match latency targets — scale test (TR-21)."),
    "NFR-13": ("external-evidence", "99.9% measured scan-path availability — production measurement."),
    "NFR-14": ("implemented", "Graceful degradation in the edge scan route: a matcher error or an unreachable matcher returns the structured { state: 'paused', results: [] } — the client shows 'discovery paused', never an error; presence is independent of the matcher and unaffected."),
    "NFR-15": ("external-evidence", "RTO <=60 min single-zone loss — the restore path is in-repo (batch 51): restore-rehearse.sh runs the timed restore against a hard 3600 s RTO budget and fails on breach; runbook in docs/ops/backup-restore.md. Production timing evidence comes from the quarterly drill."),
    "NFR-16": ("external-evidence", "RPO <=5 min consent ledger (PITR, INF-18) — archive_timeout=300 on the postgres args (compose + k8s) forces a WAL segment at least every 5 minutes and wal-archive.sh ships every segment encrypted; production freshness measurement outstanding."),
    "NFR-17": ("implemented", "Presence RPO deliberately zero — Valkey-only, disposable by design; documented."),
    "NFR-18": ("implemented", "15-min session TTL (900 s) + 45-min index grace: presence:user and the FR-16 session reverse index keep EX 900; the cell/venue index sets carry EX 3600 refreshed per publish, and lapsed members are pruned on the next publish in the cell — the session's cell stays attributable for the grace window and residue is bounded either way."),
    "NFR-19": ("implemented", "24-h visibility masking (GET /consent) + lifecycle_tick hard-deletes pre-OPEN closed pairs with their ledger rows after 24 h, under the governed purge mode."),
    "NFR-20": ("implemented", "lifecycle_tick deletes messages 24 h after pair close; messages RLS blocks reads on closed pairs immediately."),
    "NFR-21": ("implemented", "Ledger append-only for all app traffic (governed purge mode is unreachable by the app role); lifecycle_tick anonymises actors 90 days after account deletion."),
    "NFR-22": ("implemented", "reports_retention_tick() (migration 0019) disposes of reports — and the moderation decisions recorded on them (outcome/resolved_by/resolved_at) — 12 months after filing; SECURITY DEFINER, driven by the edge lifecycle job alongside lifecycle_tick, and every disposal is itself audited into security_audit (retention.purge). Appeals keep their own record; the report FK detaches (SET NULL)."),
    "NFR-23": ("implemented", "analytics/retention.py enforces a 25-month rolling window on silver and gold (month partitions pruned every run; bronze 90 days per ARC §6.1). The SRS schedule caps the ARC indefinite wording — pinned in tests/test_retention.py."),
    "NFR-24": ("external-evidence", "35-day backup retention — enforce-retention.sh CronJob (daily 03:41 UTC) with a hard 35-day floor that refuses shorter windows and never deletes the newest restorable chain; production ops cadence outstanding."),
    "NFR-25": ("implemented", "client/src/presence/accessibility.ts — WCAG 2.2 AA as code: relative-luminance contrast (4.5:1 normal / 3:1 large and non-text) audited over the pinned shell palette (the audit caught the note colour at 3.50:1 — moved to #74879B); dynamic type pinned to the 200 % resize floor (clamped, garbage fails closed to 1); reduced motion is a pinned instant fallback with unreadable preference treated as reduce; screen-reader labelling and focus order audited per control (non-empty label, registered role, unique non-negative focus position). On-device VoiceOver/TalkBack validation is the named residual beyond code. Pinned by client tests + tests/test_batch43.py."),
    "NFR-26": ("implemented", "client/src/presence/accessibility.ts — every interactive control declares a touch TARGET (not a glyph size) and the audit requires >= 44 x 44 pt in both dimensions; undersized or non-finite targets are violations. Pinned by client tests + tests/test_batch43.py."),
    "NFR-27": ("implemented", "client/src/presence/copyRegistry.ts — one copy registry keyed off the English launch baseline; a locale is pure data (BCP-47-lite tag + string map) so adding one needs no code change (proven by the master guard registering a synthetic locale at runtime); missing keys fall back to the English floor, unknown keys fail closed to null, malformed tags/bundles resolve as English; localeCoverage/localeIsLaunchReady set the full-coverage bar for the pinned +2-locales-in-3-months commitment; the shell renders title/subtitle through the registry with ACTIVE_LOCALE=null. Pinned by client tests + tests/test_batch44.py."),
    "NFR-28": ("implemented", "client/src/presence/bleFloor.ts — OS floors pinned in code (IOS_FLOOR_MAJOR 16 / ANDROID_FLOOR_API 29) and cross-checked against app.json (deploymentTarget/minSdkVersion) by tests/test_batch44.py; boundary-exact (floor supported, one below refuses with pinned upgrade notice, non-finite fails closed); the BLE capability ladder advertise+scan -> scan-only -> none degrades attestation two-way -> witness-only -> off with pinned notices, and every supported OS/capability combination is proven dead-end-free through the TR-32 resolver; garbage readings fail closed to the least radio. Pinned by client tests + tests/test_batch44.py."),
    "NFR-29": ("partial", "client/src/presence/powerBudget.ts — duty-cycle ledger: fixed consumers (BLE advertise/scan, UI render) plus publish+cell activations computed from the FR-85 cadence (12/h standard, 6/h reduced), both modes inside the 2 %/h ceiling; on-device battery profiling remains."),
    "NFR-30": ("partial", "client/src/presence/powerBudget.ts — structural half landed: the background work registry is EMPTY when background presence is off (parity by doing nothing), exactly ble-central-wake when on, cross-pinned to app.json UIBackgroundModes and blocked ACCESS_BACKGROUND_LOCATION; the no-op-parity measurement remains device-side."),
    "NFR-31": ("implemented", "End-to-end: APISIX request-id generates/echoes X-Request-Id; the edge's genReqId honors a charset-validated incoming id (resolveRequestId, visible ASCII <=128) else mints a uuid and echoes it on every response (onSend); the scan route forwards x-request-id to the match service, whose own genReqId honors/echoes it the same way — one trace id spans gateway -> edge -> match, and Fastify logs carry reqId at every hop."),
    "NFR-32": ("implemented", "The four §2.5 product metrics (scan.surfaced_rate, surfacing.express_rate, mutual.open_rate, open.first_message_rate) are computed by one pass over telemetry_events (migration 0013). Events are written synchronously by the causing request — scan completed/DETECTED in the scan route, EXPRESS/NUDGE/OPEN in the consent routes, pair-first message in the messages route — never queued or batched (test-pinned), so the five-minute computability budget is met by construction; GET /v1/telemetry/metrics reports the age of the newest underlying event as evidence. Aggregate dims only — no user ids, pair ids or cells (test-pinned)."),
    "NFR-33": ("implemented", "deploy/k8s/prometheusrules.yaml — one PrometheusRule alert per required class, each with severity and owner; every alert-input series is emitted (edge services/edge/src/metrics.ts: http duration/requests, publish failures, realtime publish duration, moderation queue age refreshed on scrape; match services/match/src/metrics.ts: scan demand + served) and scraped via deploy/k8s/servicemonitor.yaml with the monitoring namespace admitted by the network policy."),
    "NFR-34": ("implemented", "docs/runbook.md — per-alert symptom/impact/first-actions/escalation, owner named per alert."),
    "NFR-35": ("partial", "client/src/presence/frameBudget.ts — pinned render ledger (layout/path-geometry/label-measure/paint-commit = 16 ms) fits the 60 fps frame budget AND the 30 ms floor, audited fail-closed; on-device fps profiling remains."),
    "NFR-36": ("implemented", "client/src/presence/frameBudget.ts — ambient refresh gated to at most one per minute (garbage clocks refuse, fail closed); refresh sources pinned to push/app-active only — poll is absent by construction, so an idle device never wakes the radio; AMBIENT_NETWORK_FETCHES_PER_REFRESH = 0 and an approved refresh carries the SEC-35 contentless payload built locally. Pinned by client tests + tests/test_batch42.py."),
    "NFR-37": ("implemented", "client/src/presence/accessibility.ts — the primary action passes only when its top edge sits at or below the lower-40% line (fraction 0.6 pinned; 6.1-inch / 844 pt reference device); garbage geometry fails closed. Pinned by client tests + tests/test_batch43.py."),
    # ---------------- TR ----------------
    "TR-01": ("implemented", "Edge + match are stateless; all state lives in Valkey/Postgres."),
    "TR-02": ("implemented", "The scan path never calls Postgres: the match HTTP surface reads profiles exclusively through Store.cachedProfile (cache-only; a miss warms asynchronously and the candidate joins discovery next scan — cold-start bounded at one CORPUS_REFRESH_MS cycle since the 60 s corpus loop warms every live presence member anyway). Pinned by tests/test_batch27.py and services/match/test/store-cache.test.ts."),
    "TR-03": ("implemented", "Mesh decision made (ADR-0010: Linkerd) and wired: the presence namespace carries linkerd.io/inject: enabled so every pod-to-pod flow is mutually authenticated and encrypted transparently; the NetworkPolicies remain the flow allowlist underneath. Install + verification steps (linkerd check / linkerd viz edges) documented in deploy/k8s/README.md."),
    "TR-04": ("implemented", "0.55/hop, depth <=4, max-combine — pinned against the answer key (653/653)."),
    "TR-05": ("implemented", "df over live presence, link-free closures, 60 s refresh loop."),
    "TR-06": ("implemented", "sqrt(ln(1+N/(1+df))) with cap — pinned."),
    "TR-07": ("implemented", "Links contribute one hop at authored weight <=0.5, excluded from df — pinned."),
    "TR-08": ("implemented", "Ordered reasons with node ids, labels, contributions in every response."),
    "TR-09": ("implemented", "Deterministic template rendering; no LLM anywhere in reason generation."),
    "TR-10": ("implemented", "81 Python tests incl. 60 key-pinned pairs; 120-pair TS golden parity at 1e-9."),
    "TR-11": ("implemented", "venues.base_threshold / max_scan_results configurable per venue row without deployment."),
    "TR-12": ("implemented", "H3 res 9 default; k=1 ring; tested."),
    "TR-13": ("implemented", "Responses carry bands only — no neighbour cell or ring distance."),
    "TR-14": ("implemented", "Descent at 2 000 / 10 000 live presences; tested."),
    "TR-15": ("implemented", "Coordinate-shaped payload fields hard-422; tested."),
    "TR-16": ("implemented", "h3-pg v4.2.1 builds into the deploy postgres image (deploy/postgres/Dockerfile, pinned tag, vendored H3 core submodule). market_config.center_cell is a native h3index column (migration 0014) and market resolution runs native operators in the database — market_for_cell(h3index) compares h3_cell_to_parent at the centre's own resolution. Presence ephemera stays Valkey-only by design; the native type serves configuration and every future persisted cell need."),
    "TR-17": ("implemented", "Graph enforces an acyclic hierarchy <=5 levels + typed non-hierarchical edges."),
    "TR-18": ("implemented", "taxonomy_closure materialised, rebuilt by the seed/export pipeline."),
    "TR-19": ("implemented", "Deprecation is a redirect, never a rename: both engines resolve redirect_to (4-hop cap, loops terminate) at profile-vector entry — resolveProfile/resolve_profile re-home declared weights onto live nodes (max-combine, insertion order preserved → golden parity holds when no redirects exist); the match store loads the column; the edge interests PUT rejects deprecated nodes with 422 + the redirect target."),
    "TR-20": ("implemented", "taxonomy_releases carries a monotonic version from the taxonomy_release_version sequence (assigned at publish only, UNIQUE), full provenance (author, reviewer, published_by, rolled_back_by + per-transition timestamps) and a diff summary jsonb counted per operation class; the pre-publish snapshot is stored on the release as the rollback basis. Exposed on the release list/detail console endpoints."),
    "TR-21": ("implemented", "250k-node closure <10 min enforced in CI: scripts/scale_taxonomy_closure.py builds a deterministic 250k-node taxonomy (depth-capped like the governed one) and rebuilds the closure with the exact WITH RECURSIVE block extracted verbatim from migration 0012 — the harness cannot drift from production. The taxonomy-scale CI job runs it against a postgres:17 service on every PR and push, asserting both the 600-s budget and the exact closure row count; the walk semantics (ancestors only, hops 1..4) are additionally executed against SQLite in the acceptance tests."),
    "TR-22": ("implemented", "Sensitive nodes skipped at vector construction (write time), not query time."),
    "TR-23": ("implemented", "docs/api/openapi.yaml is the machine-readable contract; every /v1 body/query/params carries a JSON Schema with additionalProperties:false under ajv strict mode — unknown fields hard-400 before the handler runs."),
    "TR-24": ("implemented", "Optional Idempotency-Key honoured on all mutating endpoints: idem:{uid}:{key} pending-lease/24h record in Valkey, replay + 409-in-flight semantics, 5xx clears."),
    "TR-25": ("implemented", "services/edge/src/errors.ts: every error payload carries a stable code '<status>.<slug of the test-pinned message>' and retryable (true only for 429/5xx), attached app-wide via a preSerialization hook; rate-limited routes also carry retryAfterSeconds; setErrorHandler masks ajv validation detail (generic 400), maps the rate-limit 429 with its Retry-After window, and answers a generic retryable 500 — internal identifiers, validation trees and stack traces never cross the wire; documented as the ErrorEnvelope in openapi.yaml."),
    "TR-26": ("implemented", "APISIX listener configured TLSv1.3-only with HTTP/2 (deploy/k8s/apisix.yaml); downgrade impossible at the listener; asserted by scripts/validate_deploy.py. Dev compose stays plaintext by design."),
    "TR-27": ("implemented", "Three published channels + client verdicts. Server (services/edge/src/versioning.ts): x-api-version rides every response; the bootstrap config carries api.version + api.minClientVersion (CLIENT_MIN_VERSION env, k8s+compose documented); a self-identified build below the floor answers 426 upgrade_required through the TR-25 contract, with /healthz, /metrics and /v1/client/config exempt — the detection channel itself is never refused. Client (client/src/presence/versioning.ts): evaluateBootstrapVersion at startup, evaluateResponseVersion per response, evaluateDiagramSpec for TR-35 payloads; every unsupported signal converges on the pinned UPDATE_PROMPT copy — an explicit update path, never a silent failure. Malformed signals fail open: a server bug must not brick installs."),
    "TR-28": ("implemented", "All expiry windows use server now(); no client-clock input anywhere."),
    "TR-29": ("implemented", "client/src/presence/cell.ts: computePresenceCell turns a fix into an H3 r9 cell on device (h3-js — the governed library the match service shares); toPublishPayload returns exactly {cell} and refuses approximate-only fixes (FR-88, MAX_FIX_ACCURACY_M=100); payloadDiscardsCoordinates pins the no-coordinates contract under node --test."),
    "TR-30": ("implemented", "client/src/presence/localState.ts: LOCAL_STATE_ALLOWLIST of 4 namespaced keys (session refresh token, device id, notification prefs, taxonomy version); createLocalState is type-safe over allowlisted keys only; clearLocalState wipes every allowlisted key by construction (logout/uninstall); secrets backed by expo-secure-store via the platform adapter, not AsyncStorage."),
    "TR-31": ("implemented", "client/src/presence/bleCodes.ts: BLE attestation codes are derived, never stable — code = HMAC-SHA256(presence session id, 'presence-ble-v1'|windowIndex) truncated to 128 bits over a 900 s window (the SRS cap is 15 min; rotationPeriodWithinLimit pins it). The advertisement carries exactly one field — the derived code — and advertisementDiscardsIdentifiers pins that no session/device/user id can ever ride along; receivers verify the current window with at most one lookback (boundary clock skew) and reject older or future codes. Pure-TS SHA-256/HMAC (client/src/presence/sha256.ts, RFC 4231-pinned, cross-checked against node:crypto) — zero added dependencies, Hermes-safe."),
    "TR-32": ("implemented", "client/src/presence/permissions.ts: resolveCapabilities maps bluetooth/location/push denials to a degraded-but-never-dead profile. The floors are architectural: manual-checkin is always present (FR-99/FR-100 check-in tokens need no OS permission), push-denied falls back to the in-app Centrifugo realtime channel (TECH-06), and consent/chat are server-driven (FR-29). assertNoDeadEnds proves every core journey step (check-in, discover, connect, chat) keeps a satisfier across all eight permission combinations; each denial carries a user-facing impact + recovery hint."),
    "TR-33": ("implemented", "client/src/presence/certPinning.ts + GET /v1/client/config (services/edge/src/clientConfig.ts, unauthenticated bootstrap): the pin set resolves from remote config (CLIENT_TLS_PINS / CLIENT_CONFIG_VERSION env) with a monotonic configVersion (TR-20 discipline — older configs refused) and a 24 h cache TTL. Removal = clear pins server-side + bump version; clients flip on next resolve with no app update. Every failure mode fails OPEN to the OS trust store (fetch errors, enabled-with-empty-pins, malformed pins) — availability outranks pinning, the SRS anti-bricking clause as code. pinChainMatches intersects the presented chain with the active pin set when pinned."),
    "TR-34": ("implemented", "Stable governed event keys (scan.completed, consent.transitioned, pair.first_message — enforced identically by the DB CHECK and the edge constant, cross-pinned) and stable metric keys. GET /v1/telemetry/export.csv emits the presence-telemetry/v1 contract: a version marker line, then the stable column order metric_key,window_start,window_end,value,numerator,denominator; zero denominators export as empty fields, never a fake zero. Analyst console gated by the workforce analyst role + app.analyst GUC + RLS."),
    "TR-35": ("implemented", "Versioned diagram spec, renderable from the payload alone. Server (services/edge/src/diagramSpec.ts): DIAGRAM_SPEC_VERSION = 1 is the normative node/edge semantics definition (anchors you/them; one node per reason with normalised contribution share; two edges per reason labelled by the declaring side, kind carries reach semantics), stamped as diagramSpec on every scan result — client and server agree by construction, and validate_deploy pins the stamping. Client (client/src/presence/matchDiagram.ts): buildMatchDiagram derives the entire diagram from one scan result with zero network code (import-free, pinned); an unknown or absent spec refuses (never a guessed render) and routes to the TR-27 update prompt via evaluateDiagramSpec. The client/edge version equality is cross-pinned in tests/test_batch36.py."),
    "TR-36": ("implemented", "Optional global prior (all-profile link-free df, 10-min rebuild) blended with fade w(N)=(30-N)/30 — 0% shift at N>=30, exact-formula tests in TS+Python."),
    "TR-37": ("implemented", "The TR-12/14 storage-resolution ladder is per-market configuration: market_config (migration 0014) carries res_default/res_busy/res_crowd + busy/crowd presence thresholds with ordering CHECKs and a single-active-market index (BR-01). The presence route resolves the ladder via ladderForCell — native market_for_cell lookup, 60-second Valkey cache, governed fallback equal to the seeded Lagos row so day-one behaviour is unchanged (cross-pinned). Calibration changes propagate within a minute, no deploy."),
    "TR-38": ("implemented", "analytics/attribution.py computes the cell→venue/floor map as a lakehouse spatial join (centroid containment at governed res 9, deterministic tie-break) and emits a governed publication bundle applied via publish_cell_attribution (migration 0018, venue-ops gated, version-monotonic, audited) — ADR-0009. Matching reads a version-checked PK lookup; attribution is never recomputed per request."),
    "TR-39": ("implemented", "docs/analytics/catalogue.yaml registers every gold table with owner/grain/freshness SLO/retention; scripts/check_gold_catalogue.py is a CI gate (gold-catalogue job) failing on unregistered tables, missing fields, orphan entries or retention beyond the NFR-23 cap."),
    "TR-40": ("implemented", "Phase-gate admission documented; 8 ADRs recorded (Valkey, Keycloak, Kafka, Dapr, OpenSearch, payments, GeoLibre, sequencing)."),
    "TR-41": ("implemented", "GeoLibre authoring workflow built end to end: geofence_drafts (0017) carries draft -> in_review -> approved -> published/rejected with venue/floor targeting on the canonical PostGIS records; the venue-ops console routes (6, all GUC-gated) run the state machine; approval records a reviewer who must not be the author (four-eyes); publish_geofence_draft() is the only write path to venues.geofence/venue_floors.geofence and re-verifies the second person plus the density gate (valid, >=4 vertices, 10 m²..1 km², no edge > 25 m via the ST_Segmentize identity) in one transaction before auditing. The edge mirrors the gate in TypeScript for live editor feedback (cross-pinned constants)."),
    "TR-42": ("implemented", "venue_floors.venue_id/floor_id + geography(Polygon,4326) geofence + connected_to on the venue geometry records (0005, PostGIS canonical)."),
    "TR-43": ("implemented", "analytics/geoparquet.py publishes geospatial gold (density surfaces, attribution maps) as GeoParquet 1.0 — explicit geo metadata (primary column, WKB encoding, OGC:CRS84, spherical edges, bbox) readable by GIS tooling without a live database; no reporting surface needs DB access to render a map. Tested round-trip in tests/test_geoparquet.py."),
    "TR-44": ("phase-gated", "Static-tile serving when map surfaces arrive; no runtime tile server exists (compliant by absence)."),
    # ---------------- SEC ----------------
    "SEC-01": ("implemented", "Consumer realm enforces WebAuthn-with-UV (platform attachment, resident keys) and the imported passkey-only browser flow removes the username/password path entirely — there is no knowledge-factor fallback to downgrade to (TECH-07). NIST SP 800-63B AAL2 conformance evidence lives in docs/security/aal2.md with CI-enforced realm assertions: UV required, phishing-resistant RP-pinned ceremonies, PKCE S256, 5-minute tokens, 60-second revocation (SEC-02), recovery that re-enrols a passkey rather than weakening the factor. Client ceremony binding ships with the RN client (client workstream). Pins: tests/test_batch31.py."),
    "SEC-02": ("implemented", "5-minute consumer-realm access tokens (existing), plus active server-side revocation meeting the 60-second budget: deleting a device writes the Valkey denylist (revoked:dev:{id}) before the route replies, and the authenticate hook denies any request presenting that x-device-id — passive expiry is never the mechanism. The end-to-end propagation contract is exercised by scripts/revocation_drill.py (budget capped at 60 s; validate_deploy-pinned). Pins: test_batch29.py + edge revocation.test.ts."),
    "SEC-03": ("implemented", "Workforce administrative access is just-in-time, delivered end-to-end. Migration 0022: elevation_requests with one-open-per-subject-scope, a five-state machine (pending/approved/rejected/revoked/expired), four-eyes enforced by BOTH the approve definer (clean exception) and the table CHECK (decided_by <> subject), 4-hour grant windows pinned to the realm's ssoSessionMaxLifespan, 24-hour lapse for undecided requests, and every transition audited in-transaction under the governed jit_elevation reason code. Console routes: POST/GET /v1/console/elevation/requests(/mine) for elevation-eligible members, GET /v1/moderation/elevation + approve/reject/revoke for moderators. The 60-second lifecycle tick expires grants and the edge unbinds the workforce realm role via the env-gated Keycloak Admin API client (grant→add, revoke/expiry→remove; idempotent; documented manual fallback without credentials). docs/security/elevation.md. Pins: tests/test_batch31.py + edge elevation.test.ts + validate_deploy."),
    "SEC-04": ("implemented", "RLS on every personal-data table; app connects as non-bypass roles; tested."),
    "SEC-05": ("implemented", "Two service roles only: presence_match (BYPASSRLS) holds grants on taxonomy/profile tables — never messages; presence_app reads messages solely through the messages_open_members RLS policy (OPEN pair members, app_user context); no SECURITY DEFINER function SELECTs envelope (lifecycle_tick DELETEs on the NFR-20 retention schedule only); the analytics pipeline has no message event kind and deny-lists envelope/ciphertext/content; the moderation console never touches ciphertext. Pinned by tests/test_batch27.py."),
    "SEC-06": ("implemented", "TLS 1.3 everywhere at APISIX: the K8s listener is 9443 TLS-only with HTTP/2 (TR-26), and dev compose now mirrors it — same listener shape, ssl_protocols TLSv1.3, HSTS/CSP on the edge route, and a gitignored self-signed dev cert from deploy/apisix/dev-tls.sh. Plaintext 9080 is no longer published; openapi and the deploy validator track the TLS surface."),
    "SEC-07": ("external-evidence", "AES-256-GCM at rest + KMS + annual rotation — production-infra evidence."),
    "SEC-08": ("implemented", "No coordinate columns anywhere; server rejects coordinate fields; H3 cells only."),
    "SEC-09": ("implemented", "Recovery phone stored as keyed hash only: PUT/GET/DELETE /v1/account/recovery-phone normalises to E.164 and stores HMAC-SHA256 (RECOVERY_HASH_KEY — presence-secrets in K8s, clearly-marked dev value in compose) in recovery_phones (0015); the hash is platform-wide unique, RLS is owner-only with no console read, collisions share the neutral 422 with malformed numbers, GET returns existence only. No plaintext phone column exists anywhere (pinned repo-wide); Keycloak README records that no phone attribute is used."),
    "SEC-10": ("implemented", "Server persists ciphertext bytea + routing metadata only; client MLS integration pending."),
    "SEC-11": ("external-evidence", "Encrypted backups, separate key, dual-authorisation restore — every artefact is age-wrapped twice (inner then outer recipient); only the public recipients exist in-cluster (postgres-backup-config), both private keys live off-cluster with separate operators, and restore-rehearse.sh refuses to run without two distinct identity files. Production key-ceremony + storage evidence outstanding."),
    "SEC-12": ("organisational", "Per-category privacy-by-design rationale recorded in the DPIA."),
    "SEC-13": ("implemented", "Introduction consent ledgered with actor+timestamp (FR-35); data-processing consents in data_processing_consents (migration 0019): purpose, scope, policy_version, granted_at/withdrawn_at, owner-only RLS, no DELETE policy — withdrawal marks the artefact (PUT/DELETE /v1/account/consents/:purpose are symmetric), GET /v1/account/consents is the retrievable artefact and dsar_export carries it; account erasure disposes of the artefacts with the account."),
    "SEC-14": ("implemented", "DSAR assemble (GET /account/export) and erasure (DELETE /account) respond in seconds — far inside the 30-day/72-h SLAs; masking preserved in exports."),
    "SEC-15": ("organisational", "Record of processing activities per Appendix B."),
    "SEC-16": ("implemented", "analytics/pseudonym.py: HMAC-SHA256 pseudonyms keyed by a salt rotating every calendar month (uncorrelatable across months); the k floor (K_MIN=11, pinned to the edge aggregate.ts constant) removes any cell-level aggregate below the floor — rows simply do not exist in gold. Pinned repo-wide in tests/test_analytics_pseudonym.py."),
    "SEC-17": ("implemented", "Privacy-preserving age assurance with no ID-document storage: self-declaration (FR-02 year-only) plus a moderation-triggered re-verification loop — underage/actioned resolution flags the account in the same txn, discovery closes with the neutral error, and re-verification requires an adult year consistent (±1) with the declaration on file. No passport/NIN/BVN/document storage exists anywhere in schema, edge or realm exports (pinned repo-wide)."),
    "SEC-18": ("implemented", "Third-party SDK allowlist enforced in CI: docs/security/sdk-allowlist.json is the governed list (name/ecosystem/version constraint/justification/data-access/approver per entry) and scripts/check_sdk_allowlist.py is a fail-closed gate over every client dependency manifest (npm, pub, CocoaPods, Maven) — an unlisted SDK or a constraint violation fails the build. The sdk-allowlist CI job runs it on every PR and push; with no client/ tree yet the gate passes and holds any manifest to the list from its first commit."),
    "SEC-19": ("implemented", "Attestation before discovery with a documented fallback (docs/security/attestation.md): single-use 120 s challenges, signature verification, monotonic counter, verified_at registry; the corpus gates on attested_accounts (match profile read joins the view). Fallback: moderator-approved, audited, one-open-per-account, revocable waivers (attestation_fallbacks + approve/revoke definers under the moderator GUC; console routes POST/DELETE /v1/moderation/attestation-fallbacks/:userId). Legacy unverified enrolment stays accepted but discovery-ineligible until verified. Pins: test_batch29.py."),
    "SEC-20": ("implemented", "rl:scan:h 200/h (429) and rl:wave:d 20/day (429) Valkey counters; isImpossibleTravel rejects fixes implying >500 km/h with a 422."),
    "SEC-21": ("implemented", "screenText covers links, contact details and scam/bypass abuse patterns on first messages (enforced pre-storage in the messages route); room notes (FR-46) reuse the same module when rooms land (FR-44); tested."),
    "SEC-22": ("implemented", "No list endpoints; results capped at 3; tie-break rotates per scan via edge-supplied seed (sha256(seed:userId)); unseeded legacy order retained only for tooling/tests."),
    "SEC-23": ("external-evidence", "OWASP ASVS 4.0.3 L2 / MASVS 2.0 L1 assessment before launch."),
    "SEC-24": ("implemented", "Dependencies pinned (exact versions + lockfile), and every merge to main now produces an SBOM and SLSA mode=max provenance attestation per service image plus a keyless cosign signature over the immutable digest (deploy.yml) — signed provenance is a per-merge artefact, verified in the same job."),
    "SEC-25": ("implemented", ".github/workflows/ci.yml dependencies job — license-checker with an allowlist (MIT/ISC/Apache-2.0/BSD/0BSD/CC0) over both services on every PR."),
    "SEC-26": ("implemented", ".github/workflows/ci.yml (tests, npm audit, gitleaks) + codeql.yml (SAST for TS/Python) + dependabot.yml — all gated on every PR and push to main."),
    "SEC-27": ("organisational", "Independent pen test before launch and annually."),
    "SEC-28": ("implemented", "No Secret manifests anywhere in the repo (CI-pinned: validate_deploy fails on any Secret with data/stringData); production secrets materialise from a managed store via the External Secrets Operator (deploy/k8s/external-secrets.yaml — ClusterSecretStore with AWS-SM/Vault backend blocks + ExternalSecret covering every referenced key); compose keeps only clearly-marked dev values."),
    "SEC-29": ("implemented", "pino hooks.logMethod scrubber: coordinate/content/credential keys redacted, Bearer/apikey/JWT strings scrubbed, cell+user pairings redacted; 10 unit tests."),
    "SEC-30": ("implemented", "security_audit (migration 0019): append-only security-event store, separate from application logs, retained indefinitely (12-month floor) — immutability trigger for every role, governed kind vocabulary (impossible_travel, missing_attestation, attestation_key_duplicate, mock_location_refusal, console_authorization_denied, retention.purge) enforced by CHECK and pinned equal to the edge SECURITY_EVENT_KINDS, writes only via SECURITY DEFINER record_security_event, reads only through the app_moderator GUC (GET /v1/moderation/security-events). Wired at presence publish (impossible travel, missing attestation), device enrolment (attestation), console role denials and the NFR-22 purge."),
    "SEC-31": ("organisational", "Incident response plan, severity levels, on-call, 72-h regulator path, twice-yearly rehearsal."),
    "SEC-32": ("organisational", "Law-enforcement request procedure + annual transparency report."),
    "SEC-33": ("implemented", "group_table_member_cap() trigger locks the table row FOR UPDATE and rejects the seventh member; slot_bookings PK caps one booking per slot; rooms (FR-44) inherit the same pattern when built."),
    "SEC-34": ("implemented", "Both halves landed. Server (links.ts): code-owned domain allowlist + https-only/credential-free/length-bound validation, https CHECK at the data layer, plain-text responses carrying interstitial:true, and a no-server-side-fetch guarantee pinned by test_group_surface. Client (client/src/presence/linkInterstitial.ts): every external link renders as plain text with previews forbidden (preview: 'forbidden' is a type-level constant, and the module is import-free — the client never fetches the target either); the only path to opening runs through the pinned confirmation interstitial copy (LINK_INTERSTITIAL); non-allowlisted hosts get no open affordance at all — defense in depth behind the server's write-time 422. The client allowlist mirrors the server's governed list, cross-pinned equal in tests/test_batch36.py."),
    "SEC-35": ("implemented", "client/src/presence/ambientSurfaces.ts — contentless by construction: AmbientPayload carries exactly {kind, active} (a kind tag + one presence-active boolean), so no identity, reason text, participant count or location field can exist in the type; ambientPayloadViolations still audits every payload against AMBIENT_PAYLOAD_KEYS and the AMBIENT_FORBIDDEN_FIELDS list (identity/handle/photo/reason/count/cell/venue/distance/map…) before anything reaches the OS ambient layer. Pinned by client tests + tests/test_batch40.py."),
    "SEC-36": ("implemented", "POST /v1/devices/mock-location-refusal (202) records the client-side refusal in security_audit (kind mock_location_refusal) for abuse review; there is no user-facing read path — disclosure to other users is impossible by construction, the only reader is the moderation console under the moderator GUC. The mock-location detection itself is client work."),
    "SEC-37": ("implemented", "screenText gates both announcement publish and respond routes; findings return category-coded 422, never the matched text."),
    "SEC-38": ("implemented", "Responses endpoint is publisher-only (403), LIMIT 5, and masks responder identity until acceptance (publicResponse)."),
})
CLASSIFICATION.update({
    # ---------------- INF ----------------
    "INF-01": ("external-evidence", "Single primary region + same-jurisdiction warm standby — production topology."),
    "INF-02": ("implemented", "Three environment overlays (deploy/k8s/overlays/{integration,staging,production}) build on the flat base with identity, data-policy and footprint patches only. deploy.yml lands every merge in integration; .github/workflows/promote.yml promotes staging/production from signed digests — staging resolves the digest integration is actually running, production requires explicit digests plus the staging soak gate, both re-verify the cosign OIDC signature and are environment-gated like INF-15's deploy pipeline."),
    "INF-03": ("implemented", "Synthetic-only separation is machine-enforced: integration/staging namespaces carry presence.dev/data-policy: synthetic-only (production carries production), non-prod overlays pin their own DEPLOY_ENV and cap footprint, promotion moves artefacts never data, and scripts/check_env_separation.py gates it all in CI alongside the synthetic generator (eval harness) and docs/ops/environments.md."),
    "INF-04": ("implemented", "Compose + migrations + ADRs + full K8s manifests (deploy/k8s: workloads, gateway, HPA, NetworkPolicy, canary) are code; scripts/validate_deploy.py asserts the invariants."),
    "INF-05": ("external-evidence", "API/match sizing 3x 2 vCPU/4 GB — production."),
    "INF-06": ("external-evidence", "Valkey 1 primary + 1 replica, 4 GB — production."),
    "INF-07": ("external-evidence", "Postgres 4 vCPU/16 GB, 500 GB SSD, PITR — production."),
    "INF-08": ("external-evidence", "Centrifugo 2 nodes x 2 vCPU — production."),
    "INF-09": ("superseded", "ClickHouse superseded by the OpenSearch-only decision (ADR-0006 / TECH-21)."),
    "INF-10": ("implemented", "autoscaling/v2 HPAs on edge + match: external p95 metric (120 ms target, 3-min window) with CPU fallback; scaleDown capped at 1 pod per 600 s; asserted by scripts/validate_deploy.py."),
    "INF-11": ("implemented", "TLS termination, HSTS and CSP configured at APISIX (validated); the gateway now staples the CA's OCSP attestation itself (ssl_stapling + ssl_stapling_verify + trusted chain + in-cluster resolver in apisix.yaml), scripts/check_tls_posture.py asserts the directives statically in CI and collects live stapling evidence (--host openssl s_client -status, 30 s budget) per docs/ops/tls.md."),
    "INF-12": ("implemented", "K8s: only APISIX reaches edge, only edge reaches match, everything else ClusterIP/headless; default-deny-all NetworkPolicy; asserted by scripts/validate_deploy.py."),
    "INF-13": ("external-evidence", "Edge DDoS mitigation + pre-launch test."),
    "INF-14": ("implemented", "Default-deny egress + per-workload egress allowlists (DNS only otherwise) in deploy/k8s/networkpolicy.yaml; asserted by scripts/validate_deploy.py."),
    "INF-15": ("implemented", "Merge -> signed reproducible artefact -> auto-deploy: .github/workflows/deploy.yml builds edge+match on every merge to main with commit-timestamp SOURCE_DATE_EPOCH and digest addressing (reproducible), attaches buildx SBOM + mode=max provenance, signs the immutable digest keyless with cosign over the GitHub OIDC identity and self-verifies the signature, then the deploy-integration job kustomize-pins the signed digests and rolls out. Auto-deploy is gated on the integration environment variable so the artefact half runs on every merge until the cluster is wired."),
    "INF-16": ("implemented", "Flagger Canary resources on the APISIX provider: 5% steps held 10 min, auto-rollback on success-rate/p95-latency breach (deploy/k8s/canary.yaml); asserted by scripts/validate_deploy.py. Requires Flagger + Prometheus in-cluster."),
    "INF-17": ("implemented", "scripts/rehearse_migrations.py: forward-only lint (DROP TABLE/TRUNCATE/DROP COLUMN rejected, runs in CI and pytest), review checklist in docs/ops/migrations.md (lock profile, CONCURRENTLY indexes, backfill plan, RLS/grants), and a rehearsal that builds the previous release on Postgres 17, populates a production-sized synthetic snapshot (100k users, 600k messages, ~1.75M rows), applies the pending migration timed, and asserts no row loss, valid FKs, RLS intact and the heaviest join resolving — gated by the migration-rehearsal CI job (900 s budget, 120 s per-migration lock warning)."),
    "INF-18": ("external-evidence", "PITR 5-min granularity, 35-day retention, quarterly timed restore — in-repo layer (batch 51): wal-archive.sh + archive_timeout=300, base-backup.sh CronJob with manifest, enforce-retention.sh (35-day floor), restore-rehearse.sh (timed, dual-authorised, verifies append-only integrity counts, logs to an append-only drill trail). The quarterly drill itself stays an ops duty."),
    "INF-19": ("external-evidence", "<=EUR1 500/mo at 100k MAU — Kubecost (P1) + monthly review."),
    "INF-20": ("organisational", "On-call staffing, escalation ladder, 30-min Sev-1 acknowledgement."),
    # ---------------- TECH ----------------
    "TECH-01": ("implemented", "client/: React Native 0.88 + Expo SDK 58 custom dev client — expo-dev-client in dependencies and plugins, `expo start --dev-client`; Expo Go prohibited (documented + pinned by tests; BLE needs native modules). Platform floors iOS 16.0 / Android minSdkVersion 29 with BLUETOOTH_SCAN/CONNECT and when-in-use location declared, ACCESS_BACKGROUND_LOCATION explicitly blocked. CI client job typechecks the RN surface and runs the framework-free unit suites."),
    "TECH-02": ("implemented", "h3-js 4.x in both TS services; the client uses the same library family so cell ids agree bit-for-bit."),
    "TECH-03": ("implemented", "Dockerfiles on node:22-alpine, engines >=22, @types/node 22.10.2; TypeScript strict, pinned toolchain; tests green."),
    "TECH-04": ("implemented", "deploy/postgres/Dockerfile builds on postgis/postgis:17-3.5-alpine with pgvector v0.8.0 and h3-pg v4.2.1 compiled from pinned tags (batch 19); native h3-pg powers the TR-16/37 ladder lookups."),
    "TECH-05": ("implemented", "Valkey 8 (BSD-3); no Redis anywhere."),
    "TECH-06": ("implemented", "Centrifugo v6 (Apache-2.0) runs the Redis engine over Valkey in compose and k8s (CENTRIFUGO_ENGINE_TYPE=redis, CENTRIFUGO_ENGINE_REDIS_ADDRESS=redis://valkey:6379/1) — presence and pub/sub state is shared across the 2 k8s replicas instead of per-process memory; network policies admit centrifugo->valkey and nowhere else."),
    "TECH-07": ("implemented", "Three realm imports boot in compose; edge verifies RS256 via realm JWKS. The consumer browser flow is the imported passkey-only 'consumer passkey browser' (browserFlow binding: auth-cookie ALTERNATIVE + webauthn-authenticator-passwordless REQUIRED — no username/password execution anywhere in the realm), with webauthn-register-passwordless as the default required action so every new account enrols a passkey at first login. SMS recovery is the documented per-market authenticator-SPI contract (deploy/keycloak/README.md): verify against the gateway, then complete with passkey re-enrolment — the server-side recovery phone stays a keyed hash only (SEC-09) and the old credential is invalidated by device revocation (SEC-02). Pins: tests/test_batch31.py realm assertions."),
    "TECH-08": ("implemented", "client/src/presence/e2eCrypto.ts — provider registry exactly OpenMLS (MIT/Apache-2.0) / vodozemac (MIT); libsignal refused by name (lookalike forks included) AND by its AGPL marker via the TECH-16 licence screen, SRS reason pinned verbatim; keys pinned to the device keystore (secure-store), key-package upload single-field with refill floor 10 (garbage refills); per-pair MLS epoch machine forms at OPEN / seals at close / refuses out-of-order; wire payload exactly {envelope} with plaintext-field violations (server-cannot-read); compose path pins screen -> encrypt -> send with screening mandatory per FR-38 (cross-pinned conversationThread). Pinned by client tests + tests/test_batch45.py."),
    "TECH-09": ("implemented", "pgvector lives only in the linking stack: extension + taxonomy_node_embeddings vector(384) with HNSW cosine index (migration 0011), link_taxonomy_nodes() excludes sensitive/redirected nodes, app role is SELECT-only; the deterministic ngram-hash-384.v1 embedder is implemented bit-identically in Python (seed generation) and TypeScript (query time), pinned against shared golden vectors. The never-in-match-path boundary is test-pinned: match service, scan route and presence model reference nothing from the linking stack. Deploy postgres image builds pgvector v0.8.0 (deploy/postgres/Dockerfile); migration + seed mounted in compose and k8s."),
    "TECH-10": ("superseded", "ClickHouse superseded by OpenSearch (ADR-0006 / TECH-21); aggregated events only."),
    "TECH-11": ("implemented", "deploy/k8s/observability.yaml: OpenTelemetry Collector (OTLP gRPC+HTTP receivers, memory-limited batching) forwarding to Tempo, Grafana provisioned with Prometheus + Tempo datasources — internal-only (AGPL), viewer fallback, no external Service; applied to the monitoring namespace with OTLP egress admitted by the presence NetworkPolicies."),
    "TECH-12": ("implemented", "Every service exposes /healthz (probes pinned to it — a /health mismatch was caught and fixed), Fastify structured logs, and OTel traces by default: services/*/src/tracing.ts starts the NodeSDK with auto-instrumentations (http/fastify/pg/ioredis, fs excluded) before the module graph loads via dynamic import; OTLP/HTTP to the cluster collector by default, OTEL_SDK_DISABLED=true opts out for bare-metal runs."),
    "TECH-13": ("implemented", "Golden-file suite (120 pairs) fails on any score change; 81-test Python regression suite."),
    "TECH-14": ("implemented", "tests/test_openapi_contract.py generates assertions from openapi.yaml: strict-body structural + behavioural checks, doc<->route coverage both ways, TR-24 header docs, schema well-formedness."),
    "TECH-15": ("implemented", "Time, randomness and identifiers are injected everywhere they govern behaviour: EdgeContext carries clock/ids (presence TTL math, impossible-travel, publishedAt, session-id minting; scan day-ordinal) with withTime() overrides; the match Store takes a Clock (profile-cache freshness); shouldNotify already took now; rankScan takes tieBreakSeed. Expiry/rotation tests advance fake clocks instead of sleeping (store-cache.test.ts, metrics.test.ts)."),
    "TECH-16": ("implemented", "client/src/presence/dependencyBudget.ts — 45 MB bundle cap with one size allocation per runtime dependency (31 MB allocated, cross-pinned to package.json); the licence allowlist mirrors the SEC-25 CI set with a prohibited-marker screen in front (GPL/AGPL/LGPL/SSPL/Commons Clause refuse — the TECH-08 libsignal discipline); the admission gate refuses in pinned order (size, SEC-18 membership, deprecated, licence, cap); the SEC-18 sdk-allowlist CI gate enforces membership. Pinned by client tests + tests/test_batch42.py."),
    "TECH-17": ("organisational", "Team skills: TypeScript, React Native, Postgres, one systems language."),
    "TECH-18": ("implemented", "ARC language allocation delivered in full. Rust match core (services/match-core): the full engine — graph validation, TR-04 closure, TR-06 idf, TR-36 prior, scoring, TR-08/09 reasons, icebreaker — pinned to 1e-9 against the shared 120-pair golden corpus alongside the TS engine and Python reference, bit-deterministic by sorted-order accumulation, committed Cargo.lock, cargo test wired into CI. Go service cores (services/presence-go, venue-go, consent-go): SEC-20 velocity rules + FR-28 budget ladder + canonical key model (FR-16/23/34/91); BR-13 k-suppression + FR-42 schedule/partner registry + BR-12 dashboard; FR-29 state machine + FR-32/34 masking + lifecycle constants — stdlib-only ports pinned constant-for-constant to the TS/SQL sources by tests/test_batch30.py, gofmt/vet/test wired into the go-services CI job. TS stays the documented P0 serving stand-in; cutover is a deployment decision that changes no behaviour."),
    "TECH-19": ("implemented", "Kafka designated event backbone (ADR-0004); no Fluvio deployed; Kafka rollout itself is ARC P1."),
    "TECH-20": ("implemented", "No Temporal calls on the scan path (none exist anywhere); Temporal rollout is ARC P1."),
    "TECH-21": ("implemented", "No ClickHouse / second warehouse; APISIX is the sole public ingress — the only LoadBalancer Service, enforced by NetworkPolicy (validated); OpenSearch is P1."),
    "TECH-22": ("implemented", "analytics/layers.py: Delta Lake on Parquet medallion — bronze (append-only, date + cell-prefix partitions, 90 days), silver (deduped/validated/conformed, month partitions, 25 months), gold (k-suppressed products, 25 months). Nothing analytical sits on the live match path; P2 engines (Flink/Spark+Sedona) execute the same layer semantics at scale when the phase gate opens."),
    "TECH-23": ("implemented", "No Mojaloop/TigerBeetle deployed; ARC-002 §9 gates them at P3."),
    "TECH-24": ("implemented", "MapLibre + GeoLibre + PostGIS stack (ADR-0008) complete end to end: canonical geometry in PostGIS (venues.geofence geography(Polygon,4326)); GeoLibre authoring workflow (TR-41, batch 22 — drafts, four-eyes, density gate, DB-final publish); and the QA workflow (batch 23 migration 0023) — geofence_overlap_check + a publish-time overlap gate that stops two venues claiming the same ground (attribution ambiguity, FR-90; 10 m² tolerance, floors exempt), geofence_qa_report() GUC-gated estate audit (coverage, density re-verification, overlap conflicts, geometry version, drafts in flight), console routes POST /v1/ops/geofences/overlap-check + GET /v1/ops/geofences/qa, and the runbook docs/ops/geofence-qa.md."),
    # ---------------- ACC ----------------
    "ACC-01": ("external-evidence", "This generated matrix + the test suites are the verification instrument; final gate at pilot."),
    "ACC-02": ("organisational", "Independent pen test with critical/high remediation + retest."),
    "ACC-03": ("organisational", "DPIA signed by DPO + accountable executive."),
    "ACC-04": ("external-evidence", "Load + soak profile on production-equivalent infrastructure."),
    "ACC-05": ("organisational", "Incident response rehearsed; on-call staffed; runbooks published."),
    "ACC-06": ("external-evidence", "Rollback drill: production release reverted <=10 min."),
    "ACC-07": ("organisational", "Three anchor venues contracted + dashboards verified."),
    "ACC-08": ("external-evidence", "Store review acceptance on both platforms — needs the client."),
    "ACC-09": ("external-evidence", "10-user first-time usability test (>=8 describe the product correctly) — needs the client."),
    "ACC-10": ("partial", "Eval pipeline complete (653-pair key, rating pack, scoring; self-test alpha 0.832, p@3 0.389); the real >=3-independent-rater study is outstanding."),
})

# ---------------------------------------------------------------- generation

SCAN_DIRS = ["presence", "services", "tests", "db", "docs", "deploy", "eval", "scripts"]
SCAN_EXTS = {".py", ".ts", ".sql", ".md", ".json", ".yml", ".yaml"}
SKIP_DIRS = {"node_modules", ".git", "__pycache__", "dist"}
MAX_EVIDENCE = 5


def collect_evidence() -> dict[str, list[str]]:
    """Map requirement id -> repo-relative files that mention it."""
    hits: dict[str, list[str]] = {}
    pattern = re.compile(r"\b(?:BR|FR|NFR|TR|SEC|INF|TECH|ACC)-\d{2,3}\b")
    for d in SCAN_DIRS:
        root_dir = os.path.join(REPO, d)
        if not os.path.isdir(root_dir):
            continue
        for root, dirs, files in os.walk(root_dir):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            for f in files:
                if os.path.splitext(f)[1] not in SCAN_EXTS:
                    continue
                path = os.path.join(root, f)
                rel = os.path.relpath(path, REPO)
                if rel.endswith(("traceability.md", "traceability.json", "build_traceability.py")):
                    continue
                try:
                    with open(path, encoding="utf-8", errors="ignore") as fh:
                        text = fh.read()
                except OSError:
                    continue
                for rid in set(pattern.findall(text)):
                    hits.setdefault(rid, [])
                    if rel not in hits[rid]:
                        hits[rid].append(rel)
    return hits


def main() -> int:
    evidence = collect_evidence()
    rows: OrderedDict[str, dict] = OrderedDict()
    missing = []
    for fam, (title, count) in FAMILIES.items():
        for i in range(1, count + 1):
            rid = f"{fam}-{i:02d}"
            if rid not in CLASSIFICATION:
                missing.append(rid)
                continue
            status, note = CLASSIFICATION[rid]
            rows[rid] = {
                "family": fam,
                "status": status,
                "evidence": sorted(evidence.get(rid, []))[:MAX_EVIDENCE],
                "note": note,
            }
    if missing:
        print("MISSING classification for:", ", ".join(missing), file=sys.stderr)
        return 1

    counts: dict[str, int] = {s: 0 for s in STATUS_ORDER}
    per_family: dict[str, dict[str, int]] = {}
    for rid, row in rows.items():
        counts[row["status"]] += 1
        pf = per_family.setdefault(row["family"], {s: 0 for s in STATUS_ORDER})
        pf[row["status"]] += 1

    out_json = {
        "spec": "PRS-SRS-001 v1.0 / PRS-ARC-002",
        "generated_by": "scripts/build_traceability.py",
        "total": len(rows),
        "status_counts": counts,
        "per_family": per_family,
        "requirements": rows,
    }
    with open(os.path.join(REPO, "docs", "traceability.json"), "w") as fh:
        json.dump(out_json, fh, indent=2)
        fh.write("\n")

    lines: list[str] = []
    lines.append("# Traceability matrix — PRS-SRS-001 v1.0 / PRS-ARC-002")
    lines.append("")
    lines.append("GENERATED ARTEFACT — do not hand-edit. Regenerate with "
                 "`python3 scripts/build_traceability.py` (SRS §10: the matrix is "
                 "generated, not hand-maintained).")
    lines.append("")
    lines.append(f"Total requirements: **{len(rows)}** "
                 f"(283 MUST · 22 SHOULD · 1 MAY per Appendix A).")
    lines.append("")
    lines.append("## Status summary")
    lines.append("")
    lines.append("| Status | Count | Meaning |")
    lines.append("|---|---|---|")
    meaning = {
        "implemented": "working in the repo with tests or structural evidence",
        "partial": "meaningful part implemented; named gap remains",
        "gap-p0": "ARC-P0 product scope, code not yet built",
        "phase-gated": "ARC P1+ component; correctly deferred per TR-40 / ARC-002 §9",
        "client": "requires the React Native client workstream",
        "organisational": "legal / process / staffing — not expressible as code",
        "external-evidence": "needs production infrastructure or third-party evidence",
        "superseded": "superseded by a recorded ADR",
    }
    for s in STATUS_ORDER:
        lines.append(f"| {s} | {counts[s]} | {meaning[s]} |")
    lines.append("")
    lines.append("## Per-family breakdown")
    lines.append("")
    header = "| Family | " + " | ".join(STATUS_ORDER) + " | total |"
    lines.append(header)
    lines.append("|---|" + "---:|" * (len(STATUS_ORDER) + 1))
    for fam, (title, _count) in FAMILIES.items():
        pf = per_family.get(fam, {})
        cells = " | ".join(str(pf.get(s, 0)) for s in STATUS_ORDER)
        lines.append(f"| {fam} | {cells} | {sum(pf.values())} |")
    lines.append("")
    for fam, (title, _count) in FAMILIES.items():
        lines.append(f"## {fam} — {title}")
        lines.append("")
        lines.append("| ID | Status | Evidence | Basis |")
        lines.append("|---|---|---|---|")
        for i in range(1, _count + 1):
            rid = f"{fam}-{i:02d}"
            row = rows[rid]
            ev = "<br>".join(f"`{e}`" for e in row["evidence"]) or "—"
            lines.append(f"| {rid} | {row['status']} | {ev} | {row['note']} |")
        lines.append("")
    with open(os.path.join(REPO, "docs", "traceability.md"), "w") as fh:
        fh.write("\n".join(lines))

    print(f"requirements: {len(rows)}")
    for s in STATUS_ORDER:
        print(f"  {s:18s} {counts[s]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
