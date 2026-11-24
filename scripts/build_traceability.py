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
    "BR-05": ("partial", "events table models venue+window; event-scoped instance mode and presence-to-event attribution not wired."),
    "BR-06": ("organisational", "Five sequenced revenue lines only; payments gated per docs/adr/0007."),
    "BR-07": ("partial", "Reports endpoint exists and is ungated; two-tap reachability is client UX (not built); no monetisation gate exists."),
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
    "FR-01": ("partial", "Consumer realm ships the passkey policy (platform authenticator, user verification required, passwords disabled); edge verifies RS256 via JWKS; passkey-only onboarding flow + RN client pending."),
    "FR-02": ("implemented", "POST /account/age-declaration upserts a birth-year declaration; under-18 sets age_blocked; presence+scan refuse with a neutral 403 (no reason disclosed); boundary fails toward blocking; tested."),
    "FR-03": ("partial", "DELETE /v1/account erases in one authenticated call; the <=3-tap journey is client UX, pending with the RN client."),
    "FR-04": ("implemented", "delete_account purges envelopes/pairs/blocks/profile/identity synchronously and tombstones the user; the edge strips Valkey presence+suppress+block keys in the same call; ledger actors anonymised after the 90-day hold by lifecycle_tick."),
    "FR-05": ("implemented", "POST/GET/DELETE /v1/devices over the devices registry (migration 0010): device_cap() trigger locks the user row FOR UPDATE and rejects the fourth concurrent device (SEC-33 idiom; re-enrolment of a live fingerprint is a refresh, exempt from the count); one active row per key_fingerprint via partial unique index; enrolment publishes device_enrolled to the account's own channel with label only — never the fingerprint; revocation is idempotent and owner-scoped by RLS."),
    "FR-06": ("implemented", "PUT/GET /v1/profile/identity over user_identities (migration 0020): handle set-once (409 on change), display_name <=80 chars defaulting to the handle at render time (COALESCE in display_handle(), the route reads and dsar_export), bio varchar(140) enforced in the data layer and the route schema; display name and bio are content-screened (SEC-37 idiom); the photo stays RLS-gated to OPEN (identity_after_open) and is uploaded out of band."),
    "FR-07": ("implemented", "register_attestation_key() SECURITY DEFINER enrols/refreshes/detects atomically: a cross-account collision keeps the key with its original account, inserts attestation_duplicates and writes admin_audit_log('moderation.duplicate.detected','impersonation'); the enrolment route returns the same neutral 201 regardless — the console-only registry (RLS app_moderator) surfaces collisions on the moderation account card as keyHashPrefix + both accounts + detected_at. P0 uses the assertion SHA-256 as the key stand-in until cryptographic App Attest verification lands (FR-51 idiom)."),
    "FR-08": ("partial", "PUT/GET /v1/profile/interests replace the set server-side: 3-20 unique taxonomy nodes validated, weights in (0,1], sensitive rejected at write time (TR-22). Gap: the searchable <=3-level picker UI is client work (RN milestone)."),
    "FR-09": ("implemented", "POST /v1/profile/interests/link: free text (<=500 chars, screened SEC-26 idiom) is embedded with the deterministic ngram-hash-384.v1 embedder and matched over the pgvector taxonomy space (migration 0011 + generated seed); top-5 candidates above a 0.15 cosine floor, sensitive/redirected nodes excluded at seed and query time (TR-22), already-declared nodes excluded via the owner-GUC read (FR-13 discipline). Per-node confirmation: the route never writes (test-pinned) — confirmed nodes go through the governed FR-08 endpoint."),
    "FR-10": ("implemented", "Sensitive nodes excluded from vectors, reasons, idf and bonus at build time; covered by engine tests."),
    "FR-11": ("implemented", "The discoverability floor counts NON-sensitive interests via nonSensitiveCount() (engine.ts) at all three match gates — scan candidates, corpus rebuild, global prior; a node flipped sensitive by FR-59 governance after declaration stops counting, a node the taxonomy no longer knows is skipped rather than throwing. GET /v1/profile/interests returns discoverable + discoverabilityNote explaining the floor so the editor can show the reason before the user leaves the screen."),
    "FR-12": ("implemented", "Profile and corpus caches refresh on a 60 s loop (TR-05)."),
    "FR-13": ("implemented", "GET /v1/interests/:nodeId/popularity — live-cell count over declarations of the node and its descendants, kSuppressed at k=11 (BR-13); sensitive nodes indistinguishable from unknown (TR-22)."),
    "FR-14": ("implemented", "900 s Valkey TTL; stale cell members filtered at read; tested."),
    "FR-15": ("partial", "Server rejects coordinate-shaped fields with 422 (TR-15); on-device cell computation is client work."),
    "FR-16": ("implemented", "newPresenceSessionId (128-bit hex) on session start, kept on heartbeats, reuse rejected 409; presence:session reverse index; scan results carry sessionId+pairId — account ids never leave the edge pre-OPEN."),
    "FR-17": ("implemented", "PUT/GET/DELETE /v1/presence/intent over Valkey only: governed 8-word vocabulary (coffee/food/chat/walk/dance/network/explore/quiet), EX 3600 hard cap, requires live presence, purgePresence deletes intent:{uid} so it dies with presence; scan annotates results with sharedIntent when both sides declared the same active intent — signal only, score contract untouched (test-pinned)."),

    "FR-18": ("implemented", "users.invisible flag (migration 0004); PUT/GET /v1/account/visibility; flipping on purges live presence at once; publishes refused 403 while set."),
    "FR-19": ("client", "Background-withdrawal <=60 s is client lifecycle behaviour."),
    "FR-20": ("implemented", "<=3 candidates with ordered reasons; unit + golden tests."),
    "FR-21": ("implemented", "Adaptive threshold: (1-5/n)-quantile floored at venue base; tested."),
    "FR-22": ("partial", "MMR (lambda 0.7) over reason-node Jaccard; a hard no-shared-primary-reason guarantee is not enforced."),
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
    "FR-41": ("partial", "DELETE /v1/pairs/:pairId/messages/:messageId — sender-only (RESTRICTIVE policy + column-limited grant), 24-h window blanks the envelope and tombstones; 410 after. Gap: local delete UX is client work."),
    "FR-42": ("implemented", "venues is now the full registry (migration 0020): partner_status (prospect/active/suspended/offboarded) with venues.active derived by trigger, operating_schedule jsonb shape-checked by operating_schedule_valid() (timezone + weekly day/open/close HH:MM), suspended_at; cells map through the cell_attribution projection (0017). GET /v1/venues/:id/registry serves cells+status+schedule (BR-12), PUT .../schedule replaces it, offboard is venue-ops-only; every mutation is SECURITY DEFINER with an admin_audit row."),
    "FR-43": ("partial", "events = venue + window in schema; presence-to-event attribution not wired."),
    "FR-44": ("implemented", "Crowd-band transition: GET /v1/venues/:id/rooms lists rooms derived owner-side (room_topics() SECURITY DEFINER) from live members' declared non-sensitive interests; below crowd the list is empty with the mode field; scan responses announce mode=rooms + roomsUrl in the crowd band; joins need live venue presence, a still-crowded venue and a declared interest in the topic."),

    "FR-45": ("implemented", "Room content rules: opaque roomKey (sha256 venue:node), topic, kSuppressed member count, member-only GET with uniform 404, opt-in join/leave; notes carry no author field — opting in is what publishes; everything lives in Valkey with presence-aligned TTL (900s), no room table in Postgres (test-pinned)."),

    "FR-46": ("implemented", "Posting discipline: SET NX EX 300 gate → one note per member per room per five minutes (429); first note per member per room screened via screenText (SEC-21 idiom, room:screened marker), later notes not re-screened; notes ring-buffered at 50 with TTL refresh on activity."),

    "FR-47": ("implemented", "Resolution ladder 9>10 (2 000) >11 (10 000) on live venue density; tested."),
    "FR-48": ("partial", "Venue check-in codes live via FR-99/FR-100 signed per-floor tokens; venue-side code printing/distribution ops remain with the client workstream."),
    "FR-49": ("implemented", "reports.category NOT NULL with the six governed values (harassment, impersonation, under_age, commercial_solicitation, hate, other) as a CHECK constraint (migration 0019); the edge requires it in the report schema via REPORT_CATEGORIES (services/edge/src/reports.ts) — pinned equal to the SQL list by test_reporting_compliance.py so the vocabularies cannot drift."),
    "FR-50": ("organisational", "24/7 4-h high-severity triage — staffing/rota (BR-16) plus the moderation console (FR-54)."),
    "FR-51": ("partial", "Attestation assertion header required on presence write; cryptographic verification + discovery gating pending."),
    "FR-52": ("implemented", "trust_score() (db/migrations/0008): deterministic SECURITY DEFINER score — base 0.50, +0.20 age-verified, +0.10 at 30/180 days, -0.15/actioned report (cap -0.45), +0.05/dismissed (cap +0.15), -0.02/unresolved (cap -0.10), clamped [0,1]; drives the moderation queue ordering and account card."),
    "FR-53": ("implemented", "users.investigation_removed_at (discovery gate shares the neutral FR-02 error) + silent purgePresence (no realtime event) via POST /v1/moderation/accounts/:id/investigation-remove|restore; appeals table (one open per account, partial unique index) with POST/GET /v1/account/appeals (screened SEC-26) and console resolve — overturn lifts the suspension and clears the removal in one transaction."),
    "FR-54": ("implemented", "Workforce-realm moderator gate (requireModerator + per-issuer JWKS, app.moderator GUC via withModerator) fronting 8 console routes: trust-ordered queue, account card (trust inputs, suspensions, report stats, account_ledger_stats aggregates, liveNow, audit trail — never message content), report resolve, investigation remove/restore, suspension lift, appeals queue/resolve; every action admin_audit-logged with governed reason codes."),
    "FR-55": ("implemented", "suspensions table + suspension_dimension enum (attestation_key/handle/payment_instrument), one active per (user, dimension) partial unique index; attestation gate wired into presence publish (neutral 403), handle mask via display_handle() inside group_member_directory, payment_instrument record-only until the P3 payments surface; lift is per-dimension."),
    "FR-56": ("partial", "Realtime events carry only a type on an opaque pair channel; APNs/FCM push pipeline not built."),
    "FR-57": ("implemented", "POST /v1/consent/:pairId/nudge (DETECTED→NUDGED ledger transition, window renewed) capped at 3/sender/UTC-day via Valkey (429); recipient quiet window {start,end} HH:MM UTC (overnight-aware, equal=disabled) stored in notification_prefs and editable via PUT /v1/account/notifications; realtime event suppressed in the window or when the nudges category is off; the event carries no actor identity (FR-30)."),
    "FR-58": ("partial", "GET/PUT /v1/account/notifications over users.notification_prefs: six categories default-on, safety exemption enforced (422 on safety=false). Gap: enforcement lands with the notification dispatcher (no sender yet)."),
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
    "FR-70": ("client", "Verification status at identity reveal — client rendering (+ data from FR-51/52)."),
    "FR-71": ("implemented", "Recurrence signal: recur:<sha256(lo:hi)> key names nobody; {days, lastDay} day-ordinal counter bumped at most once per UTC day on scan surfacing (bumpRecurrence), EX 90 days retention; wire carries recurrenceDays only — never a timestamp (test-pinned)."),

    "FR-72": ("implemented", "tests/test_group_surface.py asserts the cap/single-host triggers, RLS on all six tables, member-only policies, creator-scoped insert, the member-scoped directory (no photos), the open-only join probe, and membership-scoped listing with uniform 404s."),
    "FR-73": ("implemented", "tests/test_group_surface.py asserts the slot_bookings PK double-book guard, state/duration CHECKs, actor-scoped booking/cancel policies, column-limited grants, the atomic state flip, and host-action audit logging."),
    "FR-74": ("implemented", "Host remove and close write admin_audit rows (FR-60, governed host_discretion reason); host visibility stops at directory name+role; a host with members cannot leave (409) — they close the table instead."),
    "FR-75": ("implemented", "GET /v1/tables returns only the caller's memberships (no venue-wide listing exists); every table/slot-scoped route answers a uniform 404 to non-members; group_join_info reveals only venue+headcount of open tables, closed indistinguishable from nonexistent."),
    "FR-76": ("client", "Convergence rendering from the reason payload — payload complete server-side (TR-08)."),
    "FR-77": ("implemented", "Structural: no endpoint exposes maps, bearings, distances, radii, or proximity arrangements."),
    "FR-78": ("client", "Density-as-texture rendering, no positional component."),
    "FR-79": ("client", "Closing-perimeter expiry affordance, no default countdown."),
    "FR-80": ("client", "Shared screen skeleton across pairs/rooms/tables."),
    "FR-81": ("client", "Spatial taxonomy picker + <=4-interaction interest selection."),
    "FR-82": ("client", "400-ms sustained-press wave with progressive feedback."),
    "FR-83": ("client", "Distinct haptics per transition + non-visual channel."),
    "FR-84": ("client", "Co-located close suggestion after 15 min (SHOULD)."),
    "FR-85": ("client", "Reduced-power 10-min cadence mode with visibility trade-off notice."),
    "FR-86": ("client", "Ambient surfaces individually opt-in, off by default, one-action disable."),
    "FR-87": ("client", "Prohibited engagement mechanics — none exist server-side; enforcement is client review."),
    "FR-88": ("client", "Location-accuracy authorization read before publish; refuse on approximate-only."),
    "FR-89": ("partial", "Check-in basis exists (signed tokens + floor attribution, FR-99/FR-100); making check-in the PRIMARY indoor presence path is client/UX work, outstanding."),
    "FR-90": ("implemented", "Full loop: venues.geofence canonical polygon (TR-41 review workflow) → lakehouse spatial join publishes cell_attribution (TR-38) → presence publish applies version-checked polygon precedence via PK lookup (services/edge/src/attribution.ts). geofence_version triggers version the polygon with the venue record; a revision suspends attribution until republication, so a stale map never mis-scopes presence."),
    "FR-91": ("implemented", "rotate:{lo}:{hi} keys (EX 604800) set on consent express and excluded from scans; per-user tbreak counter feeds the match service's seeded sha256 tie-break."),
    "FR-92": ("client", "5-min modal-cell stabilisation on device (SHOULD)."),
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
    "NFR-04": ("client", "Cold start to interactive <=1.8 s mid-tier."),
    "NFR-05": ("client", "Warm start <=600 ms."),
    "NFR-06": ("external-evidence", "Tap-to-results p95 <=900 ms — end-to-end measurement with the client."),
    "NFR-07": ("partial", "Centrifugo realtime fan-out wired; <=500 ms delivery unmeasured."),
    "NFR-08": ("external-evidence", "25 000 concurrent presences per city cluster — capacity test."),
    "NFR-09": ("external-evidence", "600 scans/s at p95 peak — capacity test."),
    "NFR-10": ("external-evidence", "60 000 single-venue burst per 10 min — capacity test."),
    "NFR-11": ("external-evidence", "Linear 2x scale-out without schema/client change — K8s HPA + test."),
    "NFR-12": ("external-evidence", "250k-node taxonomy at match latency targets — scale test (TR-21)."),
    "NFR-13": ("external-evidence", "99.9% measured scan-path availability — production measurement."),
    "NFR-14": ("partial", "Presence path is independent of the matcher; edge returns 502 today — graceful 'discovery paused' client state pending."),
    "NFR-15": ("external-evidence", "RTO <=60 min single-zone loss."),
    "NFR-16": ("external-evidence", "RPO <=5 min consent ledger (PITR, INF-18)."),
    "NFR-17": ("implemented", "Presence RPO deliberately zero — Valkey-only, disposable by design; documented."),
    "NFR-18": ("partial", "15-min TTL enforced; the 45-min grace semantics for index residue are only partially explicit (lazy stale-member filtering)."),
    "NFR-19": ("implemented", "24-h visibility masking (GET /consent) + lifecycle_tick hard-deletes pre-OPEN closed pairs with their ledger rows after 24 h, under the governed purge mode."),
    "NFR-20": ("implemented", "lifecycle_tick deletes messages 24 h after pair close; messages RLS blocks reads on closed pairs immediately."),
    "NFR-21": ("implemented", "Ledger append-only for all app traffic (governed purge mode is unreachable by the app role); lifecycle_tick anonymises actors 90 days after account deletion."),
    "NFR-22": ("implemented", "reports_retention_tick() (migration 0019) disposes of reports — and the moderation decisions recorded on them (outcome/resolved_by/resolved_at) — 12 months after filing; SECURITY DEFINER, driven by the edge lifecycle job alongside lifecycle_tick, and every disposal is itself audited into security_audit (retention.purge). Appeals keep their own record; the report FK detaches (SET NULL)."),
    "NFR-23": ("implemented", "analytics/retention.py enforces a 25-month rolling window on silver and gold (month partitions pruned every run; bronze 90 days per ARC §6.1). The SRS schedule caps the ARC indefinite wording — pinned in tests/test_retention.py."),
    "NFR-24": ("external-evidence", "35-day backup retention — production ops."),
    "NFR-25": ("client", "WCAG 2.2 AA (contrast, dynamic type, screen reader, focus, reduced motion)."),
    "NFR-26": ("client", "44x44 pt touch targets."),
    "NFR-27": ("client", "English at launch; localisable without code changes; +2 locales in 3 months."),
    "NFR-28": ("client", "iOS 16+ / Android 10+ with graceful BLE-floor degradation."),
    "NFR-29": ("client", "Foreground battery <=2%/h on reference mid-tier."),
    "NFR-30": ("client", "Background battery parity with a no-op app when background presence is off."),
    "NFR-31": ("implemented", "End-to-end: APISIX request-id generates/echoes X-Request-Id; the edge's genReqId honors a charset-validated incoming id (resolveRequestId, visible ASCII <=128) else mints a uuid and echoes it on every response (onSend); the scan route forwards x-request-id to the match service, whose own genReqId honors/echoes it the same way — one trace id spans gateway -> edge -> match, and Fastify logs carry reqId at every hop."),
    "NFR-32": ("implemented", "The four §2.5 product metrics (scan.surfaced_rate, surfacing.express_rate, mutual.open_rate, open.first_message_rate) are computed by one pass over telemetry_events (migration 0013). Events are written synchronously by the causing request — scan completed/DETECTED in the scan route, EXPRESS/NUDGE/OPEN in the consent routes, pair-first message in the messages route — never queued or batched (test-pinned), so the five-minute computability budget is met by construction; GET /v1/telemetry/metrics reports the age of the newest underlying event as evidence. Aggregate dims only — no user ids, pair ids or cells (test-pinned)."),
    "NFR-33": ("implemented", "deploy/k8s/prometheusrules.yaml — one PrometheusRule alert per required class, each with severity and owner."),
    "NFR-34": ("implemented", "docs/runbook.md — per-alert symptom/impact/first-actions/escalation, owner named per alert."),
    "NFR-35": ("client", "60 fps match surface (>=30 fps floor on weakest supported device)."),
    "NFR-36": ("client", "Ambient refresh <=1/min, no idle radio wake."),
    "NFR-37": ("client", "Primary action reachable one-handed in the lower 40% of the display."),
    # ---------------- TR ----------------
    "TR-01": ("implemented", "Edge + match are stateless; all state lives in Valkey/Postgres."),
    "TR-02": ("partial", "Scan reads Valkey + warmed caches; a cold profile cache miss still hits Postgres inline — bulk warming or async load outstanding."),
    "TR-03": ("partial", "K8s NetworkPolicies isolate east-west traffic (only declared flows allowed); mTLS between services awaits the mesh decision."),
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
    "TR-19": ("partial", "redirect_to column + Python graph support exist; the TS engine does not resolve redirects yet."),
    "TR-20": ("implemented", "taxonomy_releases carries a monotonic version from the taxonomy_release_version sequence (assigned at publish only, UNIQUE), full provenance (author, reviewer, published_by, rolled_back_by + per-transition timestamps) and a diff summary jsonb counted per operation class; the pre-publish snapshot is stored on the release as the rollback basis. Exposed on the release list/detail console endpoints."),
    "TR-21": ("implemented", "250k-node closure <10 min enforced in CI: scripts/scale_taxonomy_closure.py builds a deterministic 250k-node taxonomy (depth-capped like the governed one) and rebuilds the closure with the exact WITH RECURSIVE block extracted verbatim from migration 0012 — the harness cannot drift from production. The taxonomy-scale CI job runs it against a postgres:17 service on every PR and push, asserting both the 600-s budget and the exact closure row count; the walk semantics (ancestors only, hops 1..4) are additionally executed against SQLite in the acceptance tests."),
    "TR-22": ("implemented", "Sensitive nodes skipped at vector construction (write time), not query time."),
    "TR-23": ("implemented", "docs/api/openapi.yaml is the machine-readable contract; every /v1 body/query/params carries a JSON Schema with additionalProperties:false under ajv strict mode — unknown fields hard-400 before the handler runs."),
    "TR-24": ("implemented", "Optional Idempotency-Key honoured on all mutating endpoints: idem:{uid}:{key} pending-lease/24h record in Valkey, replay + 409-in-flight semantics, 5xx clears."),
    "TR-25": ("partial", "Errors carry a message only; stable machine codes + retry hints missing; no internal leaks observed."),
    "TR-26": ("implemented", "APISIX listener configured TLSv1.3-only with HTTP/2 (deploy/k8s/apisix.yaml); downgrade impossible at the listener; asserted by scripts/validate_deploy.py. Dev compose stays plaintext by design."),
    "TR-27": ("client", "Unsupported-version detection + update prompt."),
    "TR-28": ("implemented", "All expiry windows use server now(); no client-clock input anywhere."),
    "TR-29": ("client", "On-device cell computation; raw coordinates discarded before any network call."),
    "TR-30": ("client", "Minimum local state; cleared on logout/uninstall signal."),
    "TR-31": ("client", "BLE rotating derived codes <=15 min, never a stable identifier."),
    "TR-32": ("client", "Graceful degradation on denied Bluetooth/location/push permissions."),
    "TR-33": ("client", "Certificate pinning removable by configuration (MAY)."),
    "TR-34": ("implemented", "Stable governed event keys (scan.completed, consent.transitioned, pair.first_message — enforced identically by the DB CHECK and the edge constant, cross-pinned) and stable metric keys. GET /v1/telemetry/export.csv emits the presence-telemetry/v1 contract: a version marker line, then the stable column order metric_key,window_start,window_end,value,numerator,denominator; zero denominators export as empty fields, never a fake zero. Analyst console gated by the workforce analyst role + app.analyst GUC + RLS."),
    "TR-35": ("partial", "Reason payload is render-complete (TR-08); the versioned diagram spec is a client artifact."),
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
    "SEC-01": ("partial", "Consumer realm enforces WebAuthn-with-UV, platform attachment, resident keys; AAL2 conformance evidence + client integration pending."),
    "SEC-02": ("partial", "5-minute realm access tokens configured; device binding (attestation) and the 60-second revocation drill pending."),
    "SEC-03": ("partial", "Workforce realm ships hardware-2FA policy, elevation-eligible role and a 4-hour session ceiling; the automated JIT grant workflow is pending."),
    "SEC-04": ("implemented", "RLS on every personal-data table; app connects as non-bypass roles; tested."),
    "SEC-05": ("partial", "Only the edge role reads envelopes, RLS-gated to pair members; no analytics/admin read path exists."),
    "SEC-06": ("implemented", "TLS 1.3 everywhere at APISIX: the K8s listener is 9443 TLS-only with HTTP/2 (TR-26), and dev compose now mirrors it — same listener shape, ssl_protocols TLSv1.3, HSTS/CSP on the edge route, and a gitignored self-signed dev cert from deploy/apisix/dev-tls.sh. Plaintext 9080 is no longer published; openapi and the deploy validator track the TLS surface."),
    "SEC-07": ("external-evidence", "AES-256-GCM at rest + KMS + annual rotation — production-infra evidence."),
    "SEC-08": ("implemented", "No coordinate columns anywhere; server rejects coordinate fields; H3 cells only."),
    "SEC-09": ("implemented", "Recovery phone stored as keyed hash only: PUT/GET/DELETE /v1/account/recovery-phone normalises to E.164 and stores HMAC-SHA256 (RECOVERY_HASH_KEY — presence-secrets in K8s, clearly-marked dev value in compose) in recovery_phones (0015); the hash is platform-wide unique, RLS is owner-only with no console read, collisions share the neutral 422 with malformed numbers, GET returns existence only. No plaintext phone column exists anywhere (pinned repo-wide); Keycloak README records that no phone attribute is used."),
    "SEC-10": ("implemented", "Server persists ciphertext bytea + routing metadata only; client MLS integration pending."),
    "SEC-11": ("external-evidence", "Encrypted backups, separate key, dual-authorisation restore — production ops."),
    "SEC-12": ("organisational", "Per-category privacy-by-design rationale recorded in the DPIA."),
    "SEC-13": ("implemented", "Introduction consent ledgered with actor+timestamp (FR-35); data-processing consents in data_processing_consents (migration 0019): purpose, scope, policy_version, granted_at/withdrawn_at, owner-only RLS, no DELETE policy — withdrawal marks the artefact (PUT/DELETE /v1/account/consents/:purpose are symmetric), GET /v1/account/consents is the retrievable artefact and dsar_export carries it; account erasure disposes of the artefacts with the account."),
    "SEC-14": ("implemented", "DSAR assemble (GET /account/export) and erasure (DELETE /account) respond in seconds — far inside the 30-day/72-h SLAs; masking preserved in exports."),
    "SEC-15": ("organisational", "Record of processing activities per Appendix B."),
    "SEC-16": ("implemented", "analytics/pseudonym.py: HMAC-SHA256 pseudonyms keyed by a salt rotating every calendar month (uncorrelatable across months); the k floor (K_MIN=11, pinned to the edge aggregate.ts constant) removes any cell-level aggregate below the floor — rows simply do not exist in gold. Pinned repo-wide in tests/test_analytics_pseudonym.py."),
    "SEC-17": ("implemented", "Privacy-preserving age assurance with no ID-document storage: self-declaration (FR-02 year-only) plus a moderation-triggered re-verification loop — underage/actioned resolution flags the account in the same txn, discovery closes with the neutral error, and re-verification requires an adult year consistent (±1) with the declaration on file. No passport/NIN/BVN/document storage exists anywhere in schema, edge or realm exports (pinned repo-wide)."),
    "SEC-18": ("implemented", "Third-party SDK allowlist enforced in CI: docs/security/sdk-allowlist.json is the governed list (name/ecosystem/version constraint/justification/data-access/approver per entry) and scripts/check_sdk_allowlist.py is a fail-closed gate over every client dependency manifest (npm, pub, CocoaPods, Maven) — an unlisted SDK or a constraint violation fails the build. The sdk-allowlist CI job runs it on every PR and push; with no client/ tree yet the gate passes and holds any manifest to the list from its first commit."),
    "SEC-19": ("partial", "Assertion header required on presence write; cryptographic verification + documented fallback pending."),
    "SEC-20": ("implemented", "rl:scan:h 200/h (429) and rl:wave:d 20/day (429) Valkey counters; isImpossibleTravel rejects fixes implying >500 km/h with a 422."),
    "SEC-21": ("implemented", "screenText covers links, contact details and scam/bypass abuse patterns on first messages (enforced pre-storage in the messages route); room notes (FR-46) reuse the same module when rooms land (FR-44); tested."),
    "SEC-22": ("implemented", "No list endpoints; results capped at 3; tie-break rotates per scan via edge-supplied seed (sha256(seed:userId)); unseeded legacy order retained only for tooling/tests."),
    "SEC-23": ("external-evidence", "OWASP ASVS 4.0.3 L2 / MASVS 2.0 L1 assessment before launch."),
    "SEC-24": ("implemented", "Dependencies pinned (exact versions + lockfile), and every merge to main now produces an SBOM and SLSA mode=max provenance attestation per service image plus a keyless cosign signature over the immutable digest (deploy.yml) — signed provenance is a per-merge artefact, verified in the same job."),
    "SEC-25": ("implemented", ".github/workflows/ci.yml dependencies job — license-checker with an allowlist (MIT/ISC/Apache-2.0/BSD/0BSD/CC0) over both services on every PR."),
    "SEC-26": ("implemented", ".github/workflows/ci.yml (tests, npm audit, gitleaks) + codeql.yml (SAST for TS/Python) + dependabot.yml — all gated on every PR and push to main."),
    "SEC-27": ("organisational", "Independent pen test before launch and annually."),
    "SEC-28": ("partial", "Only clearly-marked dev secrets in compose; managed secret store arrives with K8s."),
    "SEC-29": ("implemented", "pino hooks.logMethod scrubber: coordinate/content/credential keys redacted, Bearer/apikey/JWT strings scrubbed, cell+user pairings redacted; 10 unit tests."),
    "SEC-30": ("implemented", "security_audit (migration 0019): append-only security-event store, separate from application logs, retained indefinitely (12-month floor) — immutability trigger for every role, governed kind vocabulary (impossible_travel, missing_attestation, attestation_key_duplicate, mock_location_refusal, console_authorization_denied, retention.purge) enforced by CHECK and pinned equal to the edge SECURITY_EVENT_KINDS, writes only via SECURITY DEFINER record_security_event, reads only through the app_moderator GUC (GET /v1/moderation/security-events). Wired at presence publish (impossible travel, missing attestation), device enrolment (attestation), console role denials and the NFR-22 purge."),
    "SEC-31": ("organisational", "Incident response plan, severity levels, on-call, 72-h regulator path, twice-yearly rehearsal."),
    "SEC-32": ("organisational", "Law-enforcement request procedure + annual transparency report."),
    "SEC-33": ("implemented", "group_table_member_cap() trigger locks the table row FOR UPDATE and rejects the seventh member; slot_bookings PK caps one booking per slot; rooms (FR-44) inherit the same pattern when built."),
    "SEC-34": ("partial", "Code-owned domain allowlist + https-only/credential-free/length-bound validation (links.ts, unit-tested), https CHECK at the data layer, plain-text responses carrying interstitial:true, and a no-fetch guarantee pinned by test_group_surface. Gap: rendering the warning sheet is client work, pending with the RN client."),
    "SEC-35": ("client", "Contentless ambient surfaces — client enforcement."),
    "SEC-36": ("implemented", "POST /v1/devices/mock-location-refusal (202) records the client-side refusal in security_audit (kind mock_location_refusal) for abuse review; there is no user-facing read path — disclosure to other users is impossible by construction, the only reader is the moderation console under the moderator GUC. The mock-location detection itself is client work."),
    "SEC-37": ("implemented", "screenText gates both announcement publish and respond routes; findings return category-coded 422, never the matched text."),
    "SEC-38": ("implemented", "Responses endpoint is publisher-only (403), LIMIT 5, and masks responder identity until acceptance (publicResponse)."),
})
CLASSIFICATION.update({
    # ---------------- INF ----------------
    "INF-01": ("external-evidence", "Single primary region + same-jurisdiction warm standby — production topology."),
    "INF-02": ("partial", "Local compose exists; integration/staging/production environments not provisioned."),
    "INF-03": ("partial", "Synthetic distributional data generator exists (eval harness); environment separation pending INF-02."),
    "INF-04": ("implemented", "Compose + migrations + ADRs + full K8s manifests (deploy/k8s: workloads, gateway, HPA, NetworkPolicy, canary) are code; scripts/validate_deploy.py asserts the invariants."),
    "INF-05": ("external-evidence", "API/match sizing 3x 2 vCPU/4 GB — production."),
    "INF-06": ("external-evidence", "Valkey 1 primary + 1 replica, 4 GB — production."),
    "INF-07": ("external-evidence", "Postgres 4 vCPU/16 GB, 500 GB SSD, PITR — production."),
    "INF-08": ("external-evidence", "Centrifugo 2 nodes x 2 vCPU — production."),
    "INF-09": ("superseded", "ClickHouse superseded by the OpenSearch-only decision (ADR-0006 / TECH-21)."),
    "INF-10": ("implemented", "autoscaling/v2 HPAs on edge + match: external p95 metric (120 ms target, 3-min window) with CPU fallback; scaleDown capped at 1 pod per 600 s; asserted by scripts/validate_deploy.py."),
    "INF-11": ("partial", "TLS termination, HSTS and CSP configured at APISIX (validated); OCSP stapling is delegated to the cert-manager issuance chain and needs production evidence."),
    "INF-12": ("implemented", "K8s: only APISIX reaches edge, only edge reaches match, everything else ClusterIP/headless; default-deny-all NetworkPolicy; asserted by scripts/validate_deploy.py."),
    "INF-13": ("external-evidence", "Edge DDoS mitigation + pre-launch test."),
    "INF-14": ("implemented", "Default-deny egress + per-workload egress allowlists (DNS only otherwise) in deploy/k8s/networkpolicy.yaml; asserted by scripts/validate_deploy.py."),
    "INF-15": ("implemented", "Merge -> signed reproducible artefact -> auto-deploy: .github/workflows/deploy.yml builds edge+match on every merge to main with commit-timestamp SOURCE_DATE_EPOCH and digest addressing (reproducible), attaches buildx SBOM + mode=max provenance, signs the immutable digest keyless with cosign over the GitHub OIDC identity and self-verifies the signature, then the deploy-integration job kustomize-pins the signed digests and rolls out. Auto-deploy is gated on the integration environment variable so the artefact half runs on every merge until the cluster is wired."),
    "INF-16": ("implemented", "Flagger Canary resources on the APISIX provider: 5% steps held 10 min, auto-rollback on success-rate/p95-latency breach (deploy/k8s/canary.yaml); asserted by scripts/validate_deploy.py. Requires Flagger + Prometheus in-cluster."),
    "INF-17": ("partial", "Forward-only migrations practised; rehearsal against a production-sized snapshot pending."),
    "INF-18": ("external-evidence", "PITR 5-min granularity, 35-day retention, quarterly timed restore."),
    "INF-19": ("external-evidence", "<=EUR1 500/mo at 100k MAU — Kubecost (P1) + monthly review."),
    "INF-20": ("organisational", "On-call staffing, escalation ladder, 30-min Sev-1 acknowledgement."),
    # ---------------- TECH ----------------
    "TECH-01": ("client", "React Native + Expo custom dev client; Expo Go prohibited (BLE)."),
    "TECH-02": ("implemented", "h3-js 4.x in both TS services; the client uses the same library family so cell ids agree bit-for-bit."),
    "TECH-03": ("implemented", "Dockerfiles on node:22-alpine, engines >=22, @types/node 22.10.2; TypeScript strict, pinned toolchain; tests green."),
    "TECH-04": ("implemented", "deploy/postgres/Dockerfile builds on postgis/postgis:17-3.5-alpine with pgvector v0.8.0 and h3-pg v4.2.1 compiled from pinned tags (batch 19); native h3-pg powers the TR-16/37 ladder lookups."),
    "TECH-05": ("implemented", "Valkey 8 (BSD-3); no Redis anywhere."),
    "TECH-06": ("implemented", "Centrifugo v6 (Apache-2.0) runs the Redis engine over Valkey in compose and k8s (CENTRIFUGO_ENGINE_TYPE=redis, CENTRIFUGO_ENGINE_REDIS_ADDRESS=redis://valkey:6379/1) — presence and pub/sub state is shared across the 2 k8s replicas instead of per-process memory; network policies admit centrifugo->valkey and nowhere else."),
    "TECH-07": ("partial", "Three realm imports (consumer passkey policy / workforce hardware 2FA / partners roles) boot in compose; edge verifies RS256 via realm JWKS; passkey-only browser flow + SMS recovery config pending."),
    "TECH-08": ("client", "OpenMLS/vodozemac client crypto; libsignal prohibited (AGPL-3.0 vs closed client)."),
    "TECH-09": ("implemented", "pgvector lives only in the linking stack: extension + taxonomy_node_embeddings vector(384) with HNSW cosine index (migration 0011), link_taxonomy_nodes() excludes sensitive/redirected nodes, app role is SELECT-only; the deterministic ngram-hash-384.v1 embedder is implemented bit-identically in Python (seed generation) and TypeScript (query time), pinned against shared golden vectors. The never-in-match-path boundary is test-pinned: match service, scan route and presence model reference nothing from the linking stack. Deploy postgres image builds pgvector v0.8.0 (deploy/postgres/Dockerfile); migration + seed mounted in compose and k8s."),
    "TECH-10": ("superseded", "ClickHouse superseded by OpenSearch (ADR-0006 / TECH-21); aggregated events only."),
    "TECH-11": ("partial", "Fastify structured logs; OpenTelemetry traces + Grafana stack not wired (AGPL internal-only constraint noted)."),
    "TECH-12": ("partial", "Health endpoints + structured logs done; OpenTelemetry traces missing."),
    "TECH-13": ("implemented", "Golden-file suite (120 pairs) fails on any score change; 81-test Python regression suite."),
    "TECH-14": ("implemented", "tests/test_openapi_contract.py generates assertions from openapi.yaml: strict-body structural + behavioural checks, doc<->route coverage both ways, TR-24 header docs, schema well-formedness."),
    "TECH-15": ("partial", "Python engine is pure/deterministic; TS services read the wall clock directly — clock/id injection not formalised."),
    "TECH-16": ("client", "Dependency maintenance/licence/size budget; 45 MB bundle cap."),
    "TECH-17": ("organisational", "Team skills: TypeScript, React Native, Postgres, one systems language."),
    "TECH-18": ("partial", "Rust match core delivered (services/match-core): the full engine — graph validation, TR-04 closure, TR-06 idf, TR-36 prior, scoring, TR-08/09 reasons, icebreaker — pinned to 1e-9 against the shared 120-pair golden corpus alongside the TS engine and Python reference, bit-deterministic by sorted-order accumulation, committed Cargo.lock, cargo test wired into CI. The Go presence/venue/consent services remain outstanding; TS stays the documented P0 serving stand-in."),
    "TECH-19": ("implemented", "Kafka designated event backbone (ADR-0004); no Fluvio deployed; Kafka rollout itself is ARC P1."),
    "TECH-20": ("implemented", "No Temporal calls on the scan path (none exist anywhere); Temporal rollout is ARC P1."),
    "TECH-21": ("implemented", "No ClickHouse / second warehouse; APISIX is the sole public ingress — the only LoadBalancer Service, enforced by NetworkPolicy (validated); OpenSearch is P1."),
    "TECH-22": ("implemented", "analytics/layers.py: Delta Lake on Parquet medallion — bronze (append-only, date + cell-prefix partitions, 90 days), silver (deduped/validated/conformed, month partitions, 25 months), gold (k-suppressed products, 25 months). Nothing analytical sits on the live match path; P2 engines (Flink/Spark+Sedona) execute the same layer semantics at scale when the phase gate opens."),
    "TECH-23": ("implemented", "No Mojaloop/TigerBeetle deployed; ARC-002 §9 gates them at P3."),
    "TECH-24": ("partial", "Canonical geometry in PostGIS (venues.geofence); GeoLibre authoring/QA workflow not built (TR-41)."),
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
