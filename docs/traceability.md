# Traceability matrix — PRS-SRS-001 v1.0 / PRS-ARC-002

GENERATED ARTEFACT — do not hand-edit. Regenerate with `python3 scripts/build_traceability.py` (SRS §10: the matrix is generated, not hand-maintained).

Total requirements: **306** (283 MUST · 22 SHOULD · 1 MAY per Appendix A).

## Status summary

| Status | Count | Meaning |
|---|---|---|
| implemented | 94 | working in the repo with tests or structural evidence |
| partial | 51 | meaningful part implemented; named gap remains |
| gap-p0 | 52 | ARC-P0 product scope, code not yet built |
| phase-gated | 8 | ARC P1+ component; correctly deferred per TR-40 / ARC-002 §9 |
| client | 36 | requires the React Native client workstream |
| organisational | 34 | legal / process / staffing — not expressible as code |
| external-evidence | 29 | needs production infrastructure or third-party evidence |
| superseded | 2 | superseded by a recorded ADR |

## Per-family breakdown

| Family | implemented | partial | gap-p0 | phase-gated | client | organisational | external-evidence | superseded | total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| BR | 6 | 4 | 1 | 0 | 0 | 22 | 0 | 0 | 33 |
| FR | 37 | 15 | 31 | 1 | 15 | 1 | 0 | 0 | 100 |
| NFR | 4 | 5 | 3 | 1 | 11 | 0 | 13 | 0 | 37 |
| TR | 23 | 5 | 6 | 4 | 6 | 0 | 0 | 0 | 44 |
| SEC | 10 | 10 | 8 | 1 | 1 | 5 | 3 | 0 | 38 |
| INF | 5 | 4 | 1 | 0 | 0 | 1 | 8 | 1 | 20 |
| TECH | 9 | 7 | 2 | 1 | 3 | 1 | 0 | 1 | 24 |
| ACC | 0 | 1 | 0 | 0 | 0 | 4 | 5 | 0 | 10 |

## BR — Business requirements (§3)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| BR-01 | organisational | — | Single-metro launch with >=3 venues in 2 km — launch-ops gate (ACC-07), not code. |
| BR-02 | organisational | — | Positioning (friendship, not dating) — store copy / onboarding / marketing review; no dating surface exists in code. |
| BR-03 | gap-p0 | — | Age declaration at onboarding, under-18 block, re-verification on escalation — no onboarding flow or age fields yet. |
| BR-04 | organisational | — | Second-city expansion gate on anchor-venue metrics (§2.5 for 3 consecutive weeks). |
| BR-05 | partial | `deploy/keycloak/realm-partners.json` | events table models venue+window; event-scoped instance mode and presence-to-event attribution not wired. |
| BR-06 | organisational | `docs/adr/0007-payments-gated-on-br06.md` | Five sequenced revenue lines only; payments gated per docs/adr/0007. |
| BR-07 | partial | `docs/api/openapi.yaml`<br>`services/edge/src/context.ts` | Reports endpoint exists and is ungated; two-tap reachability is client UX (not built); no monetisation gate exists. |
| BR-08 | implemented | — | Structural: no endpoint exposes precise location, pre-OPEN identity, or unconsented data; no paid tier exists to violate it. |
| BR-09 | organisational | — | Per-market local-currency pricing via store billing — monetisation phase. |
| BR-10 | organisational | — | Pilot unit-economics targets (CAC <= EUR6, payback <=4 mo, conversion >=3%). |
| BR-11 | organisational | — | Venue agreement: data-processing roles, signage, escalation, 30-day termination. |
| BR-12 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`deploy/keycloak/realm-partners.json`<br>`docs/api/openapi.yaml`<br>`services/edge/src/aggregate.ts`<br>`services/edge/src/routes/checkin.ts` | GET /v1/venues/:venueId/dashboard serves live presence, hourly scans, active offers and live announcements to venue_ids-claim tokens; match-funnel attribution arrives with FR-43. |
| BR-13 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/aggregate.ts`<br>`services/edge/src/routes/venue.ts`<br>`services/edge/test/aggregate.test.ts` | kSuppressed (aggregate.ts, k=11) withholds every dashboard figure below k; routes/venue.ts applies it to all metrics. |
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
| FR-02 | implemented | `db/migrations/0003_account_deletion.sql`<br>`deploy/keycloak/README.md`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/presence.ts` | POST /account/age-declaration upserts a birth-year declaration; under-18 sets age_blocked; presence+scan refuse with a neutral 403 (no reason disclosed); boundary fails toward blocking; tested. |
| FR-03 | partial | `db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts` | DELETE /v1/account erases in one authenticated call; the <=3-tap journey is client UX, pending with the RN client. |
| FR-04 | implemented | `db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/presence.ts`<br>`services/edge/src/routes/scan.ts` | delete_account purges envelopes/pairs/blocks/profile/identity synchronously and tombstones the user; the edge strips Valkey presence+suppress+block keys in the same call; ledger actors anonymised after the 90-day hold by lifecycle_tick. |
| FR-05 | gap-p0 | — | <=3 concurrent devices + enrolment notification — device registry arrives with Keycloak device-bound tokens. |
| FR-06 | partial | — | user_identities carries handle + photo gated to OPEN by RLS; display-name default and 140-char bio missing. |
| FR-07 | gap-p0 | — | Duplicate-account detection on attestation key — needs real App Attest / Play Integrity verification. |
| FR-08 | gap-p0 | — | 3-20 interests, searchable <=3-level picker — profile write API missing; picker is client work. |
| FR-09 | gap-p0 | — | Free-text entity linking with per-node confirmation — pgvector linking service (TECH-09) not built. |
| FR-10 | implemented | `presence/matching.py`<br>`services/match/src/engine.ts`<br>`tests/test_matching.py` | Sensitive nodes excluded from vectors, reasons, idf and bonus at build time; covered by engine tests. |
| FR-11 | partial | `presence/matching.py`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts`<br>`services/match/src/store.ts` | Candidates need >=2 interests to be scored; publish-side >=3 enforcement + client explanation missing. |
| FR-12 | implemented | — | Profile and corpus caches refresh on a 60 s loop (TR-05). |
| FR-13 | gap-p0 | — | k-suppressed local popularity per interest — no endpoint. |
| FR-14 | implemented | `docs/api/openapi.yaml`<br>`docs/presence-model.md`<br>`services/edge/src/routes/presence.ts`<br>`services/match/src/store.ts` | 900 s Valkey TTL; stale cell members filtered at read; tested. |
| FR-15 | partial | `services/edge/src/context.ts` | Server rejects coordinate-shaped fields with 422 (TR-15); on-device cell computation is client work. |
| FR-16 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/context.ts`<br>`services/edge/src/routes/account.ts`<br>`services/edge/src/routes/presence.ts`<br>`services/edge/src/routes/scan.ts` | newPresenceSessionId (128-bit hex) on session start, kept on heartbeats, reuse rejected 409; presence:session reverse index; scan results carry sessionId+pairId — account ids never leave the edge pre-OPEN. |
| FR-17 | gap-p0 | — | Time-boxed intent vocabulary expiring with presence or 60 min, usable as match signal. |
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
| FR-28 | gap-p0 | — | Density-scaled match budget (3/hr sparse to 1/day crowd) not implemented. |
| FR-29 | implemented | `db/migrations/0001_init.sql`<br>`db/migrations/0002_offer_lifecycle.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/consent.ts`<br>`services/edge/src/routes/scan.ts` | DETECTED>NUDGED>EXPRESSED>MUTUAL>OPEN enforced by DB trigger; DETECTED recorded on first surfacing; tested. |
| FR-30 | implemented | `db/migrations/0001_init.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/auth.ts`<br>`services/edge/src/routes/consent.ts`<br>`services/edge/src/routes/messages.ts` | Identity RLS-gated to OPEN; verified by policy + edge tests. |
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
| FR-41 | gap-p0 | — | Local delete + 24-h own-message revocation not implemented. |
| FR-42 | partial | `deploy/keycloak/realm-workforce.json` | venues carries geofence (PostGIS), h3_res, thresholds, active; partner status + operating schedule missing. |
| FR-43 | partial | `deploy/keycloak/realm-partners.json`<br>`services/edge/src/routes/venue.ts` | events = venue + window in schema; presence-to-event attribution not wired. |
| FR-44 | gap-p0 | `services/edge/src/screening.ts` | Crowd-mode transition to interest rooms — room surface not built. |
| FR-45 | gap-p0 | — | Interest-room content rules (topic, suppressed count, opted-in notes) — with FR-44. |
| FR-46 | gap-p0 | `services/edge/src/screening.ts` | Room posting 1 note/5 min + first-message content filters — with FR-44/SEC-21. |
| FR-47 | implemented | — | Resolution ladder 9>10 (2 000) >11 (10 000) on live venue density; tested. |
| FR-48 | partial | — | Venue check-in codes live via FR-99/FR-100 signed per-floor tokens; venue-side code printing/distribution ops remain with the client workstream. |
| FR-49 | partial | `docs/api/openapi.yaml` | reports accepts free-text reason; the fixed category enum is missing. |
| FR-50 | organisational | — | 24/7 4-h high-severity triage — staffing/rota (BR-16) plus the moderation console (FR-54). |
| FR-51 | partial | `docs/api/openapi.yaml`<br>`services/edge/src/auth.ts` | Attestation assertion header required on presence write; cryptographic verification + discovery gating pending. |
| FR-52 | gap-p0 | — | Per-account trust score (verification, report outcomes, account age) not implemented. |
| FR-53 | gap-p0 | — | Silent investigation removal + appeal path not implemented. |
| FR-54 | gap-p0 | `deploy/keycloak/realm-workforce.json` | Moderation console (reason path, ledger, sessions, history; never message content) not built. |
| FR-55 | gap-p0 | — | Independent suspension of attestation key / handle / payment instrument not implemented. |
| FR-56 | partial | — | Realtime events carry only a type on an opaque pair channel; APNs/FCM push pipeline not built. |
| FR-57 | gap-p0 | — | Nudge cap 3/day + user quiet window not implemented (no nudge sender). |
| FR-58 | gap-p0 | — | Per-category notification switches (safety notices exempt) not implemented. |
| FR-59 | gap-p0 | `deploy/keycloak/realm-workforce.json` | Taxonomy CMS draft/review/publish + one-action rollback not built (seed export scripts only). |
| FR-60 | gap-p0 | — | Immutable admin audit log (actor, reason code, before/after) not implemented. |
| FR-61 | phase-gated | — | Analytics pipeline is P1 lakehouse (Delta/Parquet) per ARC-002 §9; identifier exclusion + cell aggregation specified there. |
| FR-62 | implemented | `db/migrations/0003_account_deletion.sql`<br>`db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts` | GET /account/export assembles the full subject record (profile, interests, pairs, ledger actions, blocks, reports) via dsar_export() with FR-32/34 masking intact; erasure via DELETE /account. |
| FR-63 | gap-p0 | — | Per-venue feature flags for §4.4/4.5/4.7 behaviours not implemented. |
| FR-64 | gap-p0 | — | Structured prompts (<=3 x 120 chars, screened, reason material, not searchable) not implemented. |
| FR-65 | gap-p0 | — | Post-OPEN allowlisted social link, counterpart-only, never fetched server-side — not implemented. |
| FR-66 | gap-p0 | — | Group tables <=6, member-only visibility — not implemented. |
| FR-67 | gap-p0 | — | Table conversation cards from shared reasons, labelled generated — not implemented. |
| FR-68 | gap-p0 | — | Bookable 1:1 slots where booking is the consent act — not implemented. |
| FR-69 | gap-p0 | — | Host designation, name+role display, scoped visibility — not implemented. |
| FR-70 | client | — | Verification status at identity reveal — client rendering (+ data from FR-51/52). |
| FR-71 | gap-p0 | — | Recurrence signal (hashed pair, day counter, <=1/day, no timestamps) — optional MAY, not implemented. |
| FR-72 | gap-p0 | — | Table boundary acceptance criteria — with FR-66. |
| FR-73 | gap-p0 | — | Booked-slot acceptance criteria — with FR-68. |
| FR-74 | gap-p0 | — | Host accountability + visibility limits — with FR-69. |
| FR-75 | gap-p0 | — | Group enumeration restrictions — with FR-66/68. |
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
| FR-98 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/src/routes/content.ts` | reports.announcement_id + maybe_remove_announcement (2 reports/10 min, removed_at retained); publisher notified via Centrifugo; reads filter removed rows. |
| FR-99 | implemented | `db/migrations/0005_floors_checkin.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/floors.ts`<br>`services/edge/src/routes/checkin.ts`<br>`services/edge/src/routes/presence.ts` | venue_floors (0005) with per-floor polygons + connected_to; presence floorId attribution validated against declarations; same-venue scans floor-scoped via floorsCompatible. |
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
| NFR-31 | partial | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`scripts/validate_deploy.py` | Fastify request ids per service; APISIX request-id plugin generates and echoes X-Request-Id at the gateway; edge->match propagation of the id still missing. |
| NFR-32 | gap-p0 | — | Four §2.5 product metrics computable from telemetry <=5 min — telemetry pipeline (TR-34). |
| NFR-33 | gap-p0 | — | Alert set: SLO burn, error spike, presence-publish failure, match-rate collapse, moderation queue age. |
| NFR-34 | gap-p0 | — | Runbook per alert, each alert naming an owner. |
| NFR-35 | client | — | 60 fps match surface (>=30 fps floor on weakest supported device). |
| NFR-36 | client | — | Ambient refresh <=1/min, no idle radio wake. |
| NFR-37 | client | — | Primary action reachable one-handed in the lower 40% of the display. |

## TR — Technical requirements (§6)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| TR-01 | implemented | — | Edge + match are stateless; all state lives in Valkey/Postgres. |
| TR-02 | partial | — | Scan reads Valkey + warmed caches; a cold profile cache miss still hits Postgres inline — bulk warming or async load outstanding. |
| TR-03 | partial | — | K8s NetworkPolicies isolate east-west traffic (only declared flows allowed); mTLS between services awaits the mesh decision. |
| TR-04 | implemented | `db/migrations/0001_init.sql`<br>`db/seed/taxonomy.sql`<br>`presence/graph.py`<br>`presence/matching.py`<br>`scripts/export_taxonomy_sql.py` | 0.55/hop, depth <=4, max-combine — pinned against the answer key (653/653). |
| TR-05 | implemented | `docs/presence-model.md`<br>`presence/graph.py`<br>`presence/matching.py`<br>`scripts/export_golden.py`<br>`services/match/src/engine.ts` | df over live presence, link-free closures, 60 s refresh loop. |
| TR-06 | implemented | `presence/matching.py`<br>`services/match/src/engine.ts`<br>`tests/test_matching.py` | sqrt(ln(1+N/(1+df))) with cap — pinned. |
| TR-07 | implemented | `db/migrations/0001_init.sql`<br>`db/seed/taxonomy.sql`<br>`presence/graph.py`<br>`presence/matching.py`<br>`scripts/export_taxonomy_sql.py` | Links contribute one hop at authored weight <=0.5, excluded from df — pinned. |
| TR-08 | implemented | `docs/api/openapi.yaml`<br>`presence/matching.py`<br>`services/match/src/engine.ts`<br>`services/match/test/engine.test.ts`<br>`tests/test_matching.py` | Ordered reasons with node ids, labels, contributions in every response. |
| TR-09 | implemented | `db/migrations/0001_init.sql`<br>`presence/matching.py`<br>`scripts/export_golden.py`<br>`services/edge/src/screening.ts`<br>`services/match/src/engine.ts` | Deterministic template rendering; no LLM anywhere in reason generation. |
| TR-10 | implemented | `presence/matching.py`<br>`services/match/src/engine.ts`<br>`services/match/test/engine.test.ts`<br>`tests/test_matching.py` | 81 Python tests incl. 60 key-pinned pairs; 120-pair TS golden parity at 1e-9. |
| TR-11 | implemented | `db/migrations/0001_init.sql`<br>`services/edge/src/routes/scan.ts`<br>`services/match/src/scan.ts`<br>`services/match/test/scan.test.ts` | venues.base_threshold / max_scan_results configurable per venue row without deployment. |
| TR-12 | implemented | `db/migrations/0001_init.sql`<br>`docs/api/openapi.yaml`<br>`docs/presence-model.md`<br>`services/edge/src/routes/presence.ts`<br>`services/edge/src/velocity.ts` | H3 res 9 default; k=1 ring; tested. |
| TR-13 | implemented | `docs/api/openapi.yaml` | Responses carry bands only — no neighbour cell or ring distance. |
| TR-14 | implemented | `docs/presence-model.md`<br>`services/edge/src/routes/presence.ts` | Descent at 2 000 / 10 000 live presences; tested. |
| TR-15 | implemented | `docs/adr/0008-maplibre-geolibre-postgis.md`<br>`docs/api/openapi.yaml`<br>`docs/presence-model.md`<br>`services/edge/src/auth.ts`<br>`services/edge/src/routes/presence.ts` | Coordinate-shaped payload fields hard-422; tested. |
| TR-16 | gap-p0 | — | h3-pg native column type (TECH-04) — cells are Valkey strings today; no H3 column in Postgres. |
| TR-17 | implemented | `db/migrations/0001_init.sql`<br>`presence/graph.py`<br>`services/match/src/engine.ts`<br>`tests/test_matching.py` | Graph enforces an acyclic hierarchy <=5 levels + typed non-hierarchical edges. |
| TR-18 | implemented | `db/migrations/0001_init.sql`<br>`db/seed/taxonomy.sql`<br>`presence/graph.py`<br>`scripts/export_taxonomy_sql.py`<br>`services/match/src/engine.ts` | taxonomy_closure materialised, rebuilt by the seed/export pipeline. |
| TR-19 | partial | `presence/graph.py` | redirect_to column + Python graph support exist; the TS engine does not resolve redirects yet. |
| TR-20 | gap-p0 | — | Monotonic version + provenance + diff summary per taxonomy release — no release tooling. |
| TR-21 | gap-p0 | — | 250k-node closure <10 min — scale test not run (current seed is a small synthetic graph). |
| TR-22 | implemented | `db/migrations/0001_init.sql`<br>`presence/matching.py`<br>`services/match/src/engine.ts`<br>`tests/test_matching.py` | Sensitive nodes skipped at vector construction (write time), not query time. |
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
| TR-34 | gap-p0 | — | Stable metric keys + versioned CSV telemetry export contract — not implemented. |
| TR-35 | partial | — | Reason payload is render-complete (TR-08); the versioned diagram spec is a client artifact. |
| TR-36 | implemented | `presence/matching.py`<br>`services/match/src/engine.ts`<br>`services/match/src/store.ts`<br>`services/match/test/prior.test.ts`<br>`tests/test_idf_prior.py` | Optional global prior (all-profile link-free df, 10-min rebuild) blended with fade w(N)=(30-N)/30 — 0% shift at N>=30, exact-formula tests in TS+Python. |
| TR-37 | gap-p0 | — | Per-market resolution calibration held in configuration — the ladder is code constants today (SHOULD). |
| TR-38 | phase-gated | — | Polygon attribution as a lakehouse spatial join published to the operational store (P1 lakehouse). |
| TR-39 | phase-gated | — | Gold-table owner/grain/SLO/retention + catalogue registration (P1 lakehouse). |
| TR-40 | implemented | — | Phase-gate admission documented; 8 ADRs recorded (Valkey, Keycloak, Kafka, Dapr, OpenSearch, payments, GeoLibre, sequencing). |
| TR-41 | gap-p0 | — | GeoLibre authoring + second-person review + density verification workflow — not built. |
| TR-42 | implemented | `db/migrations/0005_floors_checkin.sql`<br>`services/edge/src/floors.ts`<br>`services/edge/src/routes/scan.ts`<br>`services/edge/test/floors.test.ts` | venue_floors.venue_id/floor_id + geography(Polygon,4326) geofence + connected_to on the venue geometry records (0005, PostGIS canonical). |
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
| SEC-06 | gap-p0 | `deploy/k8s/README.md` | TLS 1.3 everywhere at APISIX (P0); dev compose is plaintext. |
| SEC-07 | external-evidence | `deploy/k8s/README.md` | AES-256-GCM at rest + KMS + annual rotation — production-infra evidence. |
| SEC-08 | implemented | — | No coordinate columns anywhere; server rejects coordinate fields; H3 cells only. |
| SEC-09 | gap-p0 | `deploy/keycloak/README.md` | Phone recovery stored as keyed hash only — lands with Keycloak SMS recovery config. |
| SEC-10 | implemented | `services/edge/src/screening.ts`<br>`services/edge/test/screening.test.ts` | Server persists ciphertext bytea + routing metadata only; client MLS integration pending. |
| SEC-11 | external-evidence | — | Encrypted backups, separate key, dual-authorisation restore — production ops. |
| SEC-12 | organisational | — | Per-category privacy-by-design rationale recorded in the DPIA. |
| SEC-13 | partial | — | Introduction consent ledgered with actor+timestamp; data-processing consent artefacts (purpose/scope/policy version) missing. |
| SEC-14 | implemented | `db/migrations/0003_account_deletion.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/routes/account.ts` | DSAR assemble (GET /account/export) and erasure (DELETE /account) respond in seconds — far inside the 30-day/72-h SLAs; masking preserved in exports. |
| SEC-15 | organisational | — | Record of processing activities per Appendix B. |
| SEC-16 | phase-gated | — | Analytics pseudonymisation before leaving production — P1 pipeline. |
| SEC-17 | gap-p0 | `db/migrations/0003_account_deletion.sql` | Privacy-preserving age assurance without ID-document storage — method selection pending (BR-03/FR-02). |
| SEC-18 | gap-p0 | — | Third-party SDK allowlist enforced in CI — CI not built; client pending. |
| SEC-19 | partial | `docs/api/openapi.yaml`<br>`services/edge/src/auth.ts` | Assertion header required on presence write; cryptographic verification + documented fallback pending. |
| SEC-20 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/consent.ts`<br>`services/edge/src/routes/presence.ts`<br>`services/edge/src/routes/scan.ts`<br>`services/edge/src/velocity.ts` | rl:scan:h 200/h (429) and rl:wave:d 20/day (429) Valkey counters; isImpossibleTravel rejects fixes implying >500 km/h with a 422. |
| SEC-21 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/routes/messages.ts`<br>`services/edge/src/screening.ts`<br>`services/edge/test/screening.test.ts` | screenText covers links, contact details and scam/bypass abuse patterns on first messages (enforced pre-storage in the messages route); room notes (FR-46) reuse the same module when rooms land (FR-44); tested. |
| SEC-22 | implemented | `services/edge/src/routes/scan.ts`<br>`services/match/src/scan.ts`<br>`services/match/src/server.ts`<br>`services/match/test/rotation.test.ts` | No list endpoints; results capped at 3; tie-break rotates per scan via edge-supplied seed (sha256(seed:userId)); unseeded legacy order retained only for tooling/tests. |
| SEC-23 | external-evidence | — | OWASP ASVS 4.0.3 L2 / MASVS 2.0 L1 assessment before launch. |
| SEC-24 | partial | — | Dependencies pinned (exact versions + lockfile); SBOM + signed provenance per release not yet produced. |
| SEC-25 | gap-p0 | — | Dependency licence policy check in CI. |
| SEC-26 | gap-p0 | — | SAST + dependency + secret scanning on every PR — CI not built. |
| SEC-27 | organisational | — | Independent pen test before launch and annually. |
| SEC-28 | partial | `deploy/k8s/README.md`<br>`deploy/keycloak/README.md` | Only clearly-marked dev secrets in compose; managed secret store arrives with K8s. |
| SEC-29 | implemented | `services/edge/src/app.ts`<br>`services/edge/src/logscrub.ts`<br>`services/edge/test/logscrub.test.ts` | pino hooks.logMethod scrubber: coordinate/content/credential keys redacted, Bearer/apikey/JWT strings scrubbed, cell+user pairings redacted; 10 unit tests. |
| SEC-30 | partial | — | Append-only consent ledger exists; general security-event audit store + 12-month retention missing. |
| SEC-31 | organisational | — | Incident response plan, severity levels, on-call, 72-h regulator path, twice-yearly rehearsal. |
| SEC-32 | organisational | — | Law-enforcement request procedure + annual transparency report. |
| SEC-33 | gap-p0 | — | Group-surface participant caps enforced in the data layer — with rooms/tables (FR-44/66). |
| SEC-34 | gap-p0 | — | External links plain-text + interstitial + allowlist, no server fetch — with FR-65. |
| SEC-35 | client | — | Contentless ambient surfaces — client enforcement. |
| SEC-36 | partial | — | Mock-location refusal is client-side; the server-side refusal record endpoint is missing. |
| SEC-37 | implemented | `docs/api/openapi.yaml`<br>`services/edge/src/announcements.ts`<br>`services/edge/src/routes/announcements.ts` | screenText gates both announcement publish and respond routes; findings return category-coded 422, never the matched text. |
| SEC-38 | implemented | `db/migrations/0004_discovery_safety.sql`<br>`docs/api/openapi.yaml`<br>`services/edge/src/announcements.ts`<br>`services/edge/src/routes/announcements.ts`<br>`services/edge/test/announcements.test.ts` | Responses endpoint is publisher-only (403), LIMIT 5, and masks responder identity until acceptance (publicResponse). |

## INF — Infrastructure requirements (§8)

| ID | Status | Evidence | Basis |
|---|---|---|---|
| INF-01 | external-evidence | — | Single primary region + same-jurisdiction warm standby — production topology. |
| INF-02 | partial | `deploy/k8s/README.md` | Local compose exists; integration/staging/production environments not provisioned. |
| INF-03 | partial | — | Synthetic distributional data generator exists (eval harness); environment separation pending INF-02. |
| INF-04 | implemented | `deploy/k8s/README.md` | Compose + migrations + ADRs + full K8s manifests (deploy/k8s: workloads, gateway, HPA, NetworkPolicy, canary) are code; scripts/validate_deploy.py asserts the invariants. |
| INF-05 | external-evidence | `deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml` | API/match sizing 3x 2 vCPU/4 GB — production. |
| INF-06 | external-evidence | `deploy/k8s/README.md`<br>`deploy/k8s/valkey.yaml` | Valkey 1 primary + 1 replica, 4 GB — production. |
| INF-07 | external-evidence | `deploy/k8s/README.md`<br>`deploy/k8s/postgres.yaml` | Postgres 4 vCPU/16 GB, 500 GB SSD, PITR — production. |
| INF-08 | external-evidence | — | Centrifugo 2 nodes x 2 vCPU — production. |
| INF-09 | superseded | — | ClickHouse superseded by the OpenSearch-only decision (ADR-0006 / TECH-21). |
| INF-10 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/canary.yaml`<br>`deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml` | autoscaling/v2 HPAs on edge + match: external p95 metric (120 ms target, 3-min window) with CPU fallback; scaleDown capped at 1 pod per 600 s; asserted by scripts/validate_deploy.py. |
| INF-11 | partial | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`scripts/validate_deploy.py` | TLS termination, HSTS and CSP configured at APISIX (validated); OCSP stapling is delegated to the cert-manager issuance chain and needs production evidence. |
| INF-12 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/apisix.yaml`<br>`deploy/k8s/edge.yaml`<br>`deploy/k8s/match.yaml`<br>`deploy/k8s/namespace.yaml` | K8s: only APISIX reaches edge, only edge reaches match, everything else ClusterIP/headless; default-deny-all NetworkPolicy; asserted by scripts/validate_deploy.py. |
| INF-13 | external-evidence | — | Edge DDoS mitigation + pre-launch test. |
| INF-14 | implemented | `deploy/k8s/README.md`<br>`deploy/k8s/namespace.yaml`<br>`deploy/k8s/networkpolicy.yaml`<br>`scripts/validate_deploy.py` | Default-deny egress + per-workload egress allowlists (DNS only otherwise) in deploy/k8s/networkpolicy.yaml; asserted by scripts/validate_deploy.py. |
| INF-15 | gap-p0 | — | Merge -> signed reproducible artefact -> auto-deploy to integration — CI pipeline. |
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
| TECH-04 | partial | `deploy/k8s/postgres.yaml` | Postgres 17 + PostGIS deployed; h3-pg extension not yet added. |
| TECH-05 | implemented | `deploy/k8s/valkey.yaml` | Valkey 8 (BSD-3); no Redis anywhere. |
| TECH-06 | partial | `deploy/k8s/centrifugo.yaml` | Centrifugo deployed; Valkey-as-broker not yet configured (in-memory engine in dev compose). |
| TECH-07 | partial | `deploy/docker-compose.yml`<br>`deploy/k8s/README.md`<br>`deploy/k8s/keycloak.yaml`<br>`deploy/keycloak/README.md`<br>`services/edge/src/app.ts` | Three realm imports (consumer passkey policy / workforce hardware 2FA / partners roles) boot in compose; edge verifies RS256 via realm JWKS; passkey-only browser flow + SMS recovery config pending. |
| TECH-08 | client | `services/edge/src/screening.ts` | OpenMLS/vodozemac client crypto; libsignal prohibited (AGPL-3.0 vs closed client). |
| TECH-09 | gap-p0 | — | pgvector for free-text linking only (FR-09), never in the match path — extension + service pending. |
| TECH-10 | superseded | — | ClickHouse superseded by OpenSearch (ADR-0006 / TECH-21); aggregated events only. |
| TECH-11 | partial | — | Fastify structured logs; OpenTelemetry traces + Grafana stack not wired (AGPL internal-only constraint noted). |
| TECH-12 | partial | — | Health endpoints + structured logs done; OpenTelemetry traces missing. |
| TECH-13 | implemented | — | Golden-file suite (120 pairs) fails on any score change; 81-test Python regression suite. |
| TECH-14 | implemented | `docs/api/openapi.yaml`<br>`tests/test_openapi_contract.py` | tests/test_openapi_contract.py generates assertions from openapi.yaml: strict-body structural + behavioural checks, doc<->route coverage both ways, TR-24 header docs, schema well-formedness. |
| TECH-15 | partial | — | Python engine is pure/deterministic; TS services read the wall clock directly — clock/id injection not formalised. |
| TECH-16 | client | — | Dependency maintenance/licence/size budget; 45 MB bundle cap. |
| TECH-17 | organisational | — | Team skills: TypeScript, React Native, Postgres, one systems language. |
| TECH-18 | gap-p0 | `deploy/k8s/match.yaml` | ARC language allocation: Rust match core + Go presence/venue/consent services outstanding; TS services are the documented P0 stand-in. |
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
| ACC-10 | partial | `presence/eval_harness.py`<br>`presence/eval_score.py`<br>`scripts/export_golden.py`<br>`services/match/src/engine.ts`<br>`services/match/test/engine.test.ts` | Eval pipeline complete (653-pair key, rating pack, scoring; self-test alpha 0.832, p@3 0.389); the real >=3-independent-rater study is outstanding. |
