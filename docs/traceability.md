# Traceability matrix — PRS-SRS-001 v1.0 / PRS-ARC-002

GENERATED ARTEFACT — do not hand-edit. Regenerate with `python3 scripts/build_traceability.py` (SRS §10: the matrix is generated, not hand-maintained).

Total requirements: **306** (283 MUST · 22 SHOULD · 1 MAY per Appendix A).

## Status summary

| Status | Count | Meaning |
|---|---|---|
| implemented | 142 | working in the repo with tests or structural evidence |
| partial | 55 | meaningful part implemented; named gap remains |
| gap-p0 | 0 | ARC-P0 product scope, code not yet built |
| phase-gated | 8 | ARC P1+ component; correctly deferred per TR-40 / ARC-002 §9 |
| client | 36 | requires the React Native client workstream |
| organisational | 34 | legal / process / staffing — not expressible as code |
| external-evidence | 29 | needs production infrastructure or third-party evidence |
| superseded | 2 | superseded by a recorded ADR |

## Per-family breakdown

| Family | implemented | partial | gap-p0 | phase-gated | client | organisational | external-evidence | superseded | total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| BR | 7 | 4 | 0 | 0 | 0 | 22 | 0 | 0 | 33 |
| FR | 65 | 18 | 0 | 1 | 15 | 1 | 0 | 0 | 100 |
| NFR | 7 | 5 | 0 | 1 | 11 | 0 | 13 | 0 | 37 |
| TR | 29 | 5 | 0 | 4 | 6 | 0 | 0 | 0 | 44 |
| SEC | 18 | 10 | 0 | 1 | 1 | 5 | 3 | 0 | 38 |
| INF | 6 | 4 | 0 | 0 | 0 | 1 | 8 | 1 | 20 |
| TECH | 10 | 8 | 0 | 1 | 3 | 1 | 0 | 1 | 24 |
| ACC | 0 | 1 | 0 | 0 | 0 | 4 | 5 | 0 | 10 |

## BR — Business requirements (§3)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| BR-01 | organisational | `db/migrations/0014_markets.sql`<br>`services/edge/src/markets.ts`<br>`tests/test_markets.py` | Single-metro launch with >=3 venues in 2 km — launch-ops gate (ACC-07), not code. |
| BR-02 | organisational | — | Positioning (friendship, not dating) — store copy / onboarding / marketing review; no dating surface exists in code. |
| BR-03 | implemented | `db/migrations/0016_age_assurance.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/moderation.ts`<br>`services/edge/test/recovery.test.ts` | Adults-only enforced end to end: year-only declaration (FR-02) blocks under-18s from every discovery surface with a neutral error; an underage report resolved actioned sets age_reverify_required_at in the same transaction (0016), discovery stays closed, and only an adult re-declaration within ±1 year of the stored year clears the flag — the loop cannot be decade-jumped. Console card exposes the state. |
| BR-04 | organisational | — | Second-city expansion gate on anchor-venue metrics (§2.5 for 3 consecutive weeks). |
| BR-05 | partial | `deploy/keycloak/realm-partners.json` | events table models venue+window; event-scoped instance mode and presence-to-event attribution not wired. |
| BR-06 | organisational | `docs/adr/0007-payments-gated-on-br06.md` | Five sequenced revenue lines only; payments gated per docs/adr/0007. |
| BR-07 | partial | `docs/api/openapi.yaml`<br>`services/edge/src/context.ts` | Reports endpoint exists and is ungated; two-tap reachability is client UX (not built); no monetisation gate exists. |
| BR-08 | implemented | — | Structural: no endpoint exposes precise location, pre-OPEN identity, or unconsented data; no paid tier exists to violate it. |
| BR-09 | organisational | — | Per-market local-currency pricing via store billing — monetisation phase. |
| BR-10 | organisational | — | Pilot unit-economics targets (CAC <= EUR6, payback <=4 mo, conversion >=3%). |
| BR-11 | organisational | — | Venue agreement: data-processing roles, signage, escalation, 30-day termination. |
| BR-12 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`deploy/keycloak/realm-partners.json`<br>`docs/api/openapi.yaml`<br>`services/edge/src/aggregate.ts`<br>`services/edge/src/routes/checkin.ts` | GET /v1/venues/:venueId/dashboard serves live presence, hourly scans, active offers and live announcements to venue_ids-claim tokens; match-funnel attribution arrives with FR-43. |
| BR-13 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/aggregate.ts`<br>`services/edge/src/routes/interests.ts`<br>`services/edge/src/routes/venue.ts`<br>`services/edge/test/aggregate.test.ts` | kSuppressed (aggregate.ts, k=11) withholds every dashboard figure below k; routes/venue.ts applies it to all metrics. |
| BR-14 | partial | `deploy/keycloak/realm-workforce.json` | venues.active is checked on scan (immediate effect); suspension fully propagates within the 15-min TTL; venue self-serve suspend endpoint missing. |
| BR-15 | organisational | — | Resourcing: 4 FTE + fractional design/DPO/T&S, 16 weeks to pilot. |
| BR-16 | organisational | — | T&S staffing >=1 moderator per 10k MAU + named escalation path. |
| BR-17 | organisational | — | Budget: build + 12-month run + EUR2M cyber insurance + independent pen test. |
| BR-18 | organisational | — | Named DPO before EU processing, independent of Product/Engineering. |
| BR-19 | organisational | — | DPIA signed before launch; annual or on-material-change review. |
| BR-20 | organisational | — | ToS / Privacy Notice / Community Guidelines / Cookie notice per launch language. |
| BR-21 | partial | — | Taxonomy seed is synthetic (no CC0 content used); per-release provenance record (TR-20) missing. |
| BR-22 | organisational | — | Nominative, descriptive use only; seed uses names without logos/marks; formal legal review outstanding. |
| BR-23 | organisational | — | Register of processing activities + published sub-processor list. |
| BR-24 | organisational | — | Five launch lines / prices / inclusions per §3.6.1. |
| BR-25 | organisational | — | Venue pricing per venue, unmetered. |
| BR-26 | implemented | — | Structural: the scorer reads profile + corpus only; no tier or payment input exists on the match path. |
| BR-27 | implemented | — | Structural: the matcher never receives partner status; per-venue config is limited to threshold/result-count (TR-11). |
| BR-28 | organisational | `services/edge/src/aggregate.ts` | Aggregate-only reporting principle; no revenue line exists yet. |
| BR-29 | organisational | — | Unit-economics model as single source of truth, monthly review. |
| BR-30 | organisational | — | New revenue line requires DPIA + spec revision. |
| BR-31 | organisational | — | Commercial model reviewed vs telemetry at each month close. |
| BR-32 | organisational | — | >20% multi-site discounts modelled pre-signature. |
| BR-33 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/announcements.ts`<br>`services/edge/src/routes/announcements.ts` | Category CHECK in migration 0004 + canPublishCategory; the work category requires the verified_org token claim (FR-97). |

## FR — Functional requirements (§4)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| FR-01 | partial | `deploy/keycloak/README.md` | Consumer realm ships the passkey policy (platform authenticator, user verification required, passwords disabled); edge verifies RS256 via JWKS; passkey-only onboarding flow + RN client pending. |
| FR-02 | implemented | `db/migrations/0003_account_deletion.sql`<br>`db/migrations/0016_age_assurance.sql`<br>`deploy/keycloak/README.md`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts` | POST /account/age-declaration upserts a birth-year declaration; under-18 sets age_blocked; presence+scan refuse with a neutral 403 (no reason disclosed); boundary fails toward blocking; tested. |
| FR-03 | partial | `db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts` | DELETE /v1/account erases in one authenticated call; the <=3-tap journey is client UX, pending with the RN client. |
| FR-04 | implemented | `db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/presence.ts`<br>`services/edge/src/routes/scan.ts` | delete_account purges envelopes/pairs/blocks/profile/identity synchronously and tombstones the user; the edge strips Valkey presence+suppress+block keys in the same call; ledger actors anonymised after the 90-day hold by lifecycle_tick. |
| FR-05 | implemented | `db/migrations/0010_devices.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/devices.ts`<br>`services/edge/src/routes/devices.ts`<br>`services/edge/test/devices.test.ts` | POST/GET/DELETE /v1/devices over the devices registry (migration 0010): device_cap() trigger locks the user row FOR UPDATE and rejects the fourth concurrent device (SEC-33 idiom; re-enrolment of a live fingerprint is a refresh, exempt from the count); one active row per key_fingerprint via partial unique index; enrolment publishes device_enrolled to the account's own channel with label only — never the fingerprint; revocation is idempotent and owner-scoped by RLS. |
| FR-06 | partial | — | user_identities carries handle + photo gated to OPEN by RLS; display-name default and 140-char bio missing. |
| FR-07 | implemented | `db/migrations/0010_devices.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/devices.ts`<br>`services/edge/src/routes/devices.ts`<br>`services/edge/src/routes/moderation.ts` | register_attestation_key() SECURITY DEFINER enrols/refreshes/detects atomically: a cross-account collision keeps the key with its original account, inserts attestation_duplicates and writes admin_audit_log('moderation.duplicate.detected','impersonation'); the enrolment route returns the same neutral 201 regardless — the console-only registry (RLS app_moderator) surfaces collisions on the moderation account card as keyHashPrefix + both accounts + detected_at. P0 uses the assertion SHA-256 as the key stand-in until cryptographic App Attest verification lands (FR-51 idiom). |
| FR-08 | partial | `db/migrations/0006_profile_safety.sql`<br>`db/migrations/0011_linking.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/linking.ts`<br>`services/edge/src/profile.ts` | PUT/GET /v1/profile/interests replace the set server-side: 3-20 unique taxonomy nodes validated, weights in (0,1], sensitive rejected at write time (TR-22). Gap: the searchable <=3-level picker UI is client work (RN milestone). |
| FR-09 | implemented | `db/migrations/0011_linking.sql`<br>`db/migrations/0012_taxonomy_cms.sql`<br>`db/seed/taxonomy_embeddings.sql`<br>`deploy/docker-compose.yml`<br>`deploy/k8s/postgres.yaml` | POST /v1/profile/interests/link: free text (<=500 chars, screened SEC-26 idiom) is embedded with the deterministic ngram-hash-384.v1 embedder and matched over the pgvector taxonomy space (migration 0011 + generated seed); top-5 candidates above a 0.15 cosine floor, sensitive/redirected nodes excluded at seed and query time (TR-22), already-declared nodes excluded via the owner-GUC read (FR-13 discipline). Per-node confirmation: the route never writes (test-pinned) — confirmed nodes go through the governed FR-08 endpoint. |
| FR-10 | implemented | `docs/api/openapi.yaml`<br>`presence/matching.py`<br>`services/edge/src/routes/profile.ts`<br>`services/match-core/README.md`<br>`services/match/src/engine.ts` | Sensitive nodes excluded from vectors, reasons, idf and bonus at build time; covered by engine tests. |
| FR-11 | partial | `presence/matching.py`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts`<br>`services/match/src/store.ts` | Candidates need >=2 interests to be scored; publish-side >=3 enforcement + client explanation missing. |
| FR-12 | implemented | `deploy/k8s/prometheusrules.yaml`<br>`docs/runbook.md` | Profile and corpus caches refresh on a 60 s loop (TR-05). |
| FR-13 | implemented | `db/migrations/0009_rooms.sql`<br>`db/migrations/0012_taxonomy_cms.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/interests.ts`<br>`services/edge/src/routes/linking.ts` | GET /v1/interests/:nodeId/popularity — live-cell count over declarations of the node and its descendants, kSuppressed at k=11 (BR-13); sensitive nodes indistinguishable from unknown (TR-22). |
| FR-14 | implemented | `docs/api/openapi.yaml`<br>`docs/presence-model.md`<br>`docs/runbook.md`<br>`services/edge/src/routes/presence.ts`<br>`services/match/src/store.ts` | 900 s Valkey TTL; stale cell members filtered at read; tested. |
| FR-15 | partial | `services/edge/src/context.ts` | Server rejects coordinate-shaped fields with 422 (TR-15); on-device cell computation is client work. |
| FR-16 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/context.ts`<br>`services/edge/src/rooms.ts`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/presence.ts` | newPresenceSessionId (128-bit hex) on session start, kept on heartbeats, reuse rejected 409; presence:session reverse index; scan results carry sessionId+pairId — account ids never leave the edge pre-OPEN. |
| FR-17 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/context.ts`<br>`services/edge/src/intents.ts`<br>`services/edge/src/routes/intents.ts`<br>`services/edge/src/routes/scan.ts` | PUT/GET/DELETE /v1/presence/intent over Valkey only: governed 8-word vocabulary (coffee/food/chat/walk/dance/network/explore/quiet), EX 3600 hard cap, requires live presence, purgePresence deletes intent:{uid} so it dies with presence; scan annotates results with sharedIntent when both sides declared the same active intent — signal only, score contract untouched (test-pinned). |
| FR-18 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/context.ts`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/presence.ts` | users.invisible flag (migration 0004); PUT/GET /v1/account/visibility; flipping on purges live presence at once; publishes refused 403 while set. |
| FR-19 | client | — | Background-withdrawal <=60 s is client lifecycle behaviour. |
| FR-20 | implemented | `db/migrations/0001_init.sql`<br>`docs/api/openapi.yaml`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts`<br>`services/match/test/scan.test.ts` | <=3 candidates with ordered reasons; unit + golden tests. |
| FR-21 | implemented | `db/migrations/0001_init.sql`<br>`presence/matching.py`<br>`services/match/src/engine.ts`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts` | Adaptive threshold: (1-5/n)-quantile floored at venue base; tested. |
| FR-22 | partial | `services/match/src/scan.ts`<br>`services/match/src/server.ts` | MMR (lambda 0.7) over reason-node Jaccard; a hard no-shared-primary-reason guarantee is not enforced. |
| FR-23 | implemented | `docs/presence-model.md`<br>`services/edge/src/context.ts`<br>`services/edge/src/lifecycle.ts`<br>`services/edge/src/routes/lifecycle.ts`<br>`services/edge/src/routes/scan.ts` | Canonical suppression keys, 600 s TTL, both directions; tested. |
| FR-24 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/scan.ts`<br>`services/edge/src/velocity.ts`<br>`services/match/src/server.ts` | 6 scans/min per user at the edge; tested. |
| FR-25 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/scan.ts`<br>`services/match/src/scan.ts`<br>`services/match/test/scan.test.ts` | Bands from H3 grid distance only; no metres/bearing/cell ids in responses. |
| FR-26 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/scan.ts`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts` | Explanatory empty state below 8 discoverable users in scope; tested. |
| FR-27 | implemented | `docs/api/openapi.yaml`<br>`presence/matching.py`<br>`services/match/src/engine.ts` | Ordered reason path in every scan payload; /v1/score re-scores any explicit pair. |
| FR-28 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/budget.ts`<br>`services/edge/src/routes/scan.ts`<br>`services/edge/test/budget.test.ts` | budget.ts ladder (sparse <25: 3/hr; busy <100: 2/hr; crowd: 1/day) enforced in scan.ts via budget:scan:{uid} Valkey counters; separate from the SEC-20 abuse ceiling. |
| FR-29 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0002_offer_lifecycle.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/consent.ts`<br>`services/edge/src/routes/scan.ts` | DETECTED>NUDGED>EXPRESSED>MUTUAL>OPEN enforced by DB trigger; DETECTED recorded on first surfacing; tested. |
| FR-30 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0007_group_surface.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/auth.ts`<br>`services/edge/src/routes/consent.ts` | Identity RLS-gated to OPEN; verified by policy + edge tests. |
| FR-31 | implemented | `docs/api/openapi.yaml` | One wave per offer via illegal-transition rejection; the wave carries no content. |
| FR-32 | implemented | `db/migrations/0002_offer_lifecycle.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/lifecycle.ts`<br>`services/edge/src/routes/account.ts` | Silent decline: POST /consent/:id/decline always answers 204, publishes 'expired'; maskCloseReason maps declined>expired; tested. |
| FR-33 | implemented | `db/migrations/0002_offer_lifecycle.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/index.ts`<br>`services/edge/src/lifecycle.ts` | 30-min offer window: expires_at set at first surfacing, renewed per action; lifecycle_tick expires overdue offers; tested. |
| FR-34 | implemented | `db/migrations/0002_offer_lifecycle.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/lifecycle.ts`<br>`services/edge/src/routes/consent.ts` | Blocking: blocks table (no UPDATE/DELETE grants), permanent Valkey blockKey, scan excludes both directions via blocked_users_for; pair closes silently. |
| FR-35 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`services/edge/src/routes/consent.ts` | Append-only ledger, no-update trigger, actor+timestamp per row; the sole exception is a transaction-local purge mode reachable only from SECURITY DEFINER retention functions (NFR-19/21); tested. |
| FR-36 | implemented | `db/migrations/0001_init.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/messages.ts`<br>`services/edge/src/screening.ts` | Server stores opaque MLS envelopes only (bytea), RLS-gated to OPEN members; client MLS integration pending. |
| FR-37 | implemented | `db/migrations/0002_offer_lifecycle.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/lifecycle.ts`<br>`services/edge/src/routes/consent.ts` | 24-h conversation clock: closes_at set on OPEN, /consent/:id/keep from both sides clears it; lifecycle_tick lapses the rest; messages RLS gates on closed_at. |
| FR-38 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/messages.ts`<br>`services/edge/src/screening.ts`<br>`services/edge/test/screening.test.ts` | First message per sender per pair screened at the edge for links/phones/emails/bypass/scam patterns before storage; rejection is inline and category-level, nothing stored; tested. With MLS the same classifier runs in the client compose path (TECH-08). |
| FR-39 | implemented | — | Only text envelopes exist; no media/voice/file paths to disable. |
| FR-40 | partial | `docs/api/openapi.yaml` | Reports endpoint with announcement anchor (announcement_id, migration 0004); pair/offer anchor columns and the in-conversation control remain. |
| FR-41 | partial | `db/migrations/0006_profile_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/messages.ts` | DELETE /v1/pairs/:pairId/messages/:messageId — sender-only (RESTRICTIVE policy + column-limited grant), 24-h window blanks the envelope and tombstones; 410 after. Gap: local delete UX is client work. |
| FR-42 | partial | `deploy/keycloak/realm-workforce.json` | venues carries geofence (PostGIS), h3_res, thresholds, active; partner status + operating schedule missing. |
| FR-43 | partial | `deploy/keycloak/realm-partners.json`<br>`services/edge/src/routes/venue.ts` | events = venue + window in schema; presence-to-event attribution not wired. |
| FR-44 | implemented | `db/migrations/0009_rooms.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/rooms.ts`<br>`services/edge/src/routes/rooms.ts`<br>`services/edge/src/routes/scan.ts` | Crowd-band transition: GET /v1/venues/:id/rooms lists rooms derived owner-side (room_topics() SECURITY DEFINER) from live members' declared non-sensitive interests; below crowd the list is empty with the mode field; scan responses announce mode=rooms + roomsUrl in the crowd band; joins need live venue presence, a still-crowded venue and a declared interest in the topic. |
| FR-45 | implemented | `db/migrations/0009_rooms.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/rooms.ts`<br>`services/edge/src/routes/rooms.ts`<br>`tests/test_rooms.py` | Room content rules: opaque roomKey (sha256 venue:node), topic, kSuppressed member count, member-only GET with uniform 404, opt-in join/leave; notes carry no author field — opting in is what publishes; everything lives in Valkey with presence-aligned TTL (900s), no room table in Postgres (test-pinned). |
| FR-46 | implemented | `db/migrations/0009_rooms.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/rooms.ts`<br>`services/edge/src/routes/rooms.ts`<br>`services/edge/src/screening.ts` | Posting discipline: SET NX EX 300 gate → one note per member per room per five minutes (429); first note per member per room screened via screenText (SEC-21 idiom, room:screened marker), later notes not re-screened; notes ring-buffered at 50 with TTL refresh on activity. |
| FR-47 | implemented | — | Resolution ladder 9>10 (2 000) >11 (10 000) on live venue density; tested. |
| FR-48 | partial | — | Venue check-in codes live via FR-99/FR-100 signed per-floor tokens; venue-side code printing/distribution ops remain with the client workstream. |
| FR-49 | partial | `docs/api/openapi.yaml` | reports accepts free-text reason; the fixed category enum is missing. |
| FR-50 | organisational | — | 24/7 4-h high-severity triage — staffing/rota (BR-16) plus the moderation console (FR-54). |
| FR-51 | partial | `docs/api/openapi.yaml`<br>`services/edge/src/auth.ts` | Attestation assertion header required on presence write; cryptographic verification + discovery gating pending. |
| FR-52 | implemented | `db/migrations/0008_moderation.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/moderation.ts`<br>`services/edge/src/routes/moderation.ts`<br>`services/edge/test/moderation.test.ts` | trust_score() (db/migrations/0008): deterministic SECURITY DEFINER score — base 0.50, +0.20 age-verified, +0.10 at 30/180 days, -0.15/actioned report (cap -0.45), +0.05/dismissed (cap +0.15), -0.02/unresolved (cap -0.10), clamped [0,1]; drives the moderation queue ordering and account card. |
| FR-53 | implemented | `db/migrations/0008_moderation.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/moderation.ts`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/moderation.ts` | users.investigation_removed_at (discovery gate shares the neutral FR-02 error) + silent purgePresence (no realtime event) via POST /v1/moderation/accounts/:id/investigation-remove|restore; appeals table (one open per account, partial unique index) with POST/GET /v1/account/appeals (screened SEC-26) and console resolve — overturn lifts the suspension and clears the removal in one transaction. |
| FR-54 | implemented | `db/migrations/0006_profile_safety.sql`<br>`db/migrations/0008_moderation.sql`<br>`deploy/keycloak/realm-workforce.json`<br>`docs/api/openapi.yaml`<br>`services/edge/src/auth.ts` | Workforce-realm moderator gate (requireModerator + per-issuer JWKS, app.moderator GUC via withModerator) fronting 8 console routes: trust-ordered queue, account card (trust inputs, suspensions, report stats, account_ledger_stats aggregates, liveNow, audit trail — never message content), report resolve, investigation remove/restore, suspension lift, appeals queue/resolve; every action admin_audit-logged with governed reason codes. |
| FR-55 | implemented | `db/migrations/0008_moderation.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/moderation.ts`<br>`services/edge/src/routes/presence.ts`<br>`services/edge/test/moderation.test.ts` | suspensions table + suspension_dimension enum (attestation_key/handle/payment_instrument), one active per (user, dimension) partial unique index; attestation gate wired into presence publish (neutral 403), handle mask via display_handle() inside group_member_directory, payment_instrument record-only until the P3 payments surface; lift is per-dimension. |
| FR-56 | partial | — | Realtime events carry only a type on an opaque pair channel; APNs/FCM push pipeline not built. |
| FR-57 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/moderation.ts`<br>`services/edge/src/notifications.ts`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/consent.ts` | POST /v1/consent/:pairId/nudge (DETECTED→NUDGED ledger transition, window renewed) capped at 3/sender/UTC-day via Valkey (429); recipient quiet window {start,end} HH:MM UTC (overnight-aware, equal=disabled) stored in notification_prefs and editable via PUT /v1/account/notifications; realtime event suppressed in the window or when the nudges category is off; the event carries no actor identity (FR-30). |
| FR-58 | partial | `db/migrations/0006_profile_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/notifications.ts`<br>`services/edge/src/routes/account.ts`<br>`services/edge/test/notifications.test.ts` | GET/PUT /v1/account/notifications over users.notification_prefs: six categories default-on, safety exemption enforced (422 on safety=false). Gap: enforcement lands with the notification dispatcher (no sender yet). |
| FR-59 | implemented | `db/migrations/0012_taxonomy_cms.sql`<br>`deploy/keycloak/realm-workforce.json`<br>`docs/api/openapi.yaml`<br>`services/edge/src/auth.ts`<br>`services/edge/src/linking.ts` | Taxonomy CMS (migration 0012 + /v1/taxonomy/releases console): draft → submit → approve (second-person, author <> reviewer enforced in SQL) → publish → one-action rollback of the latest published release. Six governed ops (add_node/edit_label/set_sensitive/deprecate/add_link/remove_link; node deletion is not an operation — history is deprecated, never destroyed). Publish snapshots, applies re-validated ops, rebuilds the closure and re-syncs embeddings in one transaction; rollback restores the snapshot as a delta and never touches rows user data references (SECURITY DEFINER reference count, FR-13 discipline). Write-guard triggers keep live taxonomy SELECT-only to the app role outside the CMS; every route gated by requireTaxonomist + app.taxonomist GUC; publish/rollback audited (FR-60). |
| FR-60 | implemented | `db/migrations/0006_profile_safety.sql`<br>`db/migrations/0007_group_surface.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/features.ts`<br>`services/edge/src/routes/moderation.ts` | db/migrations/0006 admin_audit — append-only (immutability trigger for every role), actor/action/reason_code/target/before+after jsonb; SECURITY DEFINER admin_audit_log writer for ops and the FR-54 console. |
| FR-61 | phase-gated | — | Analytics pipeline is P1 lakehouse (Delta/Parquet) per ARC-002 §9; identifier exclusion + cell aggregation specified there. |
| FR-62 | implemented | `db/migrations/0003_account_deletion.sql`<br>`db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts` | GET /account/export assembles the full subject record (profile, interests, pairs, ledger actions, blocks, reports) via dsar_export() with FR-32/34 masking intact; erasure via DELETE /account. |
| FR-63 | implemented | `db/migrations/0006_profile_safety.sql`<br>`services/edge/src/features.ts`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/test/features.test.ts` | db/migrations/0006 venue_features (default-on, ops-written with admin_audit) + features.ts consulted by the announcements route (403 when disabled); further surfaces inherit as they land. |
| FR-64 | implemented | `db/migrations/0006_profile_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/profile.ts`<br>`services/edge/src/routes/profile.ts`<br>`services/edge/src/routes/scan.ts` | profile_prompts (slot 1-3, varchar 120) behind PUT/GET /v1/profile/prompts, screened like announcements (SEC-37); attached to surfaced scan candidates as reason material; no search endpoint, no content index. |
| FR-65 | implemented | `db/migrations/0007_group_surface.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/links.ts`<br>`services/edge/src/routes/links.ts`<br>`services/edge/test/links.test.ts` | PUT/GET /v1/pairs/:pairId/link over pair_links: OPEN-gated by an RLS policy mirroring messages, one link per member (upsert keeps shared_at), counterpart-only reads (owner <> caller), https-only + <=300 chars at the data layer; the server stores and returns the string and never fetches it (SEC-34). |
| FR-66 | implemented | `db/migrations/0007_group_surface.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/groups.ts`<br>`services/edge/src/routes/tables.ts`<br>`services/edge/test/groups.test.ts` | group_tables + group_table_members with member-only RLS; create/join require live venue presence; the six-seat cap is a data-layer trigger (SEC-33), re-join idempotent; self-serve leave, host remove, last-member-out closes. |
| FR-67 | implemented | `db/migrations/0007_group_surface.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/groups.ts`<br>`services/edge/src/routes/tables.ts`<br>`services/edge/test/groups.test.ts` | GET /v1/tables/:id/cards — join-time snapshot (group_table_interests, joining is the act that shares) aggregated over nodes shared by >=2 members, sensitive excluded, ranked by reach, top 5; every card labelled generated:true (buildCards, unit-tested). |
| FR-68 | implemented | `db/migrations/0007_group_surface.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/groups.ts`<br>`services/edge/src/routes/tables.ts` | table_slots (5-60 min, future start) + slot_bookings: the booking row IS the consent act (actor+timestamp, PK caps one booking per slot); conditional state flip guards races; cancel by booker or offerer re-opens future slots, idempotent. |
| FR-69 | implemented | `db/migrations/0007_group_surface.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/groups.ts`<br>`services/edge/src/routes/tables.ts`<br>`tests/test_group_surface.py` | Exactly-one-host trigger + creator seated as host; group_member_directory (SECURITY DEFINER) returns co-member handle+role to members only — the scoped FR-30 carve-out; no photos, nothing leaves the table. |
| FR-70 | client | — | Verification status at identity reveal — client rendering (+ data from FR-51/52). |
| FR-71 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/intents.ts`<br>`services/edge/src/routes/scan.ts`<br>`services/edge/test/intents.test.ts`<br>`tests/test_intents.py` | Recurrence signal: recur:<sha256(lo:hi)> key names nobody; {days, lastDay} day-ordinal counter bumped at most once per UTC day on scan surfacing (bumpRecurrence), EX 90 days retention; wire carries recurrenceDays only — never a timestamp (test-pinned). |
| FR-72 | implemented | `tests/test_group_surface.py` | tests/test_group_surface.py asserts the cap/single-host triggers, RLS on all six tables, member-only policies, creator-scoped insert, the member-scoped directory (no photos), the open-only join probe, and membership-scoped listing with uniform 404s. |
| FR-73 | implemented | `tests/test_group_surface.py` | tests/test_group_surface.py asserts the slot_bookings PK double-book guard, state/duration CHECKs, actor-scoped booking/cancel policies, column-limited grants, the atomic state flip, and host-action audit logging. |
| FR-74 | implemented | `db/migrations/0007_group_surface.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/tables.ts`<br>`tests/test_group_surface.py` | Host remove and close write admin_audit rows (FR-60, governed host_discretion reason); host visibility stops at directory name+role; a host with members cannot leave (409) — they close the table instead. |
| FR-75 | implemented | `db/migrations/0007_group_surface.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/tables.ts`<br>`tests/test_group_surface.py` | GET /v1/tables returns only the caller's memberships (no venue-wide listing exists); every table/slot-scoped route answers a uniform 404 to non-members; group_join_info reveals only venue+headcount of open tables, closed indistinguishable from nonexistent. |
| FR-76 | client | — | Convergence rendering from the reason payload — payload complete server-side (TR-08). |
| FR-77 | implemented | — | Structural: no endpoint exposes maps, bearings, distances, radii, or proximity arrangements. |
| FR-78 | client | — | Density-as-texture rendering, no positional component. |
| FR-79 | client | — | Closing-perimeter expiry affordance, no default countdown. |
| FR-80 | client | — | Shared screen skeleton across pairs/rooms/tables. |
| FR-81 | client | — | Spatial taxonomy picker + <=4-interaction interest selection. |
| FR-82 | client | — | 400-ms sustained-press wave with progressive feedback. |
| FR-83 | client | — | Distinct haptics per transition + non-visual channel. |
| FR-84 | client | — | Co-located close suggestion after 15 min (SHOULD). |
| FR-85 | client | — | Reduced-power 10-min cadence mode with visibility trade-off notice. |
| FR-86 | client | — | Ambient surfaces individually opt-in, off by default, one-action disable. |
| FR-87 | client | — | Prohibited engagement mechanics — none exist server-side; enforcement is client review. |
| FR-88 | client | — | Location-accuracy authorization read before publish; refuse on approximate-only. |
| FR-89 | partial | — | Check-in basis exists (signed tokens + floor attribution, FR-99/FR-100); making check-in the PRIMARY indoor presence path is client/UX work, outstanding. |
| FR-90 | partial | — | venues.geofence holds the canonical polygon; attribution, versioning and precedence logic not implemented. |
| FR-91 | implemented | `services/edge/src/context.ts`<br>`services/edge/src/routes/consent.ts`<br>`services/edge/src/routes/scan.ts`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts` | rotate:{lo}:{hi} keys (EX 604800) set on consent express and excluded from scans; per-user tbreak counter feeds the match service's seeded sha256 tie-break. |
| FR-92 | client | — | 5-min modal-cell stabilisation on device (SHOULD). |
| FR-93 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/announcements.ts`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/test/announcements.test.ts` | POST /v1/announcements: 24-h account trust floor (isTrustedPublisher), effectiveTtlMinutes clamps to the 4-h cap, category on insert. |
| FR-94 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/announcements.ts`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/test/announcements.test.ts` | announcement_responses + accept route; publicResponse masks the responder id until accepted_at is set. |
| FR-95 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/announcements.ts`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/test/announcements.test.ts` | One-live (409) and 24-h publish cooldown (429) edge-side; UNIQUE(announcement_id, responder); responses listing LIMIT 5. |
| FR-96 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/announcements.ts`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/test/announcements.test.ts` | Fixed category enum (schema + CHECK); bodies and responses screened with screenText, category-coded 422 (SEC-37). |
| FR-97 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/announcements.ts`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/test/announcements.test.ts` | canPublishCategory refuses the work category unless the token carries verified_org (BR-33). |
| FR-98 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`docs/runbook.md`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/src/routes/content.ts` | reports.announcement_id + maybe_remove_announcement (2 reports/10 min, removed_at retained); publisher notified via Centrifugo; reads filter removed rows. |
| FR-99 | implemented | `db/migrations/0005_floors_checkin.sql`<br>`docs/api/openapi.yaml`<br>`docs/runbook.md`<br>`services/edge/src/floors.ts`<br>`services/edge/src/routes/checkin.ts` | venue_floors (0005) with per-floor polygons + connected_to; presence floorId attribution validated against declarations; same-venue scans floor-scoped via floorsCompatible. |
| FR-100 | implemented | `db/migrations/0005_floors_checkin.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/checkin.ts`<br>`services/edge/src/routes/checkin.ts`<br>`services/edge/test/checkin.test.ts` | HMAC-SHA256 pc1.<claims>.<sig> tokens, TTL<=300s, mint (partner) + verify (user) routes; NFC/QR printing is venue-side ops of the same token format. |

## NFR — Non-functional requirements (§5)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| NFR-01 | external-evidence | — | Scan server latency p95 <=150 ms — load evidence (ACC-04). |
| NFR-02 | external-evidence | — | Scan server latency p99 <=400 ms — load evidence (ACC-04). |
| NFR-03 | external-evidence | — | Presence publish ack p95 <=120 ms — load evidence. |
| NFR-04 | client | — | Cold start to interactive <=1.8 s mid-tier. |
| NFR-05 | client | — | Warm start <=600 ms. |
| NFR-06 | external-evidence | — | Tap-to-results p95 <=900 ms — end-to-end measurement with the client. |
| NFR-07 | partial | — | Centrifugo realtime fan-out wired; <=500 ms delivery unmeasured. |
| NFR-08 | external-evidence | — | 25 000 concurrent presences per city cluster — capacity test. |
| NFR-09 | external-evidence | — | 600 scans/s at p95 peak — capacity test. |
| NFR-10 | external-evidence | — | 60 000 single-venue burst per 10 min — capacity test. |
| NFR-11 | external-evidence | — | Linear 2x scale-out without schema/client change — K8s HPA + test. |
| NFR-12 | external-evidence | — | 250k-node taxonomy at match latency targets — scale test (TR-21). |
| NFR-13 | external-evidence | — | 99.9% measured scan-path availability — production measurement. |
| NFR-14 | partial | — | Presence path is independent of the matcher; edge returns 502 today — graceful 'discovery paused' client state pending. |
| NFR-15 | external-evidence | — | RTO <=60 min single-zone loss. |
| NFR-16 | external-evidence | — | RPO <=5 min consent ledger (PITR, INF-18). |
| NFR-17 | implemented | — | Presence RPO deliberately zero — Valkey-only, disposable by design; documented. |
| NFR-18 | partial | — | 15-min TTL enforced; the 45-min grace semantics for index residue are only partially explicit (lazy stale-member filtering). |
| NFR-19 | implemented | `db/migrations/0002_offer_lifecycle.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/consent.ts` | 24-h visibility masking (GET /consent) + lifecycle_tick hard-deletes pre-OPEN closed pairs with their ledger rows after 24 h, under the governed purge mode. |
| NFR-20 | implemented | `db/migrations/0002_offer_lifecycle.sql`<br>`db/migrations/0003_account_deletion.sql`<br>`services/edge/src/index.ts`<br>`services/edge/src/lifecycle.ts` | lifecycle_tick deletes messages 24 h after pair close; messages RLS blocks reads on closed pairs immediately. |
| NFR-21 | implemented | `db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml` | Ledger append-only for all app traffic (governed purge mode is unreachable by the app role); lifecycle_tick anonymises actors 90 days after account deletion. |
| NFR-22 | partial | — | Reports persisted; 12-month retention policy job missing. |
| NFR-23 | phase-gated | — | 25-month aggregate analytics retention — P1 lakehouse. |
| NFR-24 | external-evidence | — | 35-day backup retention — production ops. |
| NFR-25 | client | — | WCAG 2.2 AA (contrast, dynamic type, screen reader, focus, reduced motion). |
| NFR-26 | client | — | 44x44 pt touch targets. |
| NFR-27 | client | — | English at launch; localisable without code changes; +2 locales in 3 months. |
| NFR-28 | client | — | iOS 16+ / Android 10+ with graceful BLE-floor degradation. |
| NFR-29 | client | — | Foreground battery <=2%/h on reference mid-tier. |
| NFR-30 | client | — | Background battery parity with a no-op app when background presence is off. |
| NFR-31 | partial | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`docs/runbook.md`<br>`scripts/validate_deploy.py` | Fastify request ids per service; APISIX request-id plugin generates and echoes X-Request-Id at the gateway; edge->match propagation of the id still missing. |
| NFR-32 | implemented | `db/migrations/0013_telemetry.sql`<br>`deploy/keycloak/realm-workforce.json`<br>`docs/api/openapi.yaml`<br>`services/edge/src/auth.ts`<br>`services/edge/src/routes/consent.ts` | The four §2.5 product metrics (scan.surfaced_rate, surfacing.express_rate, mutual.open_rate, open.first_message_rate) are computed by one pass over telemetry_events (migration 0013). Events are written synchronously by the causing request — scan completed/DETECTED in the scan route, EXPRESS/NUDGE/OPEN in the consent routes, pair-first message in the messages route — never queued or batched (test-pinned), so the five-minute computability budget is met by construction; GET /v1/telemetry/metrics reports the age of the newest underlying event as evidence. Aggregate dims only — no user ids, pair ids or cells (test-pinned). |
| NFR-33 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/prometheusrules.yaml` | deploy/k8s/prometheusrules.yaml — one PrometheusRule alert per required class, each with severity and owner. |
| NFR-34 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/prometheusrules.yaml`<br>`docs/runbook.md` | docs/runbook.md — per-alert symptom/impact/first-actions/escalation, owner named per alert. |
| NFR-35 | client | — | 60 fps match surface (>=30 fps floor on weakest supported device). |
| NFR-36 | client | — | Ambient refresh <=1/min, no idle radio wake. |
| NFR-37 | client | — | Primary action reachable one-handed in the lower 40% of the display. |

## TR — Technical requirements (§6)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| TR-01 | implemented | — | Edge + match are stateless; all state lives in Valkey/Postgres. |
| TR-02 | partial | — | Scan reads Valkey + warmed caches; a cold profile cache miss still hits Postgres inline — bulk warming or async load outstanding. |
| TR-03 | partial | — | K8s NetworkPolicies isolate east-west traffic (only declared flows allowed); mTLS between services awaits the mesh decision. |
| TR-04 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0012_taxonomy_cms.sql`<br>`db/seed/taxonomy.sql`<br>`presence/graph.py`<br>`presence/matching.py` | 0.55/hop, depth <=4, max-combine — pinned against the answer key (653/653). |
| TR-05 | implemented | `docs/presence-model.md`<br>`docs/runbook.md`<br>`presence/graph.py`<br>`presence/matching.py`<br>`scripts/export_golden.py` | df over live presence, link-free closures, 60 s refresh loop. |
| TR-06 | implemented | `presence/matching.py`<br>`services/match-core/README.md`<br>`services/match/src/engine.ts`<br>`tests/test_matching.py` | sqrt(ln(1+N/(1+df))) with cap — pinned. |
| TR-07 | implemented | `db/migrations/0001_init.sql`<br>`db/seed/taxonomy.sql`<br>`presence/graph.py`<br>`presence/matching.py`<br>`scripts/export_taxonomy_sql.py` | Links contribute one hop at authored weight <=0.5, excluded from df — pinned. |
| TR-08 | implemented | `docs/api/openapi.yaml`<br>`presence/matching.py`<br>`services/match-core/README.md`<br>`services/match/src/engine.ts`<br>`services/match/test/engine.test.ts` | Ordered reasons with node ids, labels, contributions in every response. |
| TR-09 | implemented | `db/migrations/0001_init.sql`<br>`presence/matching.py`<br>`scripts/export_golden.py`<br>`services/edge/src/screening.ts`<br>`services/match/src/engine.ts` | Deterministic template rendering; no LLM anywhere in reason generation. |
| TR-10 | implemented | `presence/matching.py`<br>`services/match/src/engine.ts`<br>`services/match/test/engine.test.ts`<br>`tests/test_match_core.py`<br>`tests/test_matching.py` | 81 Python tests incl. 60 key-pinned pairs; 120-pair TS golden parity at 1e-9. |
| TR-11 | implemented | `db/migrations/0001_init.sql`<br>`services/edge/src/routes/scan.ts`<br>`services/match/src/scan.ts`<br>`services/match/test/scan.test.ts` | venues.base_threshold / max_scan_results configurable per venue row without deployment. |
| TR-12 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0014_markets.sql`<br>`docs/api/openapi.yaml`<br>`docs/presence-model.md`<br>`services/edge/src/markets.ts` | H3 res 9 default; k=1 ring; tested. |
| TR-13 | implemented | `docs/api/openapi.yaml` | Responses carry bands only — no neighbour cell or ring distance. |
| TR-14 | implemented | `docs/presence-model.md` | Descent at 2 000 / 10 000 live presences; tested. |
| TR-15 | implemented | `docs/adr/0008-maplibre-geolibre-postgis.md`<br>`docs/api/openapi.yaml`<br>`docs/presence-model.md`<br>`services/edge/src/auth.ts`<br>`services/edge/src/routes/presence.ts` | Coordinate-shaped payload fields hard-422; tested. |
| TR-16 | implemented | `db/migrations/0014_markets.sql`<br>`services/edge/src/markets.ts`<br>`services/edge/src/routes/presence.ts`<br>`tests/test_markets.py` | h3-pg v4.2.1 builds into the deploy postgres image (deploy/postgres/Dockerfile, pinned tag, vendored H3 core submodule). market_config.center_cell is a native h3index column (migration 0014) and market resolution runs native operators in the database — market_for_cell(h3index) compares h3_cell_to_parent at the centre's own resolution. Presence ephemera stays Valkey-only by design; the native type serves configuration and every future persisted cell need. |
| TR-17 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0012_taxonomy_cms.sql`<br>`presence/graph.py`<br>`services/edge/src/taxonomy.ts`<br>`services/edge/test/taxonomy.test.ts` | Graph enforces an acyclic hierarchy <=5 levels + typed non-hierarchical edges. |
| TR-18 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0012_taxonomy_cms.sql`<br>`db/seed/taxonomy.sql`<br>`docs/api/openapi.yaml`<br>`presence/graph.py` | taxonomy_closure materialised, rebuilt by the seed/export pipeline. |
| TR-19 | partial | `presence/graph.py` | redirect_to column + Python graph support exist; the TS engine does not resolve redirects yet. |
| TR-20 | implemented | `db/migrations/0012_taxonomy_cms.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/taxonomy.ts`<br>`services/edge/src/taxonomy.ts`<br>`services/edge/test/taxonomy.test.ts` | taxonomy_releases carries a monotonic version from the taxonomy_release_version sequence (assigned at publish only, UNIQUE), full provenance (author, reviewer, published_by, rolled_back_by + per-transition timestamps) and a diff summary jsonb counted per operation class; the pre-publish snapshot is stored on the release as the rollback basis. Exposed on the release list/detail console endpoints. |
| TR-21 | implemented | `scripts/scale_taxonomy_closure.py`<br>`tests/test_closure_scale.py` | 250k-node closure <10 min enforced in CI: scripts/scale_taxonomy_closure.py builds a deterministic 250k-node taxonomy (depth-capped like the governed one) and rebuilds the closure with the exact WITH RECURSIVE block extracted verbatim from migration 0012 — the harness cannot drift from production. The taxonomy-scale CI job runs it against a postgres:17 service on every PR and push, asserting both the 600-s budget and the exact closure row count; the walk semantics (ancestors only, hops 1..4) are additionally executed against SQLite in the acceptance tests. |
| TR-22 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0009_rooms.sql`<br>`db/migrations/0011_linking.sql`<br>`db/migrations/0012_taxonomy_cms.sql`<br>`docs/api/openapi.yaml` | Sensitive nodes skipped at vector construction (write time), not query time. |
| TR-23 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/app.ts`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/src/routes/content.ts` | docs/api/openapi.yaml is the machine-readable contract; every /v1 body/query/params carries a JSON Schema with additionalProperties:false under ajv strict mode — unknown fields hard-400 before the handler runs. |
| TR-24 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/app.ts`<br>`services/edge/src/idempotency.ts`<br>`services/edge/test/idempotency.test.ts`<br>`tests/test_openapi_contract.py` | Optional Idempotency-Key honoured on all mutating endpoints: idem:{uid}:{key} pending-lease/24h record in Valkey, replay + 409-in-flight semantics, 5xx clears. |
| TR-25 | partial | — | Errors carry a message only; stable machine codes + retry hints missing; no internal leaks observed. |
| TR-26 | implemented | `deploy/apisix/config.yaml`<br>`deploy/docker-compose.yml`<br>`deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/canary.yaml` | APISIX listener configured TLSv1.3-only with HTTP/2 (deploy/k8s/apisix.yaml); downgrade impossible at the listener; asserted by scripts/validate_deploy.py. Dev compose stays plaintext by design. |
| TR-27 | client | — | Unsupported-version detection + update prompt. |
| TR-28 | implemented | — | All expiry windows use server now(); no client-clock input anywhere. |
| TR-29 | client | — | On-device cell computation; raw coordinates discarded before any network call. |
| TR-30 | client | — | Minimum local state; cleared on logout/uninstall signal. |
| TR-31 | client | — | BLE rotating derived codes <=15 min, never a stable identifier. |
| TR-32 | client | — | Graceful degradation on denied Bluetooth/location/push permissions. |
| TR-33 | client | — | Certificate pinning removable by configuration (MAY). |
| TR-34 | implemented | `db/migrations/0013_telemetry.sql`<br>`deploy/keycloak/realm-workforce.json`<br>`docs/api/openapi.yaml`<br>`services/edge/src/auth.ts`<br>`services/edge/src/routes/consent.ts` | Stable governed event keys (scan.completed, consent.transitioned, pair.first_message — enforced identically by the DB CHECK and the edge constant, cross-pinned) and stable metric keys. GET /v1/telemetry/export.csv emits the presence-telemetry/v1 contract: a version marker line, then the stable column order metric_key,window_start,window_end,value,numerator,denominator; zero denominators export as empty fields, never a fake zero. Analyst console gated by the workforce analyst role + app.analyst GUC + RLS. |
| TR-35 | partial | — | Reason payload is render-complete (TR-08); the versioned diagram spec is a client artifact. |
| TR-36 | implemented | `docs/runbook.md`<br>`presence/matching.py`<br>`services/match-core/README.md`<br>`services/match/src/engine.ts`<br>`services/match/src/store.ts` | Optional global prior (all-profile link-free df, 10-min rebuild) blended with fade w(N)=(30-N)/30 — 0% shift at N>=30, exact-formula tests in TS+Python. |
| TR-37 | implemented | `db/migrations/0014_markets.sql`<br>`services/edge/src/markets.ts`<br>`services/edge/src/routes/presence.ts`<br>`services/edge/test/edge.test.ts`<br>`tests/test_markets.py` | The TR-12/14 storage-resolution ladder is per-market configuration: market_config (migration 0014) carries res_default/res_busy/res_crowd + busy/crowd presence thresholds with ordering CHECKs and a single-active-market index (BR-01). The presence route resolves the ladder via ladderForCell — native market_for_cell lookup, 60-second Valkey cache, governed fallback equal to the seeded Lagos row so day-one behaviour is unchanged (cross-pinned). Calibration changes propagate within a minute, no deploy. |
| TR-38 | phase-gated | — | Polygon attribution as a lakehouse spatial join published to the operational store (P1 lakehouse). |
| TR-39 | phase-gated | — | Gold-table owner/grain/SLO/retention + catalogue registration (P1 lakehouse). |
| TR-40 | implemented | — | Phase-gate admission documented; 8 ADRs recorded (Valkey, Keycloak, Kafka, Dapr, OpenSearch, payments, GeoLibre, sequencing). |
| TR-41 | implemented | `db/migrations/0017_geofence_review.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/auth.ts`<br>`services/edge/src/geofence.ts`<br>`services/edge/src/routes/geofence.ts` | GeoLibre authoring workflow built end to end: geofence_drafts (0017) carries draft -> in_review -> approved -> published/rejected with venue/floor targeting on the canonical PostGIS records; the venue-ops console routes (6, all GUC-gated) run the state machine; approval records a reviewer who must not be the author (four-eyes); publish_geofence_draft() is the only write path to venues.geofence/venue_floors.geofence and re-verifies the second person plus the density gate (valid, >=4 vertices, 10 m²..1 km², no edge > 25 m via the ST_Segmentize identity) in one transaction before auditing. The edge mirrors the gate in TypeScript for live editor feedback (cross-pinned constants). |
| TR-42 | implemented | `db/migrations/0005_floors_checkin.sql`<br>`db/migrations/0017_geofence_review.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/floors.ts`<br>`services/edge/src/routes/scan.ts` | venue_floors.venue_id/floor_id + geography(Polygon,4326) geofence + connected_to on the venue geometry records (0005, PostGIS canonical). |
| TR-43 | phase-gated | — | GeoParquet analytical outputs (P1 lakehouse). |
| TR-44 | phase-gated | — | Static-tile serving when map surfaces arrive; no runtime tile server exists (compliant by absence). |

## SEC — Security requirements (§7)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| SEC-01 | partial | — | Consumer realm enforces WebAuthn-with-UV, platform attachment, resident keys; AAL2 conformance evidence + client integration pending. |
| SEC-02 | partial | `deploy/keycloak/README.md`<br>`services/edge/src/auth.ts` | 5-minute realm access tokens configured; device binding (attestation) and the 60-second revocation drill pending. |
| SEC-03 | partial | `deploy/keycloak/README.md`<br>`deploy/keycloak/realm-workforce.json` | Workforce realm ships hardware-2FA policy, elevation-eligible role and a 4-hour session ceiling; the automated JIT grant workflow is pending. |
| SEC-04 | implemented | — | RLS on every personal-data table; app connects as non-bypass roles; tested. |
| SEC-05 | partial | — | Only the edge role reads envelopes, RLS-gated to pair members; no analytics/admin read path exists. |
| SEC-06 | implemented | `deploy/apisix/apisix.yaml`<br>`deploy/apisix/config.yaml`<br>`deploy/docker-compose.yml`<br>`deploy/k8s/README.md`<br>`docs/api/openapi.yaml` | TLS 1.3 everywhere at APISIX: the K8s listener is 9443 TLS-only with HTTP/2 (TR-26), and dev compose now mirrors it — same listener shape, ssl_protocols TLSv1.3, HSTS/CSP on the edge route, and a gitignored self-signed dev cert from deploy/apisix/dev-tls.sh. Plaintext 9080 is no longer published; openapi and the deploy validator track the TLS surface. |
| SEC-07 | external-evidence | `deploy/apisix/config.yaml`<br>`deploy/k8s/README.md` | AES-256-GCM at rest + KMS + annual rotation — production-infra evidence. |
| SEC-08 | implemented | — | No coordinate columns anywhere; server rejects coordinate fields; H3 cells only. |
| SEC-09 | implemented | `db/migrations/0015_recovery.sql`<br>`deploy/docker-compose.yml`<br>`deploy/k8s/edge.yaml`<br>`deploy/keycloak/README.md`<br>`docs/api/openapi.yaml` | Recovery phone stored as keyed hash only: PUT/GET/DELETE /v1/account/recovery-phone normalises to E.164 and stores HMAC-SHA256 (RECOVERY_HASH_KEY — presence-secrets in K8s, clearly-marked dev value in compose) in recovery_phones (0015); the hash is platform-wide unique, RLS is owner-only with no console read, collisions share the neutral 422 with malformed numbers, GET returns existence only. No plaintext phone column exists anywhere (pinned repo-wide); Keycloak README records that no phone attribute is used. |
| SEC-10 | implemented | `services/edge/src/screening.ts`<br>`services/edge/test/screening.test.ts` | Server persists ciphertext bytea + routing metadata only; client MLS integration pending. |
| SEC-11 | external-evidence | — | Encrypted backups, separate key, dual-authorisation restore — production ops. |
| SEC-12 | organisational | `docs/security/sdk-allowlist.json` | Per-category privacy-by-design rationale recorded in the DPIA. |
| SEC-13 | partial | — | Introduction consent ledgered with actor+timestamp; data-processing consent artefacts (purpose/scope/policy version) missing. |
| SEC-14 | implemented | `db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts` | DSAR assemble (GET /account/export) and erasure (DELETE /account) respond in seconds — far inside the 30-day/72-h SLAs; masking preserved in exports. |
| SEC-15 | organisational | — | Record of processing activities per Appendix B. |
| SEC-16 | phase-gated | — | Analytics pseudonymisation before leaving production — P1 pipeline. |
| SEC-17 | implemented | `db/migrations/0003_account_deletion.sql`<br>`db/migrations/0016_age_assurance.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/moderation.ts` | Privacy-preserving age assurance with no ID-document storage: self-declaration (FR-02 year-only) plus a moderation-triggered re-verification loop — underage/actioned resolution flags the account in the same txn, discovery closes with the neutral error, and re-verification requires an adult year consistent (±1) with the declaration on file. No passport/NIN/BVN/document storage exists anywhere in schema, edge or realm exports (pinned repo-wide). |
| SEC-18 | implemented | `docs/security/sdk-allowlist.json`<br>`scripts/check_sdk_allowlist.py`<br>`tests/test_sdk_allowlist.py` | Third-party SDK allowlist enforced in CI: docs/security/sdk-allowlist.json is the governed list (name/ecosystem/version constraint/justification/data-access/approver per entry) and scripts/check_sdk_allowlist.py is a fail-closed gate over every client dependency manifest (npm, pub, CocoaPods, Maven) — an unlisted SDK or a constraint violation fails the build. The sdk-allowlist CI job runs it on every PR and push; with no client/ tree yet the gate passes and holds any manifest to the list from its first commit. |
| SEC-19 | partial | `docs/api/openapi.yaml`<br>`services/edge/src/auth.ts` | Assertion header required on presence write; cryptographic verification + documented fallback pending. |
| SEC-20 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/budget.ts`<br>`services/edge/src/routes/consent.ts`<br>`services/edge/src/routes/presence.ts`<br>`services/edge/src/routes/scan.ts` | rl:scan:h 200/h (429) and rl:wave:d 20/day (429) Valkey counters; isImpossibleTravel rejects fixes implying >500 km/h with a 422. |
| SEC-21 | implemented | `db/migrations/0009_rooms.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/messages.ts`<br>`services/edge/src/routes/rooms.ts`<br>`services/edge/src/screening.ts` | screenText covers links, contact details and scam/bypass abuse patterns on first messages (enforced pre-storage in the messages route); room notes (FR-46) reuse the same module when rooms land (FR-44); tested. |
| SEC-22 | implemented | `services/edge/src/routes/scan.ts`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts`<br>`services/match/test/rotation.test.ts` | No list endpoints; results capped at 3; tie-break rotates per scan via edge-supplied seed (sha256(seed:userId)); unseeded legacy order retained only for tooling/tests. |
| SEC-23 | external-evidence | — | OWASP ASVS 4.0.3 L2 / MASVS 2.0 L1 assessment before launch. |
| SEC-24 | implemented | `services/match-core/README.md`<br>`tests/test_deploy_pipeline.py`<br>`tests/test_match_core.py` | Dependencies pinned (exact versions + lockfile), and every merge to main now produces an SBOM and SLSA mode=max provenance attestation per service image plus a keyless cosign signature over the immutable digest (deploy.yml) — signed provenance is a per-merge artefact, verified in the same job. |
| SEC-25 | implemented | — | .github/workflows/ci.yml dependencies job — license-checker with an allowlist (MIT/ISC/Apache-2.0/BSD/0BSD/CC0) over both services on every PR. |
| SEC-26 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/devices.ts`<br>`services/edge/src/moderation.ts`<br>`services/edge/src/routes/moderation.ts`<br>`services/edge/test/devices.test.ts` | .github/workflows/ci.yml (tests, npm audit, gitleaks) + codeql.yml (SAST for TS/Python) + dependabot.yml — all gated on every PR and push to main. |
| SEC-27 | organisational | — | Independent pen test before launch and annually. |
| SEC-28 | partial | `deploy/docker-compose.yml`<br>`deploy/k8s/README.md`<br>`deploy/keycloak/README.md`<br>`services/edge/src/recovery.ts` | Only clearly-marked dev secrets in compose; managed secret store arrives with K8s. |
| SEC-29 | implemented | `docs/runbook.md`<br>`services/edge/src/app.ts`<br>`services/edge/src/logscrub.ts`<br>`services/edge/test/logscrub.test.ts` | pino hooks.logMethod scrubber: coordinate/content/credential keys redacted, Bearer/apikey/JWT strings scrubbed, cell+user pairings redacted; 10 unit tests. |
| SEC-30 | partial | — | Append-only consent ledger exists; general security-event audit store + 12-month retention missing. |
| SEC-31 | organisational | — | Incident response plan, severity levels, on-call, 72-h regulator path, twice-yearly rehearsal. |
| SEC-32 | organisational | — | Law-enforcement request procedure + annual transparency report. |
| SEC-33 | implemented | `db/migrations/0007_group_surface.sql`<br>`db/migrations/0010_devices.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/groups.ts`<br>`services/edge/src/routes/tables.ts` | group_table_member_cap() trigger locks the table row FOR UPDATE and rejects the seventh member; slot_bookings PK caps one booking per slot; rooms (FR-44) inherit the same pattern when built. |
| SEC-34 | partial | `db/migrations/0007_group_surface.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/links.ts`<br>`services/edge/src/routes/links.ts`<br>`services/edge/test/links.test.ts` | Code-owned domain allowlist + https-only/credential-free/length-bound validation (links.ts, unit-tested), https CHECK at the data layer, plain-text responses carrying interstitial:true, and a no-fetch guarantee pinned by test_group_surface. Gap: rendering the warning sheet is client work, pending with the RN client. |
| SEC-35 | client | — | Contentless ambient surfaces — client enforcement. |
| SEC-36 | partial | — | Mock-location refusal is client-side; the server-side refusal record endpoint is missing. |
| SEC-37 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/announcements.ts`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/src/routes/profile.ts` | screenText gates both announcement publish and respond routes; findings return category-coded 422, never the matched text. |
| SEC-38 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/announcements.ts`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/test/announcements.test.ts` | Responses endpoint is publisher-only (403), LIMIT 5, and masks responder identity until acceptance (publicResponse). |

## INF — Infrastructure requirements (§8)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| INF-01 | external-evidence | `deploy/k8s/prometheusrules.yaml`<br>`docs/runbook.md` | Single primary region + same-jurisdiction warm standby — production topology. |
| INF-02 | partial | `deploy/k8s/README.md` | Local compose exists; integration/staging/production environments not provisioned. |
| INF-03 | partial | — | Synthetic distributional data generator exists (eval harness); environment separation pending INF-02. |
| INF-04 | implemented | `deploy/k8s/README.md` | Compose + migrations + ADRs + full K8s manifests (deploy/k8s: workloads, gateway, HPA, NetworkPolicy, canary) are code; scripts/validate_deploy.py asserts the invariants. |
| INF-05 | external-evidence | `deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml` | API/match sizing 3x 2 vCPU/4 GB — production. |
| INF-06 | external-evidence | `deploy/k8s/README.md`<br>`deploy/k8s/valkey.yaml` | Valkey 1 primary + 1 replica, 4 GB — production. |
| INF-07 | external-evidence | `deploy/k8s/README.md`<br>`deploy/k8s/postgres.yaml` | Postgres 4 vCPU/16 GB, 500 GB SSD, PITR — production. |
| INF-08 | external-evidence | — | Centrifugo 2 nodes x 2 vCPU — production. |
| INF-09 | superseded | — | ClickHouse superseded by the OpenSearch-only decision (ADR-0006 / TECH-21). |
| INF-10 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/canary.yaml`<br>`deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml` | autoscaling/v2 HPAs on edge + match: external p95 metric (120 ms target, 3-min window) with CPU fallback; scaleDown capped at 1 pod per 600 s; asserted by scripts/validate_deploy.py. |
| INF-11 | partial | `deploy/apisix/apisix.yaml`<br>`deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`scripts/validate_deploy.py` | TLS termination, HSTS and CSP configured at APISIX (validated); OCSP stapling is delegated to the cert-manager issuance chain and needs production evidence. |
| INF-12 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml`<br>`deploy/k8s/namespace.yaml` | K8s: only APISIX reaches edge, only edge reaches match, everything else ClusterIP/headless; default-deny-all NetworkPolicy; asserted by scripts/validate_deploy.py. |
| INF-13 | external-evidence | — | Edge DDoS mitigation + pre-launch test. |
| INF-14 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/namespace.yaml`<br>`deploy/k8s/networkpolicy.yaml`<br>`scripts/validate_deploy.py` | Default-deny egress + per-workload egress allowlists (DNS only otherwise) in deploy/k8s/networkpolicy.yaml; asserted by scripts/validate_deploy.py. |
| INF-15 | implemented | `tests/test_deploy_pipeline.py` | Merge -> signed reproducible artefact -> auto-deploy: .github/workflows/deploy.yml builds edge+match on every merge to main with commit-timestamp SOURCE_DATE_EPOCH and digest addressing (reproducible), attaches buildx SBOM + mode=max provenance, signs the immutable digest keyless with cosign over the GitHub OIDC identity and self-verifies the signature, then the deploy-integration job kustomize-pins the signed digests and rolls out. Auto-deploy is gated on the integration environment variable so the artefact half runs on every merge until the cluster is wired. |
| INF-16 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/canary.yaml`<br>`scripts/validate_deploy.py` | Flagger Canary resources on the APISIX provider: 5% steps held 10 min, auto-rollback on success-rate/p95-latency breach (deploy/k8s/canary.yaml); asserted by scripts/validate_deploy.py. Requires Flagger + Prometheus in-cluster. |
| INF-17 | partial | — | Forward-only migrations practised; rehearsal against a production-sized snapshot pending. |
| INF-18 | external-evidence | — | PITR 5-min granularity, 35-day retention, quarterly timed restore. |
| INF-19 | external-evidence | — | <=EUR1 500/mo at 100k MAU — Kubecost (P1) + monthly review. |
| INF-20 | organisational | — | On-call staffing, escalation ladder, 30-min Sev-1 acknowledgement. |

## TECH — Technology requirements (§9)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| TECH-01 | client | — | React Native + Expo custom dev client; Expo Go prohibited (BLE). |
| TECH-02 | implemented | — | h3-js 4.x in both TS services; the client uses the same library family so cell ids agree bit-for-bit. |
| TECH-03 | implemented | `deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml` | Dockerfiles on node:22-alpine, engines >=22, @types/node 22.10.2; TypeScript strict, pinned toolchain; tests green. |
| TECH-04 | partial | `db/migrations/0014_markets.sql`<br>`deploy/k8s/postgres.yaml` | Postgres 17 + PostGIS deployed; h3-pg extension not yet added. |
| TECH-05 | implemented | `deploy/k8s/valkey.yaml` | Valkey 8 (BSD-3); no Redis anywhere. |
| TECH-06 | partial | `deploy/k8s/centrifugo.yaml` | Centrifugo deployed; Valkey-as-broker not yet configured (in-memory engine in dev compose). |
| TECH-07 | partial | `deploy/docker-compose.yml`<br>`deploy/k8s/README.md`<br>`deploy/k8s/keycloak.yaml`<br>`deploy/keycloak/README.md`<br>`services/edge/src/app.ts` | Three realm imports (consumer passkey policy / workforce hardware 2FA / partners roles) boot in compose; edge verifies RS256 via realm JWKS; passkey-only browser flow + SMS recovery config pending. |
| TECH-08 | client | `services/edge/src/screening.ts` | OpenMLS/vodozemac client crypto; libsignal prohibited (AGPL-3.0 vs closed client). |
| TECH-09 | implemented | `db/migrations/0011_linking.sql`<br>`db/migrations/0012_taxonomy_cms.sql`<br>`db/seed/taxonomy_embeddings.sql`<br>`deploy/docker-compose.yml`<br>`deploy/k8s/postgres.yaml` | pgvector lives only in the linking stack: extension + taxonomy_node_embeddings vector(384) with HNSW cosine index (migration 0011), link_taxonomy_nodes() excludes sensitive/redirected nodes, app role is SELECT-only; the deterministic ngram-hash-384.v1 embedder is implemented bit-identically in Python (seed generation) and TypeScript (query time), pinned against shared golden vectors. The never-in-match-path boundary is test-pinned: match service, scan route and presence model reference nothing from the linking stack. Deploy postgres image builds pgvector v0.8.0 (deploy/postgres/Dockerfile); migration + seed mounted in compose and k8s. |
| TECH-10 | superseded | — | ClickHouse superseded by OpenSearch (ADR-0006 / TECH-21); aggregated events only. |
| TECH-11 | partial | — | Fastify structured logs; OpenTelemetry traces + Grafana stack not wired (AGPL internal-only constraint noted). |
| TECH-12 | partial | — | Health endpoints + structured logs done; OpenTelemetry traces missing. |
| TECH-13 | implemented | — | Golden-file suite (120 pairs) fails on any score change; 81-test Python regression suite. |
| TECH-14 | implemented | `docs/api/openapi.yaml`<br>`tests/test_openapi_contract.py` | tests/test_openapi_contract.py generates assertions from openapi.yaml: strict-body structural + behavioural checks, doc<->route coverage both ways, TR-24 header docs, schema well-formedness. |
| TECH-15 | partial | — | Python engine is pure/deterministic; TS services read the wall clock directly — clock/id injection not formalised. |
| TECH-16 | client | — | Dependency maintenance/licence/size budget; 45 MB bundle cap. |
| TECH-17 | organisational | — | Team skills: TypeScript, React Native, Postgres, one systems language. |
| TECH-18 | partial | `deploy/k8s/match.yaml`<br>`services/match-core/README.md`<br>`tests/test_match_core.py` | Rust match core delivered (services/match-core): the full engine — graph validation, TR-04 closure, TR-06 idf, TR-36 prior, scoring, TR-08/09 reasons, icebreaker — pinned to 1e-9 against the shared 120-pair golden corpus alongside the TS engine and Python reference, bit-deterministic by sorted-order accumulation, committed Cargo.lock, cargo test wired into CI. The Go presence/venue/consent services remain outstanding; TS stays the documented P0 serving stand-in. |
| TECH-19 | implemented | — | Kafka designated event backbone (ADR-0004); no Fluvio deployed; Kafka rollout itself is ARC P1. |
| TECH-20 | implemented | — | No Temporal calls on the scan path (none exist anywhere); Temporal rollout is ARC P1. |
| TECH-21 | implemented | `deploy/docker-compose.yml`<br>`deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/canary.yaml`<br>`deploy/k8s/networkpolicy.yaml` | No ClickHouse / second warehouse; APISIX is the sole public ingress — the only LoadBalancer Service, enforced by NetworkPolicy (validated); OpenSearch is P1. |
| TECH-22 | phase-gated | — | Delta-on-Parquet bronze/silver/gold — P1 lakehouse; no analytics on the live match path (satisfied). |
| TECH-23 | implemented | — | No Mojaloop/TigerBeetle deployed; ARC-002 §9 gates them at P3. |
| TECH-24 | partial | — | Canonical geometry in PostGIS (venues.geofence); GeoLibre authoring/QA workflow not built (TR-41). |

## ACC — Acceptance and verification (§10)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| ACC-01 | external-evidence | — | This generated matrix + the test suites are the verification instrument; final gate at pilot. |
| ACC-02 | organisational | — | Independent pen test with critical/high remediation + retest. |
| ACC-03 | organisational | — | DPIA signed by DPO + accountable executive. |
| ACC-04 | external-evidence | — | Load + soak profile on production-equivalent infrastructure. |
| ACC-05 | organisational | — | Incident response rehearsed; on-call staffed; runbooks published. |
| ACC-06 | external-evidence | — | Rollback drill: production release reverted <=10 min. |
| ACC-07 | organisational | — | Three anchor venues contracted + dashboards verified. |
| ACC-08 | external-evidence | — | Store review acceptance on both platforms — needs the client. |
| ACC-09 | external-evidence | — | 10-user first-time usability test (>=8 describe the product correctly) — needs the client. |
| ACC-10 | partial | `presence/eval_harness.py`<br>`presence/eval_score.py`<br>`scripts/export_golden.py`<br>`services/match-core/README.md`<br>`services/match/src/engine.ts` | Eval pipeline complete (653-pair key, rating pack, scoring; self-test alpha 0.832, p@3 0.389); the real >=3-independent-rater study is outstanding. |
